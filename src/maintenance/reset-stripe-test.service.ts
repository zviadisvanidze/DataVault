import { ClientSession, Connection, mongo, Types } from 'mongoose';
import { Role } from '../enums/roles.enum';
import { InvitationStatus } from '../invitations/entities/employee-invitation.entity';
import { PaymentAccess, PaymentSyncIssue } from '../payments/payment.constants';
import { PLAN_CATALOG, PlanCode } from '../plans/plan.constants';
import { billingPeriod } from '../subscriptions/billing-period';
import { CliFailure, CliFailureCategory } from './cli-errors';

export enum StripeResetRefusalReason {
  PRODUCTION = 'development_or_test_required',
  CONFIRMATION = 'explicit_offline_test_mode_confirmation_required',
  COMPANY = 'company_not_found',
  SUBSCRIPTION = 'exactly_one_subscription_required',
  PAID_OR_MANAGED = 'paid_or_stripe_managed_subscription_requires_reconciliation',
  IN_FLIGHT = 'stripe_operation_or_checkout_may_be_in_flight',
  HISTORY = 'stripe_event_or_usage_history_requires_reconciliation',
  UNKNOWN_STATE = 'subscription_has_unsupported_or_inconsistent_state',
  NO_MAPPING = 'no_stripe_customer_mapping_to_reset',
  REVISION = 'subscription_changed_since_dry_run',
  BASIC_RECOVERY_STATE = 'unmanaged_basic_checkout_state_is_not_exact',
  FREE_CAPACITY = 'company_does_not_fit_free_plan',
  ACCOUNT = 'exactly_one_owner_and_no_employees_required',
  PERIOD = 'current_billing_period_is_inconsistent',
}

export class StripeResetRefusal extends CliFailure {
  constructor(public readonly reason: StripeResetRefusalReason) {
    super(CliFailureCategory.STRIPE_RESET_REFUSED);
  }
}

export interface StripeResetOptions {
  companyId: string;
  environment: string | undefined;
  execute: boolean;
  expectedRevision?: number;
  confirmReset: boolean;
  confirmAppStopped: boolean;
  confirmOldStripeQuiescent: boolean;
  recoverUnmanagedBasic: boolean;
  confirmTransitionToFree: boolean;
}

export type StripeResetRecord = Record<string, unknown> & {
  _id: Types.ObjectId;
  revision?: number;
};
export interface StripeResetCollections {
  companies: mongo.Collection<StripeResetRecord>;
  subscriptions: mongo.Collection<StripeResetRecord>;
  stripeEvents: mongo.Collection<StripeResetRecord>;
  stripeUsage: mongo.Collection<StripeResetRecord>;
  users: mongo.Collection<StripeResetRecord>;
  invitations: mongo.Collection<StripeResetRecord>;
  periods: mongo.Collection<StripeResetRecord>;
}

const resetFields = [
  'stripeCustomerId',
  'stripeSubscriptionId',
  'stripeStatus',
  'pendingPlanCode',
  'pendingPlanAt',
  'stripeScheduleId',
  'stripeChangeOperation',
  'stripeCheckoutAttemptAt',
  'stripeCustomerAttemptAt',
  'stripeSubscriptionAttemptAt',
  'stripePlanAttemptAt',
  'stripePlanEmployees',
  'stripeCheckoutEmployees',
  'stripeCheckoutOperation',
  'stripeCheckoutSessionId',
  'stripeCheckoutPlan',
  'stripeSyncedAt',
  'stripeMeterStartedAt',
  'stripeNextSyncAt',
  'stripeLeaseToken',
  'stripeLeaseUntil',
] as const;

const knownFields = new Set([
  '_id',
  '__v',
  'companyId',
  'planCode',
  'activatedAt',
  'planChangedAt',
  'revision',
  'createdAt',
  'updatedAt',
  'stripeManaged',
  'paymentAccess',
  'paymentSyncIssue',
  'stripeCancelAtPeriodEnd',
  'stripePlanConfirmed',
  ...resetFields,
]);

function refuse(reason: StripeResetRefusalReason): never {
  throw new StripeResetRefusal(reason);
}

export function validateStripeResetOptions(options: StripeResetOptions) {
  if (!['development', 'test'].includes(options.environment ?? ''))
    refuse(StripeResetRefusalReason.PRODUCTION);
  if (!/^[a-fA-F0-9]{24}$/.test(options.companyId))
    throw new CliFailure(CliFailureCategory.INVALID_STRIPE_RESET_ARGUMENTS);
  if (
    options.expectedRevision !== undefined &&
    (!Number.isSafeInteger(options.expectedRevision) ||
      options.expectedRevision < 0)
  )
    throw new CliFailure(CliFailureCategory.INVALID_STRIPE_RESET_ARGUMENTS);
  if (
    options.execute &&
    (options.expectedRevision === undefined ||
      !options.confirmReset ||
      !options.confirmAppStopped ||
      !options.confirmOldStripeQuiescent ||
      (options.recoverUnmanagedBasic && !options.confirmTransitionToFree))
  )
    refuse(StripeResetRefusalReason.CONFIRMATION);
  if (
    !options.execute &&
    (options.expectedRevision !== undefined ||
      options.confirmReset ||
      options.confirmAppStopped ||
      options.confirmOldStripeQuiescent ||
      options.confirmTransitionToFree)
  )
    throw new CliFailure(CliFailureCategory.INVALID_STRIPE_RESET_ARGUMENTS);
  if (!options.recoverUnmanagedBasic && options.confirmTransitionToFree)
    throw new CliFailure(CliFailureCategory.INVALID_STRIPE_RESET_ARGUMENTS);
}

/** Verify mode locally without ever making a Stripe request or displaying a key. */
export function assertStripeTestKeyForExecution(key: unknown) {
  if (typeof key !== 'string' || !/^sk_test_[A-Za-z0-9]+$/.test(key))
    throw new CliFailure(CliFailureCategory.INVALID_STRIPE_RESET_ARGUMENTS);
}

export function stripeResetArguments(
  args: string[],
  environment: string | undefined,
): StripeResetOptions {
  let companyId: string | undefined;
  let revision: string | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.has(arg))
      throw new CliFailure(CliFailureCategory.INVALID_STRIPE_RESET_ARGUMENTS);
    flags.add(arg);
    if (arg === '--company-id') companyId = args[++i];
    else if (arg === '--expected-revision') revision = args[++i];
    else if (
      ![
        '--execute',
        '--confirm-reset',
        '--confirm-app-stopped',
        '--confirm-old-stripe-quiescent',
        '--recover-unmanaged-basic',
        '--confirm-transition-to-free',
      ].includes(arg)
    )
      throw new CliFailure(CliFailureCategory.INVALID_STRIPE_RESET_ARGUMENTS);
  }
  if (!companyId)
    throw new CliFailure(CliFailureCategory.INVALID_STRIPE_RESET_ARGUMENTS);
  const options: StripeResetOptions = {
    companyId,
    environment,
    execute: flags.has('--execute'),
    expectedRevision:
      revision === undefined || !/^(0|[1-9]\d*)$/.test(revision)
        ? undefined
        : Number(revision),
    confirmReset: flags.has('--confirm-reset'),
    confirmAppStopped: flags.has('--confirm-app-stopped'),
    confirmOldStripeQuiescent: flags.has('--confirm-old-stripe-quiescent'),
    recoverUnmanagedBasic: flags.has('--recover-unmanaged-basic'),
    confirmTransitionToFree: flags.has('--confirm-transition-to-free'),
  };
  if (
    flags.has('--expected-revision') &&
    options.expectedRevision === undefined
  )
    throw new CliFailure(CliFailureCategory.INVALID_STRIPE_RESET_ARGUMENTS);
  validateStripeResetOptions(options);
  return options;
}

/** Offline, Test Mode only: detach an unused customer mapping, never a paid plan. */
export class StripeTestStateReset {
  constructor(
    private readonly connection: Connection,
    private readonly collections: StripeResetCollections,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(options: StripeResetOptions) {
    validateStripeResetOptions(options);
    const companyId = new Types.ObjectId(options.companyId);
    if (options.recoverUnmanagedBasic)
      return this.recoverUnmanagedBasic(options, companyId);
    try {
      return await this.connection.transaction(
        async (session) => {
          const subscription = await this.inspect(companyId, session);
          const revision = subscription.revision as number;
          if (options.execute && revision !== options.expectedRevision)
            refuse(StripeResetRefusalReason.REVISION);
          const fieldsPresent = resetFields.filter(
            (field) => subscription[field] !== undefined,
          );
          if (!options.execute)
            return {
              companyId: companyId.toHexString(),
              mode: 'dry_run' as const,
              eligible: true,
              planCode: PlanCode.FREE,
              revision,
              fieldsToClear: fieldsPresent,
              stripeEvents: 0,
              stripeUsage: 0,
              updated: false,
            };
          const result = await this.collections.subscriptions.updateOne(
            {
              _id: subscription._id,
              companyId,
              revision,
              planCode: PlanCode.FREE,
              stripeCustomerId: subscription.stripeCustomerId,
              stripeManaged: false,
            },
            {
              $unset: Object.fromEntries(
                resetFields.map((field) => [field, '']),
              ),
              $set: {
                stripeManaged: false,
                paymentAccess: PaymentAccess.UNMANAGED,
                paymentSyncIssue: PaymentSyncIssue.NONE,
                stripeCancelAtPeriodEnd: false,
                stripePlanConfirmed: false,
                revision: revision + 1,
                updatedAt: new Date(),
              },
            },
            { session },
          );
          if (result.matchedCount !== 1 || result.modifiedCount !== 1)
            throw new CliFailure(
              CliFailureCategory.STRIPE_RESET_COUNT_MISMATCH,
            );
          return {
            companyId: companyId.toHexString(),
            mode: 'reset' as const,
            eligible: true,
            planCode: PlanCode.FREE,
            previousRevision: revision,
            revision: revision + 1,
            fieldsCleared: fieldsPresent,
            stripeEvents: 0,
            stripeUsage: 0,
            updated: true,
          };
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          maxCommitTimeMS: 10000,
        },
      );
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      throw new CliFailure(CliFailureCategory.MONGO_TRANSACTION);
    }
  }

  private async recoverUnmanagedBasic(
    options: StripeResetOptions,
    companyId: Types.ObjectId,
  ) {
    try {
      return await this.connection.transaction(
        async (session) => {
          const at = this.now();
          const checked = await this.inspectBasicRecovery(
            companyId,
            session,
            at,
          );
          const subscription = checked.subscription;
          const revision = subscription.revision as number;
          if (options.execute && revision !== options.expectedRevision)
            refuse(StripeResetRefusalReason.REVISION);
          const report = {
            companyId: companyId.toHexString(),
            fromPlan: PlanCode.BASIC,
            toPlan: PlanCode.FREE,
            previousRevision: revision,
            previousPlanChangedAt: subscription.planChangedAt,
            periodStartsAt: checked.period.startsAt,
            periodEndsAt: checked.period.endsAt,
            acceptedEmployees: 0,
            pendingInvitations: 0,
            successfulUploads: checked.uploadedFiles,
            stripeEvents: 0,
            stripeUsage: 0,
            fieldsToClear: resetFields.filter(
              (field) => subscription[field] !== undefined,
            ),
          };
          if (!options.execute)
            return {
              ...report,
              mode: 'dry_run_basic_recovery' as const,
              revision,
              planChangedAtWillUpdateOnExecution: true,
              updated: false,
            };
          const result = await this.collections.subscriptions.updateOne(
            {
              _id: subscription._id,
              companyId,
              revision,
              planCode: PlanCode.BASIC,
              stripeManaged: false,
              paymentAccess: PaymentAccess.UNMANAGED,
              paymentSyncIssue: PaymentSyncIssue.RETRY_REQUIRED,
              stripeCustomerId: subscription.stripeCustomerId,
              stripeCheckoutSessionId: subscription.stripeCheckoutSessionId,
              stripeCheckoutOperation: subscription.stripeCheckoutOperation,
              stripeCheckoutPlan: PlanCode.PREMIUM,
              stripeSubscriptionId: { $exists: false },
              stripeSubscriptionAttemptAt: { $exists: false },
            },
            {
              $unset: Object.fromEntries(
                resetFields.map((field) => [field, '']),
              ),
              $set: {
                planCode: PlanCode.FREE,
                planChangedAt: at,
                stripeManaged: false,
                paymentAccess: PaymentAccess.UNMANAGED,
                paymentSyncIssue: PaymentSyncIssue.NONE,
                stripeCancelAtPeriodEnd: false,
                stripePlanConfirmed: false,
                revision: revision + 1,
                updatedAt: at,
              },
            },
            { session },
          );
          if (result.matchedCount !== 1 || result.modifiedCount !== 1)
            throw new CliFailure(
              CliFailureCategory.STRIPE_RESET_COUNT_MISMATCH,
            );
          return {
            ...report,
            mode: 'recovered_unmanaged_basic' as const,
            revision: revision + 1,
            newPlanChangedAt: at,
            updated: true,
          };
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          maxCommitTimeMS: 10000,
        },
      );
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      throw new CliFailure(CliFailureCategory.MONGO_TRANSACTION);
    }
  }

  private async inspectBasicRecovery(
    companyId: Types.ObjectId,
    session: ClientSession,
    at: Date,
  ) {
    const c = this.collections;
    if (
      !(await c.companies.findOne(
        { _id: companyId },
        { session, maxTimeMS: 5000, projection: { _id: 1 } },
      ))
    )
      refuse(StripeResetRefusalReason.COMPANY);
    const companyRef = new RegExp(`^${companyId.toHexString()}$`, 'i');
    const tenant = { companyId: { $in: [companyId, companyRef] } };
    const subscriptions = await c.subscriptions
      .find(tenant, { session, maxTimeMS: 5000 })
      .toArray();
    if (subscriptions.length !== 1)
      refuse(StripeResetRefusalReason.SUBSCRIPTION);
    const subscription = subscriptions[0];
    if (
      !(subscription._id instanceof Types.ObjectId) ||
      !(subscription.companyId instanceof Types.ObjectId) ||
      !subscription.companyId.equals(companyId) ||
      Object.keys(subscription).some((field) => !knownFields.has(field)) ||
      !Number.isSafeInteger(subscription.revision) ||
      (subscription.revision as number) < 0 ||
      !(subscription.activatedAt instanceof Date) ||
      !(subscription.planChangedAt instanceof Date) ||
      !Number.isFinite(subscription.activatedAt.getTime()) ||
      !Number.isFinite(subscription.planChangedAt.getTime()) ||
      subscription.activatedAt > at ||
      subscription.planChangedAt > at
    )
      refuse(StripeResetRefusalReason.UNKNOWN_STATE);
    if (
      subscription.planCode !== PlanCode.BASIC ||
      subscription.stripeManaged !== false ||
      subscription.paymentAccess !== PaymentAccess.UNMANAGED ||
      subscription.paymentSyncIssue !== PaymentSyncIssue.RETRY_REQUIRED ||
      subscription.stripeCancelAtPeriodEnd !== false ||
      subscription.stripePlanConfirmed !== false ||
      typeof subscription.stripeCustomerId !== 'string' ||
      !/^cus_[A-Za-z0-9]+$/.test(subscription.stripeCustomerId) ||
      typeof subscription.stripeCheckoutSessionId !== 'string' ||
      !/^cs_test_[A-Za-z0-9]+$/.test(subscription.stripeCheckoutSessionId) ||
      subscription.stripeCheckoutPlan !== PlanCode.PREMIUM ||
      typeof subscription.stripeCheckoutOperation !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        subscription.stripeCheckoutOperation,
      ) ||
      !(subscription.stripeCustomerAttemptAt instanceof Date) ||
      !(subscription.stripeCheckoutAttemptAt instanceof Date) ||
      !(subscription.stripeNextSyncAt instanceof Date) ||
      !Number.isFinite(subscription.stripeCustomerAttemptAt.getTime()) ||
      !Number.isFinite(subscription.stripeCheckoutAttemptAt.getTime()) ||
      !Number.isFinite(subscription.stripeNextSyncAt.getTime()) ||
      subscription.stripeSubscriptionId !== undefined ||
      subscription.stripeSubscriptionAttemptAt !== undefined ||
      subscription.stripeStatus !== undefined ||
      subscription.stripeCheckoutEmployees !== undefined ||
      subscription.stripeSyncedAt !== undefined ||
      subscription.stripeMeterStartedAt !== undefined ||
      subscription.stripeLeaseToken !== undefined ||
      subscription.stripeLeaseUntil !== undefined ||
      subscription.pendingPlanCode !== undefined ||
      subscription.pendingPlanAt !== undefined ||
      subscription.stripeScheduleId !== undefined ||
      subscription.stripeChangeOperation !== undefined ||
      subscription.stripePlanAttemptAt !== undefined ||
      subscription.stripePlanEmployees !== undefined
    )
      refuse(StripeResetRefusalReason.BASIC_RECOVERY_STATE);
    if (
      (await c.stripeEvents.countDocuments(tenant, {
        session,
        maxTimeMS: 5000,
      })) ||
      (await c.stripeUsage.countDocuments(tenant, { session, maxTimeMS: 5000 }))
    )
      refuse(StripeResetRefusalReason.HISTORY);
    const totalUsers = await c.users.countDocuments(tenant, {
      session,
      maxTimeMS: 5000,
    });
    const owners = await c.users.countDocuments(
      { ...tenant, role: Role.COMPANY_OWNER },
      { session, maxTimeMS: 5000 },
    );
    if (totalUsers !== 1 || owners !== 1)
      refuse(StripeResetRefusalReason.ACCOUNT);
    const pendingInvitations = await c.invitations.countDocuments(
      {
        ...tenant,
        status: InvitationStatus.PENDING,
        expiresAt: { $gt: at },
      },
      { session, maxTimeMS: 5000 },
    );
    if (pendingInvitations !== 0)
      refuse(StripeResetRefusalReason.FREE_CAPACITY);
    const period = billingPeriod(subscription.activatedAt, at);
    const usage = await c.periods
      .find(
        { ...tenant, startsAt: period.startsAt },
        { session, maxTimeMS: 5000 },
      )
      .toArray();
    if (
      usage.length > 1 ||
      (usage.length === 1 &&
        (!(usage[0].endsAt instanceof Date) ||
          usage[0].endsAt.getTime() !== period.endsAt.getTime() ||
          !Number.isSafeInteger(usage[0].uploadedFiles) ||
          (usage[0].uploadedFiles as number) < 0 ||
          usage[0].fileOverageCents !== 0))
    )
      refuse(StripeResetRefusalReason.PERIOD);
    const uploadedFiles = usage.length ? (usage[0].uploadedFiles as number) : 0;
    if (uploadedFiles > PLAN_CATALOG[PlanCode.FREE].includedFilesPerMonth)
      refuse(StripeResetRefusalReason.FREE_CAPACITY);
    return { subscription, period, uploadedFiles };
  }

  private async inspect(companyId: Types.ObjectId, session: ClientSession) {
    const c = this.collections;
    const company = await c.companies.findOne(
      { _id: companyId },
      { session, maxTimeMS: 5000, projection: { _id: 1 } },
    );
    if (!company) refuse(StripeResetRefusalReason.COMPANY);
    const companyRef = new RegExp(`^${companyId.toHexString()}$`, 'i');
    const tenant = { companyId: { $in: [companyId, companyRef] } };
    const subscriptions = await c.subscriptions
      .find(tenant, { session, maxTimeMS: 5000 })
      .toArray();
    if (subscriptions.length !== 1)
      refuse(StripeResetRefusalReason.SUBSCRIPTION);
    const subscription = subscriptions[0];
    if (
      !(subscription._id instanceof Types.ObjectId) ||
      !(subscription.companyId instanceof Types.ObjectId) ||
      !subscription.companyId.equals(companyId) ||
      Object.keys(subscription).some((field) => !knownFields.has(field)) ||
      !Number.isSafeInteger(subscription.revision) ||
      (subscription.revision as number) < 0 ||
      !(subscription.activatedAt instanceof Date) ||
      !(subscription.planChangedAt instanceof Date)
    )
      refuse(StripeResetRefusalReason.UNKNOWN_STATE);
    if (
      subscription.planCode !== PlanCode.FREE ||
      subscription.stripeManaged !== false ||
      subscription.stripeSubscriptionId !== undefined ||
      subscription.stripeStatus !== undefined ||
      (subscription.paymentAccess !== undefined &&
        subscription.paymentAccess !== PaymentAccess.UNMANAGED)
    )
      refuse(StripeResetRefusalReason.PAID_OR_MANAGED);
    if (
      subscription.stripeCheckoutSessionId !== undefined ||
      subscription.stripeCheckoutAttemptAt !== undefined ||
      subscription.stripeSubscriptionAttemptAt !== undefined ||
      subscription.stripeCheckoutEmployees !== undefined ||
      subscription.stripeSyncedAt !== undefined ||
      subscription.stripeMeterStartedAt !== undefined ||
      subscription.stripeNextSyncAt !== undefined ||
      subscription.stripeLeaseToken !== undefined ||
      subscription.stripeLeaseUntil !== undefined ||
      subscription.pendingPlanCode !== undefined ||
      subscription.pendingPlanAt !== undefined ||
      subscription.stripeScheduleId !== undefined ||
      subscription.stripeChangeOperation !== undefined ||
      subscription.stripePlanAttemptAt !== undefined ||
      subscription.stripePlanEmployees !== undefined ||
      (subscription.stripePlanConfirmed !== undefined &&
        subscription.stripePlanConfirmed !== false) ||
      (subscription.stripeCancelAtPeriodEnd !== undefined &&
        subscription.stripeCancelAtPeriodEnd !== false) ||
      subscription.paymentSyncIssue ===
        PaymentSyncIssue.RECONCILIATION_REQUIRED ||
      subscription.paymentSyncIssue === PaymentSyncIssue.PLAN_CONFLICT
    )
      refuse(StripeResetRefusalReason.IN_FLIGHT);
    if (
      typeof subscription.stripeCustomerId !== 'string' ||
      !/^cus_[A-Za-z0-9]+$/.test(subscription.stripeCustomerId)
    )
      refuse(StripeResetRefusalReason.NO_MAPPING);
    if (
      subscription.stripeCheckoutOperation !== undefined &&
      (typeof subscription.stripeCheckoutOperation !== 'string' ||
        ![PlanCode.BASIC, PlanCode.PREMIUM].includes(
          subscription.stripeCheckoutPlan as PlanCode,
        ))
    )
      refuse(StripeResetRefusalReason.UNKNOWN_STATE);
    if (
      subscription.stripeCheckoutPlan !== undefined &&
      subscription.stripeCheckoutOperation === undefined
    )
      refuse(StripeResetRefusalReason.UNKNOWN_STATE);
    if (
      subscription.stripeCustomerAttemptAt !== undefined &&
      !(subscription.stripeCustomerAttemptAt instanceof Date)
    )
      refuse(StripeResetRefusalReason.UNKNOWN_STATE);
    if (
      subscription.paymentSyncIssue !== undefined &&
      ![PaymentSyncIssue.NONE, PaymentSyncIssue.RETRY_REQUIRED].includes(
        subscription.paymentSyncIssue as PaymentSyncIssue,
      )
    )
      refuse(StripeResetRefusalReason.UNKNOWN_STATE);
    if (
      (await c.stripeEvents.countDocuments(tenant, {
        session,
        maxTimeMS: 5000,
      })) ||
      (await c.stripeUsage.countDocuments(tenant, {
        session,
        maxTimeMS: 5000,
      }))
    )
      refuse(StripeResetRefusalReason.HISTORY);
    return subscription;
  }
}
