import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { ClientSession, Connection, HydratedDocument, Model } from 'mongoose';
import Stripe from 'stripe';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Role } from '../enums/roles.enum';
import { CompanyFile } from '../files/entities/company-file.entity';
import {
  EmployeeInvitation,
  InvitationStatus,
} from '../invitations/entities/employee-invitation.entity';
import { PlanCode } from '../plans/plan.constants';
import { PlansService } from '../plans/plans.service';
import { billingPeriod } from '../subscriptions/billing-period';
import { SubscriptionPeriod } from '../subscriptions/entities/subscription-period.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { isDuplicateKeyError } from '../users/database-errors';
import { User } from '../users/entities/user.entity';
import { StripeEvent } from './entities/stripe-event.entity';
import { StripeUsage } from './entities/stripe-usage.entity';
import {
  meterWindow,
  isTerminalStripeStatus,
  STRIPE_SUBSCRIPTION_STATUSES,
  PaymentAccess,
  PaymentSyncIssue,
  STRIPE_EVENTS,
  STRIPE_LEASE_MS,
  STRIPE_RETRY_WINDOW_MS,
  UsageDeliveryState,
} from './payment.constants';
import { StripeClientService } from './stripe-client.service';
import {
  CheckoutMappingPendingException,
  CompanyLeaseBusyException,
  PaymentSyncValidationException,
  classifyPaymentSyncFailure,
  safePaymentSyncIdentifiers,
} from './payment-sync-failure';

type TenantSubscription = HydratedDocument<Subscription>;
const remoteId = (value: string | { id: string } | null | undefined) =>
  typeof value === 'string' ? value : value?.id;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly stripe: StripeClientService,
    private readonly config: ConfigService,
    private readonly plans: PlansService,
    @InjectModel('subscription')
    private readonly subscriptions: Model<Subscription>,
    @InjectModel('subscriptionPeriod')
    private readonly periods: Model<SubscriptionPeriod>,
    @InjectModel('user') private readonly users: Model<User>,
    @InjectModel('employeeInvitation')
    private readonly invitations: Model<EmployeeInvitation>,
    @InjectModel('stripeEvent') private readonly events: Model<StripeEvent>,
    @InjectModel('stripeUsage') private readonly usages: Model<StripeUsage>,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('companyFile') private readonly files: Model<CompanyFile>,
  ) {}

  private transaction<T>(work: (session: ClientSession) => Promise<T>) {
    return this.connection.transaction(work, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  }

  get enabled() {
    return this.stripe.enabled;
  }

  private owner(actor: AuthenticatedUser) {
    if (actor.role !== Role.COMPANY_OWNER)
      throw new ForbiddenException('Company owner access is required');
    if (!this.enabled)
      throw new ServiceUnavailableException(
        'Test Mode payments are not configured',
      );
  }

  private async withLease<T>(
    companyId: string,
    work: (subscription: TenantSubscription, token: string) => Promise<T>,
  ): Promise<T> {
    const token = randomUUID();
    const now = new Date();
    const subscription = await this.subscriptions.findOneAndUpdate(
      {
        companyId,
        $or: [
          { stripeLeaseUntil: { $lte: now } },
          { stripeLeaseUntil: { $exists: false } },
        ],
      },
      {
        $set: {
          stripeLeaseToken: token,
          stripeLeaseUntil: new Date(now.getTime() + STRIPE_LEASE_MS),
        },
      },
      { new: true },
    );
    if (!subscription) {
      if (!(await this.subscriptions.exists({ companyId })))
        throw new NotFoundException('Company subscription not found');
      throw new CompanyLeaseBusyException(
        'Billing synchronization is in progress; retry shortly',
      );
    }
    try {
      return await work(subscription, token);
    } finally {
      await this.subscriptions.updateOne(
        { _id: subscription._id, stripeLeaseToken: token },
        { $unset: { stripeLeaseToken: 1, stripeLeaseUntil: 1 } },
      );
    }
  }

  private async update(
    subscription: TenantSubscription,
    token: string,
    fields: Partial<Subscription>,
    session?: ClientSession,
    unset: string[] = [],
  ) {
    const result = await this.subscriptions.findOneAndUpdate(
      { _id: subscription._id, stripeLeaseToken: token },
      {
        $set: fields,
        $inc: { revision: 1 },
        ...(unset.length
          ? { $unset: Object.fromEntries(unset.map((key) => [key, 1])) }
          : {}),
      },
      { new: true, session, runValidators: true },
    );
    if (!result)
      throw new CompanyLeaseBusyException(
        'Billing synchronization lease expired; retry',
      );
    Object.assign(subscription, fields);
    for (const key of unset) subscription.set(key, undefined);
    return result;
  }

  async assertPlanFits(
    subscription: Subscription,
    code: PlanCode,
    session?: ClientSession,
    at = new Date(),
  ) {
    const plan = this.plans.findOne(code);
    const options = session ? { session } : undefined;
    const employees = await this.users.countDocuments(
      { companyId: subscription.companyId, role: Role.COMPANY_MEMBER },
      options,
    );
    const pending = await this.invitations.countDocuments(
      {
        companyId: subscription.companyId,
        status: InvitationStatus.PENDING,
        expiresAt: { $gt: at },
      },
      options,
    );
    if (plan.maxEmployees !== null && employees + pending > plan.maxEmployees)
      throw new ConflictException({
        code: 'plan_employee_limit',
        message:
          'Accepted employees and pending invitations exceed the target plan limit',
        planCode: code,
        limit: plan.maxEmployees,
        employees,
        pendingInvitations: pending,
      });
    const fileCount = await this.files.countDocuments(
      { companyId: subscription.companyId },
      options,
    );
    if (
      plan.extraFilePriceCents === null &&
      fileCount > plan.includedFilesPerMonth
    )
      throw new ConflictException({
        code: 'plan_file_limit',
        message: 'Stored files exceed the target plan limit',
        planCode: code,
        limit: plan.includedFilesPerMonth,
        storedFiles: fileCount,
      });
    return employees;
  }

  private price(code: PlanCode) {
    return this.config.getOrThrow<string>(
      code === PlanCode.BASIC
        ? 'STRIPE_BASIC_PRICE_ID'
        : 'STRIPE_PREMIUM_PRICE_ID',
    );
  }

  // Stripe retains idempotency keys for at least 24 hours. Never blindly repeat
  // an ambiguous create outside that window: it could create a second resource.
  private async attempt(
    subscription: TenantSubscription,
    token: string,
    field:
      | 'stripeCustomerAttemptAt'
      | 'stripeCheckoutAttemptAt'
      | 'stripeSubscriptionAttemptAt'
      | 'stripePlanAttemptAt',
  ) {
    const first = subscription[field];
    if (first && Date.now() - first.getTime() > STRIPE_RETRY_WINDOW_MS) {
      await this.update(subscription, token, {
        paymentSyncIssue: PaymentSyncIssue.RECONCILIATION_REQUIRED,
      });
      throw new ConflictException(
        'Ambiguous Stripe operation requires reconciliation before retry',
      );
    }
    if (!first) await this.update(subscription, token, { [field]: new Date() });
  }

  private async validateCatalog() {
    const api = this.stripe.api;
    const [basic, premium, overage, meter] = await Promise.all([
      api.prices.retrieve(this.price(PlanCode.BASIC)),
      api.prices.retrieve(this.price(PlanCode.PREMIUM)),
      api.prices.retrieve(
        this.config.getOrThrow<string>('STRIPE_OVERAGE_PRICE_ID'),
      ),
      api.billing.meters.retrieve(
        this.config.getOrThrow<string>('STRIPE_OVERAGE_METER_ID'),
      ),
    ]);
    const compatible = (
      p: Stripe.Price,
      cents: number,
      usage: 'licensed' | 'metered',
    ) =>
      !p.livemode &&
      p.active &&
      p.currency === 'usd' &&
      p.unit_amount === cents &&
      p.billing_scheme === 'per_unit' &&
      !p.transform_quantity &&
      p.recurring?.interval === 'month' &&
      p.recurring.interval_count === 1 &&
      p.recurring.usage_type === usage;
    if (
      !compatible(
        basic,
        this.plans.findOne(PlanCode.BASIC).employeePriceCents,
        'licensed',
      ) ||
      !compatible(
        premium,
        this.plans.findOne(PlanCode.PREMIUM).basePriceCents,
        'licensed',
      ) ||
      !compatible(
        overage,
        this.plans.findOne(PlanCode.PREMIUM).extraFilePriceCents!,
        'metered',
      ) ||
      overage.recurring?.meter !== meter.id ||
      meter.livemode ||
      meter.status !== 'active' ||
      meter.event_name !==
        this.config.getOrThrow<string>('STRIPE_OVERAGE_EVENT_NAME') ||
      meter.default_aggregation.formula !== 'sum' ||
      meter.customer_mapping.event_payload_key !== 'stripe_customer_id' ||
      meter.value_settings.event_payload_key !== 'value'
    ) {
      throw new PaymentSyncValidationException(
        'Stripe Test Mode catalog does not match DataVault plans',
      );
    }
  }

  private async customer(subscription: TenantSubscription, token: string) {
    if (subscription.stripeCustomerId) return subscription.stripeCustomerId;
    const owner = await this.users
      .findOne({ companyId: subscription.companyId, role: Role.COMPANY_OWNER })
      .select('email');
    if (!owner) throw new NotFoundException('Company owner not found');
    await this.attempt(subscription, token, 'stripeCustomerAttemptAt');
    const customer = await this.stripe.api.customers.create(
      {
        email: owner.email,
        metadata: { companyId: subscription.companyId.toString() },
      },
      {
        idempotencyKey: `datavault-customer-${subscription.companyId.toString()}`,
      },
    );
    if (customer.livemode)
      throw new PaymentSyncValidationException(
        'Only Stripe Test Mode is supported',
      );
    await this.update(subscription, token, { stripeCustomerId: customer.id });
    return customer.id;
  }

  async checkout(actor: AuthenticatedUser, planCode: PlanCode) {
    this.owner(actor);
    if (planCode === PlanCode.FREE)
      throw new BadRequestException('Free does not require Checkout');
    return this.safeApi(() =>
      this.withLease(actor.companyId, async (subscription, token) => {
        await this.validateCatalog();
        if (
          subscription.stripeSubscriptionId &&
          !isTerminalStripeStatus(subscription.stripeStatus)
        )
          throw new ConflictException(
            'Use the plan-change endpoint for an existing Stripe subscription',
          );
        if (subscription.stripeSubscriptionId) {
          const previous = await this.stripe.api.subscriptions.retrieve(
            subscription.stripeSubscriptionId,
          );
          this.validateRemote(subscription, previous);
          if (!isTerminalStripeStatus(previous.status))
            throw new ConflictException(
              'Existing Stripe subscription is not canceled',
            );
          await this.update(
            subscription,
            token,
            {
              paymentAccess:
                subscription.planCode === PlanCode.FREE
                  ? subscription.paymentAccess
                  : PaymentAccess.SUSPENDED,
            },
            undefined,
            [
              'stripeSubscriptionId',
              'stripeSubscriptionAttemptAt',
              'stripeCheckoutSessionId',
              'stripeCheckoutOperation',
              'pendingPlanCode',
              'pendingPlanAt',
              'stripeChangeOperation',
              'stripePlanAttemptAt',
              'stripePlanConfirmed',
              'stripePlanEmployees',
              'stripeScheduleId',
              'stripeCheckoutEmployees',
              'stripeCheckoutAttemptAt',
            ],
          );
        }
        await this.assertPlanFits(subscription, planCode);
        const customer = await this.customer(subscription, token);
        if (subscription.stripeCheckoutSessionId) {
          const existing = await this.stripe.api.checkout.sessions.retrieve(
            subscription.stripeCheckoutSessionId,
          );
          if (existing.status === 'open') {
            if (subscription.stripeCheckoutPlan !== planCode)
              throw new ConflictException(
                'An existing Checkout session must finish or expire first',
              );
            return {
              url: existing.url,
              mode: 'setup',
              paymentCollected: false,
            };
          }
          if (
            existing.status === 'complete' &&
            !subscription.stripeSubscriptionId
          )
            throw new ConflictException(
              'Checkout completion is being synchronized',
            );
        }
        if (
          !subscription.stripeCheckoutOperation ||
          subscription.stripeCheckoutPlan !== planCode ||
          subscription.stripeCheckoutSessionId
        ) {
          await this.update(
            subscription,
            token,
            {
              stripeCheckoutOperation: randomUUID(),
              stripeCheckoutPlan: planCode,
            },
            undefined,
            [
              'stripeCheckoutSessionId',
              'stripeCheckoutAttemptAt',
              'stripeSubscriptionAttemptAt',
              'stripeCheckoutEmployees',
            ],
          );
        }
        await this.attempt(subscription, token, 'stripeCheckoutAttemptAt');
        const checkout = await this.stripe.api.checkout.sessions.create(
          {
            mode: 'setup',
            payment_method_types: ['card'],
            currency: 'usd',
            customer,
            success_url: this.config.getOrThrow<string>(
              'STRIPE_CHECKOUT_SUCCESS_URL',
            ),
            cancel_url: this.config.getOrThrow<string>(
              'STRIPE_CHECKOUT_CANCEL_URL',
            ),
            metadata: {
              companyId: actor.companyId,
              operation: subscription.stripeCheckoutOperation!,
              planCode,
            },
            setup_intent_data: { metadata: { companyId: actor.companyId } },
          },
          {
            idempotencyKey: `datavault-checkout-${subscription.stripeCheckoutOperation!}`,
          },
        );
        await this.update(subscription, token, {
          stripeCheckoutSessionId: checkout.id,
        });
        return { url: checkout.url, mode: 'setup', paymentCollected: false };
      }),
    );
  }

  async portal(actor: AuthenticatedUser) {
    this.owner(actor);
    return this.safeApi(() =>
      this.withLease(actor.companyId, async (subscription, token) => {
        const configuration =
          await this.stripe.api.billingPortal.configurations.retrieve(
            this.config.getOrThrow<string>('STRIPE_PORTAL_CONFIGURATION_ID'),
          );
        if (
          configuration.livemode ||
          !configuration.active ||
          !configuration.features.payment_method_update.enabled ||
          !configuration.features.invoice_history.enabled ||
          configuration.features.subscription_update.enabled ||
          configuration.features.subscription_cancel.enabled
        )
          throw new ServiceUnavailableException(
            'Portal must enable payment methods and invoices, and disable plan changes and cancellation',
          );
        const customer = await this.customer(subscription, token);
        const session = await this.stripe.api.billingPortal.sessions.create({
          customer,
          configuration: configuration.id,
          return_url: this.config.getOrThrow<string>(
            'STRIPE_PORTAL_RETURN_URL',
          ),
        });
        return { url: session.url };
      }),
    );
  }

  async current(actor: AuthenticatedUser) {
    this.owner(actor);
    return this.safeApi(async () => {
      const subscription = await this.subscriptions.findOne({
        companyId: actor.companyId,
      });
      if (!subscription)
        throw new NotFoundException('Company subscription not found');
      const invoices = subscription.stripeCustomerId
        ? await this.stripe.api.invoices.list({
            customer: subscription.stripeCustomerId,
            limit: 10,
          })
        : { data: [] };
      const pendingUsage = await this.usages.countDocuments({
        companyId: actor.companyId,
        state: { $ne: UsageDeliveryState.SUBMITTED },
      });
      return {
        mode: 'test',
        planCode: subscription.planCode,
        paymentAccess: subscription.paymentAccess ?? PaymentAccess.UNMANAGED,
        stripeStatus: subscription.stripeStatus ?? null,
        cancelAtPeriodEnd: subscription.stripeCancelAtPeriodEnd ?? false,
        pendingPlanCode: subscription.pendingPlanCode ?? null,
        pendingPlanAt: subscription.pendingPlanAt ?? null,
        billingPeriod: billingPeriod(subscription.activatedAt, new Date()),
        synchronization: {
          issue: subscription.paymentSyncIssue ?? PaymentSyncIssue.NONE,
          lastSyncedAt: subscription.stripeSyncedAt ?? null,
          pendingUsage,
        },
        invoices: invoices.data.map((invoice) => ({
          id: invoice.id,
          status: invoice.status,
          currency: invoice.currency,
          amountDueCents: invoice.amount_due,
          amountPaidCents: invoice.amount_paid,
          totalCents: invoice.total,
          hostedInvoiceUrl: invoice.hosted_invoice_url,
          createdAt: new Date(invoice.created * 1000),
        })),
      };
    });
  }

  async changePlan(actor: AuthenticatedUser, code: PlanCode) {
    this.owner(actor);
    return this.safeApi(() =>
      this.withLease(actor.companyId, async (subscription, token) => {
        if (!subscription.stripeSubscriptionId) {
          if (code !== PlanCode.FREE)
            throw new ConflictException(
              'Start hosted Checkout before choosing a paid plan',
            );
          await this.transaction(async (session) => {
            await this.lockLocal(subscription, session);
            await this.assertPlanFits(subscription, code, session);
            await this.update(
              subscription,
              token,
              { planCode: code, paymentAccess: PaymentAccess.UNMANAGED },
              session,
            );
          });
          return { planCode: code, pendingPlanCode: null };
        }
        await this.transaction(async (session) => {
          await this.lockLocal(subscription, session);
          await this.assertPlanFits(subscription, code, session);
          if (
            subscription.pendingPlanCode &&
            subscription.pendingPlanCode !== code &&
            code !== subscription.planCode &&
            code !== PlanCode.FREE
          )
            throw new ConflictException(
              'Resolve the queued plan change before requesting another target',
            );
          if (
            subscription.pendingPlanCode !== code ||
            (code === PlanCode.FREE && subscription.stripePlanConfirmed)
          )
            await this.update(
              subscription,
              token,
              {
                pendingPlanCode: code,
                pendingPlanAt:
                  code === PlanCode.FREE
                    ? new Date()
                    : billingPeriod(subscription.activatedAt, new Date())
                        .endsAt,
                stripeChangeOperation: randomUUID(),
                stripePlanConfirmed: false,
              },
              session,
              ['stripePlanAttemptAt', 'stripePlanEmployees'],
            );
        });
        await this.performPlanRequest(subscription, token);
        await this.synchronize(subscription, token);
        return {
          planCode: subscription.planCode,
          pendingPlanCode: subscription.pendingPlanCode ?? null,
          effectiveAt: subscription.pendingPlanAt ?? null,
          prorationBehavior: 'none',
        };
      }),
    );
  }

  private async lockLocal(
    subscription: TenantSubscription,
    session: ClientSession,
  ) {
    const locked = await this.subscriptions.findOneAndUpdate(
      { _id: subscription._id },
      { $inc: { revision: 1 } },
      { new: true, session },
    );
    if (!locked) throw new NotFoundException('Company subscription not found');
  }

  private async employeeSnapshot(subscription: TenantSubscription) {
    return this.transaction(async (session) => {
      await this.lockLocal(subscription, session);
      return this.users.countDocuments(
        { companyId: subscription.companyId, role: Role.COMPANY_MEMBER },
        { session },
      );
    });
  }

  private items(
    code: PlanCode,
    employees: number,
  ): Stripe.SubscriptionCreateParams.Item[] {
    if (code === PlanCode.BASIC)
      return [{ price: this.price(code), quantity: employees }];
    return [
      { price: this.price(code), quantity: 1 },
      { price: this.config.getOrThrow<string>('STRIPE_OVERAGE_PRICE_ID') },
    ];
  }

  private async performPlanRequest(
    subscription: TenantSubscription,
    token: string,
  ) {
    const target = subscription.pendingPlanCode;
    if (!target || !subscription.stripeSubscriptionId) return;
    if (subscription.stripePlanConfirmed) return;
    const api = this.stripe.api;
    const remote = await api.subscriptions.retrieve(
      subscription.stripeSubscriptionId,
    );
    this.validateRemote(subscription, remote);
    if (isTerminalStripeStatus(remote.status)) return;
    const currentPlan = this.remotePlan(remote);
    const activeSchedule = remoteId(remote.schedule);
    if (activeSchedule && subscription.stripeScheduleId !== activeSchedule)
      await this.update(subscription, token, {
        stripeScheduleId: activeSchedule,
      });
    if (!activeSchedule && subscription.stripeScheduleId)
      await this.update(subscription, token, {}, undefined, [
        'stripeScheduleId',
      ]);
    const downgrade =
      currentPlan === PlanCode.PREMIUM && target === PlanCode.BASIC;
    if (
      downgrade &&
      subscription.pendingPlanAt &&
      subscription.pendingPlanAt.getTime() <= Date.now()
    ) {
      await this.update(subscription, token, {
        paymentSyncIssue: PaymentSyncIssue.RECONCILIATION_REQUIRED,
      });
      throw new ConflictException(
        'Queued plan change missed its anniversary; choose the current plan to reset the request before retrying',
      );
    }
    const key = `datavault-plan-${subscription.stripeChangeOperation!}`;
    await this.attempt(subscription, token, 'stripePlanAttemptAt');
    if (target === PlanCode.FREE) {
      if (subscription.stripeScheduleId)
        await api.subscriptionSchedules.release(
          subscription.stripeScheduleId,
          {},
          { idempotencyKey: `${key}-release` },
        );
      await api.subscriptions.cancel(
        remote.id,
        { invoice_now: false, prorate: false },
        { idempotencyKey: key },
      );
      await this.update(subscription, token, {}, undefined, [
        'stripeScheduleId',
      ]);
      await this.update(subscription, token, { stripePlanConfirmed: true });
      return;
    }
    await this.validateCatalog();
    if (subscription.stripePlanEmployees === undefined)
      await this.update(subscription, token, {
        stripePlanEmployees: await this.users.countDocuments({
          companyId: subscription.companyId,
          role: Role.COMPANY_MEMBER,
        }),
      });
    const employees = subscription.stripePlanEmployees!;
    if (
      subscription.stripeScheduleId &&
      (target !== PlanCode.BASIC || target === currentPlan)
    ) {
      await api.subscriptionSchedules.release(
        subscription.stripeScheduleId,
        {},
        { idempotencyKey: `${key}-release` },
      );
      await this.update(subscription, token, {}, undefined, [
        'stripeScheduleId',
      ]);
    }
    if (currentPlan === PlanCode.PREMIUM && target === PlanCode.BASIC) {
      const schedule = subscription.stripeScheduleId
        ? await api.subscriptionSchedules.retrieve(
            subscription.stripeScheduleId,
          )
        : await api.subscriptionSchedules.create(
            { from_subscription: remote.id },
            { idempotencyKey: `${key}-schedule` },
          );
      if (!subscription.stripeScheduleId)
        await this.update(subscription, token, {
          stripeScheduleId: schedule.id,
        });
      if (!schedule.current_phase)
        throw new ServiceUnavailableException(
          'Stripe schedule has no current phase',
        );
      await api.subscriptionSchedules.update(
        schedule.id,
        {
          end_behavior: 'release',
          proration_behavior: 'none',
          phases: [
            {
              start_date: schedule.current_phase.start_date,
              end_date: schedule.current_phase.end_date,
              items: this.items(currentPlan, employees),
              proration_behavior: 'none',
            },
            {
              start_date: schedule.current_phase.end_date,
              end_date: Math.floor(
                billingPeriod(
                  subscription.activatedAt,
                  new Date(schedule.current_phase.end_date * 1000 + 1000),
                ).endsAt.getTime() / 1000,
              ),
              items: this.items(target, employees),
              proration_behavior: 'none',
              billing_cycle_anchor: 'automatic',
            },
          ],
        },
        { idempotencyKey: `${key}-phases` },
      );
      await this.update(subscription, token, { stripePlanConfirmed: true });
      return;
    }
    if (currentPlan === target) {
      await api.subscriptions.update(
        remote.id,
        {
          cancel_at_period_end: false,
          billing_cycle_anchor: 'unchanged',
          proration_behavior: 'none',
        },
        { idempotencyKey: key },
      );
      await this.update(subscription, token, { stripePlanConfirmed: true });
      return;
    }
    const licensed = remote.items.data.find(
      (item) => item.price.id === this.price(currentPlan),
    )!;
    const items: Stripe.SubscriptionUpdateParams.Item[] = [
      {
        id: licensed.id,
        price: this.price(target),
        quantity: target === PlanCode.BASIC ? employees : 1,
      },
    ];
    if (target === PlanCode.PREMIUM)
      items.push({
        price: this.config.getOrThrow<string>('STRIPE_OVERAGE_PRICE_ID'),
      });
    await api.subscriptions.update(
      remote.id,
      {
        items,
        billing_cycle_anchor: 'unchanged',
        cancel_at_period_end: false,
        proration_behavior: 'none',
        payment_behavior: 'error_if_incomplete',
      },
      { idempotencyKey: key },
    );
    await this.update(subscription, token, { stripePlanConfirmed: true });
  }

  private validateRemote(
    subscription: Subscription,
    remote: Stripe.Subscription,
  ) {
    const status = STRIPE_SUBSCRIPTION_STATUSES.find(
      (status) => status === remote.status,
    );
    if (!status)
      throw new PaymentSyncValidationException(
        'Unsupported Stripe subscription status',
      );
    if (
      remote.livemode ||
      remoteId(remote.customer) !== subscription.stripeCustomerId ||
      remote.metadata.companyId !== subscription.companyId.toString()
    )
      throw new PaymentSyncValidationException(
        'Stripe tenant mapping is invalid',
      );
    const anchor = remote.billing_cycle_anchor_config;
    const activation = subscription.activatedAt;
    if (
      !anchor ||
      anchor.day_of_month !== activation.getUTCDate() ||
      anchor.hour !== activation.getUTCHours() ||
      anchor.minute !== activation.getUTCMinutes() ||
      anchor.second !== activation.getUTCSeconds()
    )
      throw new PaymentSyncValidationException(
        'Stripe billing anniversary does not match DataVault',
      );
    for (const item of remote.items.data) {
      if (
        !Number.isSafeInteger(item.current_period_start) ||
        !Number.isSafeInteger(item.current_period_end)
      )
        throw new PaymentSyncValidationException(
          'Stripe billing period is unavailable',
        );
      const expected = Math.floor(
        billingPeriod(
          activation,
          new Date(item.current_period_start * 1000 + 1000),
        ).endsAt.getTime() / 1000,
      );
      if (item.current_period_end !== expected)
        throw new PaymentSyncValidationException(
          'Stripe billing period does not match DataVault',
        );
    }
    return status;
  }

  private remotePlan(remote: Stripe.Subscription) {
    const ids = remote.items.data.map((item) => item.price.id);
    if (ids.length === 1 && ids[0] === this.price(PlanCode.BASIC))
      return PlanCode.BASIC;
    if (
      ids.length === 2 &&
      ids.includes(this.price(PlanCode.PREMIUM)) &&
      ids.includes(this.config.getOrThrow<string>('STRIPE_OVERAGE_PRICE_ID'))
    )
      return PlanCode.PREMIUM;
    throw new PaymentSyncValidationException(
      'Stripe subscription has unsupported prices',
    );
  }

  private async applyCanonical(
    subscription: TenantSubscription,
    token: string,
    remote: Stripe.Subscription,
    event?: Stripe.Event,
    draftsHeld = false,
  ) {
    const stripeStatus = this.validateRemote(subscription, remote);
    await this.transaction(async (session) => {
      await this.lockLocal(subscription, session);
      let planCode = this.remotePlan(remote);
      let access = PaymentAccess.SUSPENDED;
      let issue = (await this.usages
        .exists({
          companyId: subscription.companyId,
          state: UsageDeliveryState.RECONCILIATION_REQUIRED,
        })
        .session(session))
        ? PaymentSyncIssue.RECONCILIATION_REQUIRED
        : PaymentSyncIssue.NONE;
      if (draftsHeld) issue = PaymentSyncIssue.RECONCILIATION_REQUIRED;
      const latestInvoice =
        typeof remote.latest_invoice === 'object'
          ? remote.latest_invoice
          : null;
      if (
        remote.status === 'active' &&
        !remote.pause_collection &&
        remote.collection_method === 'charge_automatically'
      )
        access =
          latestInvoice?.status === 'paid'
            ? PaymentAccess.ACTIVE
            : !latestInvoice || latestInvoice.status === 'draft'
              ? PaymentAccess.DEFERRED
              : PaymentAccess.SUSPENDED;
      if (isTerminalStripeStatus(remote.status)) {
        try {
          await this.assertPlanFits(subscription, PlanCode.FREE, session);
          planCode = PlanCode.FREE;
          access = PaymentAccess.ACTIVE;
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
          planCode = subscription.planCode;
          issue = PaymentSyncIssue.PLAN_CONFLICT;
        }
      } else if (access !== PaymentAccess.SUSPENDED) {
        try {
          await this.assertPlanFits(subscription, planCode, session);
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
          access = PaymentAccess.SUSPENDED;
          planCode = subscription.planCode;
          issue = PaymentSyncIssue.PLAN_CONFLICT;
        }
      }
      if (access === PaymentAccess.SUSPENDED) planCode = subscription.planCode;
      const changed = planCode !== subscription.planCode;
      const clearPending = planCode === subscription.pendingPlanCode;
      await this.update(
        subscription,
        token,
        {
          stripeManaged: true,
          stripeStatus,
          stripeCancelAtPeriodEnd: remote.cancel_at_period_end,
          paymentAccess: access,
          paymentSyncIssue: issue,
          stripeSyncedAt: new Date(),
          planCode,
          ...(planCode === PlanCode.PREMIUM &&
          (!subscription.stripeMeterStartedAt || changed)
            ? {
                stripeMeterStartedAt: new Date(
                  (remote.items.data.find(
                    (item) =>
                      item.price.id ===
                      this.config.getOrThrow<string>('STRIPE_OVERAGE_PRICE_ID'),
                  )?.current_period_start ?? Math.floor(Date.now() / 1000)) *
                    1000,
                ),
              }
            : {}),
          ...(changed ? { planChangedAt: new Date() } : {}),
        },
        session,
        clearPending
          ? [
              'pendingPlanCode',
              'pendingPlanAt',
              'stripeChangeOperation',
              'stripePlanAttemptAt',
              'stripePlanConfirmed',
              'stripePlanEmployees',
            ]
          : [],
      );
      if (event)
        await this.events.create(
          [
            {
              eventId: event.id,
              type: event.type,
              companyId: subscription.companyId,
              processedAt: new Date(),
            },
          ],
          { session },
        );
    });
  }

  async enqueueOverage(
    subscription: Subscription,
    period: { startsAt: Date; endsAt: Date },
    sequence: number,
    additionalChargeCents: number,
    now: Date,
    session: ClientSession,
  ) {
    if (
      !this.enabled ||
      !subscription.stripeManaged ||
      additionalChargeCents === 0
    )
      return;
    if (!subscription.stripeCustomerId || !subscription.stripeSubscriptionId)
      throw new ServiceUnavailableException(
        'Stripe usage mapping is unavailable',
      );
    if (
      !Number.isSafeInteger(additionalChargeCents) ||
      additionalChargeCents < 0 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    )
      throw new ServiceUnavailableException('Invalid metered usage accounting');
    const unit = this.plans.findOne(PlanCode.PREMIUM).extraFilePriceCents!;
    const quantity = Number(BigInt(additionalChargeCents) / BigInt(unit));
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      BigInt(quantity) * BigInt(unit) !== BigInt(additionalChargeCents)
    )
      throw new ServiceUnavailableException('Invalid metered usage accounting');
    const window = meterWindow(period.startsAt, period.endsAt);
    const timestamp = Math.max(
      window.start,
      Math.ceil(
        (subscription.stripeMeterStartedAt?.getTime() ??
          period.startsAt.getTime()) / 60000,
      ) * 60,
      Math.min(Math.floor(now.getTime() / 60000) * 60, window.end - 60),
    );
    if (timestamp >= window.end)
      throw new ConflictException(
        'Upload crossed a subscription billing boundary; retry',
      );
    await this.usages.create(
      [
        {
          identifier: `dv-${subscription.companyId.toString()}-${period.startsAt.getTime()}-${sequence}`,
          companyId: subscription.companyId,
          customerId: subscription.stripeCustomerId,
          subscriptionId: subscription.stripeSubscriptionId,
          quantity,
          timestamp,
          periodStartsAt: period.startsAt,
          periodEndsAt: period.endsAt,
        },
      ],
      { session },
    );
  }

  private async submitUsage(subscription: TenantSubscription, token: string) {
    const pending = await this.usages
      .find({
        companyId: subscription.companyId,
        state: UsageDeliveryState.PENDING,
      })
      .sort({ timestamp: 1 })
      .limit(5);
    for (const usage of pending) {
      if (
        (usage.firstAttemptAt &&
          new Date().getTime() - usage.firstAttemptAt.getTime() >
            STRIPE_RETRY_WINDOW_MS) ||
        Date.now() / 1000 - usage.timestamp > 35 * 86400
      ) {
        await this.usages.updateOne(
          { _id: usage._id },
          { $set: { state: UsageDeliveryState.RECONCILIATION_REQUIRED } },
        );
        await this.update(subscription, token, {
          paymentSyncIssue: PaymentSyncIssue.RECONCILIATION_REQUIRED,
        });
        continue;
      }
      if (!usage.firstAttemptAt)
        await this.usages.updateOne(
          { _id: usage._id },
          { $set: { firstAttemptAt: new Date() } },
        );
      const lease = await this.subscriptions.updateOne(
        { _id: subscription._id, stripeLeaseToken: token },
        { $set: { stripeLeaseUntil: new Date(Date.now() + STRIPE_LEASE_MS) } },
      );
      if (!lease.matchedCount)
        throw new CompanyLeaseBusyException('Billing lease expired; retry');
      const delivered = await this.stripe.api.billing.meterEvents.create(
        {
          event_name: this.config.getOrThrow<string>(
            'STRIPE_OVERAGE_EVENT_NAME',
          ),
          identifier: usage.identifier,
          payload: {
            stripe_customer_id: usage.customerId,
            value: String(usage.quantity),
          },
          timestamp: usage.timestamp,
        },
        { idempotencyKey: usage.identifier },
      );
      if (delivered.livemode || delivered.identifier !== usage.identifier)
        throw new PaymentSyncValidationException(
          'Meter event confirmation is invalid',
        );
      await this.usages.updateOne(
        { _id: usage._id },
        {
          $set: {
            state: UsageDeliveryState.SUBMITTED,
            submittedAt: new Date(),
          },
        },
      );
    }
  }

  private async renewLease(subscription: TenantSubscription, token: string) {
    const lease = await this.subscriptions.updateOne(
      { _id: subscription._id, stripeLeaseToken: token },
      { $set: { stripeLeaseUntil: new Date(Date.now() + STRIPE_LEASE_MS) } },
    );
    if (!lease.matchedCount)
      throw new CompanyLeaseBusyException('Billing lease expired; retry');
  }

  private async reconcileDraft(
    subscription: TenantSubscription,
    invoice: Stripe.Invoice,
  ) {
    if (
      invoice.status !== 'draft' ||
      invoice.livemode ||
      remoteId(invoice.customer) !== subscription.stripeCustomerId ||
      remoteId(invoice.parent?.subscription_details?.subscription) !==
        subscription.stripeSubscriptionId
    )
      return true;
    const api = this.stripe.api;
    // Hold finalization until authoritative quantity/usage reconciliation succeeds.
    if (invoice.auto_advance)
      await api.invoices.update(invoice.id, { auto_advance: false });
    let employees = invoice.metadata?.datavault_employee_count;
    if (employees === undefined) {
      employees = String(await this.employeeSnapshot(subscription));
      await api.invoices.update(
        invoice.id,
        { metadata: { datavault_employee_count: employees } },
        { idempotencyKey: `dv-invoice-seats-${invoice.id}` },
      );
    }
    if (!/^\d+$/.test(employees) || !Number.isSafeInteger(Number(employees)))
      throw new PaymentSyncValidationException(
        'Invoice seat snapshot is invalid',
      );
    const lines = await api.invoices.listLineItems(invoice.id, { limit: 100 });
    if (lines.has_more)
      throw new ServiceUnavailableException(
        'Invoice reconciliation requires manual review',
      );
    for (const line of lines.data) {
      const price = remoteId(line.pricing?.price_details?.price);
      if (
        price === this.price(PlanCode.BASIC) &&
        line.quantity !== Number(employees)
      )
        await api.invoices.updateLineItem(
          invoice.id,
          line.id,
          { quantity: Number(employees) },
          { idempotencyKey: `dv-invoice-quantity-${invoice.id}` },
        );
      if (price === this.config.getOrThrow<string>('STRIPE_OVERAGE_PRICE_ID')) {
        const start = Math.ceil(line.period.start / 60) * 60;
        const end = Math.ceil(line.period.end / 60) * 60;
        const local = await this.usages.find({
          companyId: subscription.companyId,
          timestamp: { $gte: start, $lt: end },
        });
        if (local.some((item) => item.state !== UsageDeliveryState.SUBMITTED))
          return false;
        const expected = local.reduce((sum, item) => sum + item.quantity, 0);
        const summaries = await api.billing.meters.listEventSummaries(
          this.config.getOrThrow<string>('STRIPE_OVERAGE_METER_ID'),
          {
            customer: subscription.stripeCustomerId!,
            start_time: start,
            end_time: end,
          },
        );
        const aggregated = summaries.data.reduce(
          (sum, item) => sum + item.aggregated_value,
          0,
        );
        if (!Number.isSafeInteger(aggregated) || aggregated !== expected)
          return false;
        if (line.quantity !== expected)
          await api.invoices.updateLineItem(
            invoice.id,
            line.id,
            { quantity: expected },
            { idempotencyKey: `dv-invoice-overage-${invoice.id}-${expected}` },
          );
      }
    }
    await api.invoices.update(invoice.id, {
      auto_advance: true,
      metadata: { datavault_reconciled: 'true' },
    });
    return true;
  }

  private async synchronize(
    subscription: TenantSubscription,
    token: string,
    event?: Stripe.Event,
  ) {
    if (!subscription.stripeSubscriptionId) return;
    const api = this.stripe.api;
    await this.submitUsage(subscription, token);
    let remote = await api.subscriptions.retrieve(
      subscription.stripeSubscriptionId,
      { expand: ['latest_invoice'] },
    );
    this.validateRemote(subscription, remote);
    if (subscription.stripeScheduleId && !remoteId(remote.schedule))
      await this.update(subscription, token, {}, undefined, [
        'stripeScheduleId',
      ]);
    if (
      remote.status === 'active' &&
      this.remotePlan(remote) === PlanCode.BASIC
    ) {
      const item = remote.items.data[0];
      const quantity = await this.employeeSnapshot(subscription);
      if (item.quantity !== quantity) {
        await api.subscriptions.update(
          remote.id,
          {
            items: [{ id: item.id, quantity }],
            ...(remote.schedule
              ? {}
              : { billing_cycle_anchor: 'unchanged' as const }),
            proration_behavior: 'none',
            payment_behavior: 'error_if_incomplete',
          },
          {
            idempotencyKey: `dv-seats-${remote.id}-${subscription.revision}-${quantity}`,
          },
        );
        remote = await api.subscriptions.retrieve(remote.id, {
          expand: ['latest_invoice'],
        });
      }
    }
    const drafts = await api.invoices.list({
      customer: subscription.stripeCustomerId,
      status: 'draft',
      limit: 10,
    });
    let draftsHeld = false;
    for (const invoice of drafts.data) {
      await this.renewLease(subscription, token);
      if (!(await this.reconcileDraft(subscription, invoice)))
        draftsHeld = true;
    }
    if (drafts.has_more) draftsHeld = true;
    await this.renewLease(subscription, token);
    const latest =
      typeof remote.latest_invoice === 'object' ? remote.latest_invoice : null;
    if (
      latest?.id &&
      latest.status !== 'draft' &&
      !(await this.verifyFinalizedUsage(subscription, latest))
    )
      draftsHeld = true;
    await this.applyCanonical(subscription, token, remote, event, draftsHeld);
  }

  // Finalized invoices cannot be repaired automatically. Detect discrepancies
  // and surface them instead of treating a provider amount as local usage.
  private async verifyFinalizedUsage(
    subscription: Subscription,
    invoice: Stripe.Invoice,
  ) {
    if (
      remoteId(invoice.parent?.subscription_details?.subscription) !==
        subscription.stripeSubscriptionId ||
      invoice.status === 'void'
    )
      return true;
    const lines = await this.stripe.api.invoices.listLineItems(invoice.id, {
      limit: 100,
    });
    if (lines.has_more) return false;
    for (const line of lines.data) {
      if (
        remoteId(line.pricing?.price_details?.price) !==
        this.config.getOrThrow<string>('STRIPE_OVERAGE_PRICE_ID')
      )
        continue;
      const start = Math.ceil(line.period.start / 60) * 60;
      const end = Math.ceil(line.period.end / 60) * 60;
      const usage = await this.usages.find({
        companyId: subscription.companyId,
        timestamp: { $gte: start, $lt: end },
      });
      if (
        usage.some((row) => row.state !== UsageDeliveryState.SUBMITTED) ||
        line.quantity !== usage.reduce((sum, row) => sum + row.quantity, 0)
      )
        return false;
    }
    return true;
  }

  async reconcile(actor: AuthenticatedUser) {
    this.owner(actor);
    await this.reconcileCompany(actor.companyId);
    return this.current(actor);
  }

  async reconcileCompany(companyId: string) {
    if (!this.enabled) return;
    return this.safeApi(() =>
      this.withLease(companyId, async (subscription, token) => {
        if (
          subscription.stripeCheckoutSessionId &&
          !subscription.stripeSubscriptionId
        ) {
          const checkout = await this.stripe.api.checkout.sessions.retrieve(
            subscription.stripeCheckoutSessionId,
          );
          if (checkout.status === 'complete')
            await this.completeCheckout(subscription, token, checkout);
        }
        if (subscription.pendingPlanCode)
          await this.performPlanRequest(subscription, token);
        await this.synchronize(subscription, token);
      }),
    );
  }

  private async completeCheckout(
    subscription: TenantSubscription,
    token: string,
    checkout: Stripe.Checkout.Session,
  ) {
    if (
      checkout.livemode ||
      checkout.status !== 'complete' ||
      checkout.mode !== 'setup' ||
      remoteId(checkout.customer) !== subscription.stripeCustomerId ||
      checkout.id !== subscription.stripeCheckoutSessionId ||
      checkout.metadata?.operation !== subscription.stripeCheckoutOperation ||
      !subscription.stripeCheckoutPlan
    )
      throw new BadRequestException('Checkout mapping is invalid');
    const setupId = remoteId(checkout.setup_intent);
    if (!setupId) throw new BadRequestException('Checkout setup is incomplete');
    const setup = await this.stripe.api.setupIntents.retrieve(setupId);
    if (
      setup.livemode ||
      setup.status !== 'succeeded' ||
      remoteId(setup.customer) !== subscription.stripeCustomerId ||
      !remoteId(setup.payment_method)
    )
      throw new BadRequestException('Payment method setup is incomplete');
    await this.validateCatalog();
    const currentEmployees = await this.assertPlanFits(
      subscription,
      subscription.stripeCheckoutPlan,
    );
    if (subscription.stripeCheckoutEmployees === undefined)
      await this.update(subscription, token, {
        stripeCheckoutEmployees: currentEmployees,
      });
    await this.attempt(subscription, token, 'stripeSubscriptionAttemptAt');
    const activation = subscription.activatedAt;
    const remote = await this.stripe.api.subscriptions.create(
      {
        customer: subscription.stripeCustomerId!,
        default_payment_method: remoteId(setup.payment_method),
        items: this.items(
          subscription.stripeCheckoutPlan,
          subscription.stripeCheckoutEmployees!,
        ),
        billing_cycle_anchor_config: {
          day_of_month: activation.getUTCDate(),
          hour: activation.getUTCHours(),
          minute: activation.getUTCMinutes(),
          second: activation.getUTCSeconds(),
        },
        billing_mode: { type: 'classic' },
        proration_behavior: 'none',
        payment_behavior: 'default_incomplete',
        collection_method: 'charge_automatically',
        metadata: { companyId: subscription.companyId.toString() },
        expand: ['latest_invoice'],
      },
      { idempotencyKey: `dv-subscription-${checkout.id}` },
    );
    await this.update(
      subscription,
      token,
      {
        stripeSubscriptionId: remote.id,
        stripeManaged: true,
      },
      undefined,
      ['stripeMeterStartedAt'],
    );
    await this.applyCanonical(subscription, token, remote);
  }

  async webhook(body: Buffer | undefined, signature: string | undefined) {
    if (!this.enabled)
      throw new ServiceUnavailableException(
        'Test Mode payments are not configured',
      );
    if (!body || !signature)
      throw new BadRequestException('Invalid Stripe signature');
    let event: Stripe.Event;
    try {
      event = this.stripe.api.webhooks.constructEvent(
        body,
        signature,
        this.config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET'),
      );
    } catch {
      throw new BadRequestException('Invalid Stripe signature');
    }
    if (event.livemode)
      throw new BadRequestException(
        'Only Stripe Test Mode events are accepted',
      );
    if (!STRIPE_EVENTS.has(event.type))
      return { received: true, ignored: true };
    if (await this.events.exists({ eventId: event.id }))
      return { received: true, duplicate: true };
    let knownSubscription: TenantSubscription | undefined;
    try {
      let subscription: TenantSubscription | null;
      if (event.type.startsWith('checkout.'))
        subscription = await this.subscriptions.findOne({
          stripeCheckoutSessionId: (
            event.data.object as Stripe.Checkout.Session
          ).id,
        });
      else if (event.type.startsWith('customer.subscription.'))
        subscription = await this.subscriptions.findOne({
          stripeSubscriptionId: (event.data.object as Stripe.Subscription).id,
        });
      else {
        const invoice = event.data.object as Stripe.Invoice;
        const id = remoteId(invoice.parent?.subscription_details?.subscription);
        subscription = id
          ? await this.subscriptions.findOne({ stripeSubscriptionId: id })
          : null;
      }
      if (subscription) knownSubscription = subscription;
      if (!subscription) {
        // A subscription/invoice event can arrive between Stripe creation and
        // persistence of its ID. Retry instead of permanently ignoring it.
        if (!event.type.startsWith('checkout.')) {
          const object = event.data.object as
            Stripe.Subscription | Stripe.Invoice;
          const customer = remoteId(object.customer);
          const creating = customer
            ? await this.subscriptions.findOne({ stripeCustomerId: customer })
            : null;
          if (creating) knownSubscription = creating;
          if (
            creating?.stripeCheckoutOperation &&
            !creating.stripeSubscriptionId
          )
            throw new CheckoutMappingPendingException();
        }
        await this.events.create({
          eventId: event.id,
          type: event.type,
          processedAt: new Date(),
        });
        return { received: true, ignored: true };
      }
      await this.withLease(
        subscription.companyId.toString(),
        async (locked, token) => {
          knownSubscription = locked;
          if (await this.events.exists({ eventId: event.id })) return;
          if (
            event.type === 'checkout.session.completed' &&
            !locked.stripeSubscriptionId
          ) {
            const checkout = await this.stripe.api.checkout.sessions.retrieve(
              event.data.object.id,
            );
            await this.completeCheckout(locked, token, checkout);
          }
          if (locked.stripeSubscriptionId)
            await this.synchronize(locked, token, event);
          else
            await this.events.create({
              eventId: event.id,
              type: event.type,
              companyId: locked.companyId,
              processedAt: new Date(),
            });
        },
      );
      return { received: true };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        try {
          if (await this.events.exists({ eventId: event.id }))
            return { received: true, duplicate: true };
        } catch {
          /* A failed confirmation must remain retryable. */
        }
      }
      this.logSyncFailure(error, {
        message: 'Stripe webhook synchronization failed',
        eventType: event.type,
        ...safePaymentSyncIdentifiers({
          eventId: event.id,
          companyId: knownSubscription?.companyId.toString(),
          subscriptionId: knownSubscription?._id.toString(),
          stripeSubscriptionId: knownSubscription?.stripeSubscriptionId,
        }),
      });
      throw new ServiceUnavailableException(
        'Stripe synchronization temporarily unavailable',
      );
    }
  }

  private logSyncFailure(error: unknown, context: Record<string, string>) {
    const classification = classifyPaymentSyncFailure(error);
    const entry = { ...context, ...classification };
    if (classification.failureKind === 'expected_retry')
      this.logger.warn(entry);
    else this.logger.error(entry);
  }

  private async safeApi<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException ||
        error instanceof ServiceUnavailableException
      )
        throw error;
      this.logSyncFailure(error, {
        message: 'Stripe Test Mode request failed',
      });
      throw new ServiceUnavailableException(
        'Stripe Test Mode request temporarily unavailable',
      );
    }
  }
}
