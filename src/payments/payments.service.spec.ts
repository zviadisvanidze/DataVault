import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import Stripe from 'stripe';
import { paymentFixture } from '../../test/payments.fixture';
import { PlanCode } from '../plans/plan.constants';
import { billingPeriod } from '../subscriptions/billing-period';
import { assertPaymentAccess } from './payment-policy';
import {
  meterWindow,
  PaymentAccess,
  PaymentSyncIssue,
  UsageDeliveryState,
} from './payment.constants';

describe('Stripe Test Mode payments', () => {
  let f: ReturnType<typeof paymentFixture>;
  beforeEach(() => {
    f = paymentFixture();
  });

  it('rejects member control at the service boundary and derives the customer tenant server-side', async () => {
    await expect(
      f.service.checkout(f.member, PlanCode.BASIC),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await f.service.checkout(f.owner, PlanCode.BASIC);
    expect(f.api.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { companyId: f.owner.companyId } }),
      expect.objectContaining({
        idempotencyKey: expect.any(String) as unknown,
      }),
    );
    expect(f.api.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'setup',
        customer: f.sub.stripeCustomerId,
        metadata: expect.objectContaining({
          companyId: f.owner.companyId,
          planCode: PlanCode.BASIC,
        }) as unknown,
      }),
      expect.any(Object),
    );
    expect(f.sub.planCode).toBe(PlanCode.FREE);
    expect(f.api.subscriptions.create).not.toHaveBeenCalled();
    await expect(f.service.current(f.other)).rejects.toThrow(
      'Company subscription not found',
    );
  });

  it('reuses open hosted sessions and disallows a competing checkout target', async () => {
    await f.service.checkout(f.owner, PlanCode.BASIC);
    await f.service.checkout(f.owner, PlanCode.BASIC);
    expect(f.api.checkout.sessions.create).toHaveBeenCalledTimes(1);
    await expect(
      f.service.checkout(f.owner, PlanCode.PREMIUM),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([PlanCode.BASIC, PlanCode.PREMIUM])(
    'activates %s only after confirmed card setup and preserves the original anniversary without proration or trials',
    async (code) => {
      await f.activate(code);
      expect(f.sub.planCode).toBe(code);
      expect(f.sub.paymentAccess).toBe(PaymentAccess.DEFERRED);
      const params = f.api.subscriptions.create.mock.calls[0][0];
      expect(params).toMatchObject({
        billing_cycle_anchor_config: {
          day_of_month: 31,
          hour: 12,
          minute: 5,
          second: 7,
        },
        proration_behavior: 'none',
        payment_behavior: 'default_incomplete',
        collection_method: 'charge_automatically',
      });
      expect(params.trial_end).toBeUndefined();
      expect(params.items?.[0].quantity).toBe(code === PlanCode.BASIC ? 0 : 1);
    },
  );

  it('rejects incomplete card setup and creates no subscription', async () => {
    await f.service.checkout(f.owner, PlanCode.PREMIUM);
    f.sessions.get(f.sub.stripeCheckoutSessionId!)!.status = 'complete';
    f.api.setupIntents.retrieve.mockResolvedValueOnce({
      id: 'seti_fixture',
      livemode: false,
      status: 'requires_payment_method',
      customer: f.sub.stripeCustomerId,
      payment_method: 'pm_fixture',
    });
    await expect(
      f.deliver(
        f.event('checkout.session.completed', 'evt_invalid_setup', {
          id: f.sub.stripeCheckoutSessionId,
        }),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.api.subscriptions.create).not.toHaveBeenCalled();
    expect(f.events).toHaveLength(0);
    expect(f.sub.planCode).toBe(PlanCode.FREE);
  });

  it('verifies raw-body signatures and rejects live or unsupported payloads', async () => {
    await expect(
      f.service.webhook(Buffer.from('{}'), 'invalid'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.service.webhook(undefined, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    const live = { ...f.event(), livemode: true };
    await expect(f.deliver(live)).rejects.toBeInstanceOf(BadRequestException);
    expect(await f.deliver(f.event('payment_method.attached'))).toMatchObject({
      ignored: true,
    });
    expect(f.api.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('durably deduplicates retries and uses canonical Stripe state for out-of-order events', async () => {
    const remote = await f.activate();
    remote.status = 'past_due';
    const event = f.event('invoice.payment_failed', 'evt_failure', {
      parent: { subscription_details: { subscription: remote.id } },
    });
    await f.deliver(event);
    expect(f.sub.paymentAccess).toBe(PaymentAccess.SUSPENDED);
    const calls = f.api.subscriptions.retrieve.mock.calls.length;
    expect(await f.deliver(event)).toMatchObject({ duplicate: true });
    expect(f.api.subscriptions.retrieve.mock.calls).toHaveLength(calls);
    remote.status = 'active';
    remote.latest_invoice = { status: 'paid' } as Stripe.Invoice;
    await f.deliver(
      f.event('invoice.paid', 'evt_paid', {
        parent: { subscription_details: { subscription: remote.id } },
      }),
    );
    expect(f.sub.paymentAccess).toBe(PaymentAccess.ACTIVE);
    // Replaying an older failure notification must not regress current state.
    await f.deliver(
      f.event('invoice.payment_failed', 'evt_old_failure', {
        parent: { subscription_details: { subscription: remote.id } },
      }),
    );
    expect(f.sub.paymentAccess).toBe(PaymentAccess.ACTIVE);
  });

  it.each([
    'incomplete',
    'past_due',
    'unpaid',
    'paused',
  ] as Stripe.Subscription.Status[])(
    'never grants paid mutations for %s',
    async (status) => {
      const remote = await f.activate();
      remote.status = status;
      await f.deliver(f.event());
      expect(() => assertPaymentAccess(f.sub, true)).toThrow(
        ForbiddenException,
      );
    },
  );

  it('upgrades Basic immediately without resetting quota, anchor, or creating prorations', async () => {
    await f.activate(PlanCode.BASIC);
    f.periods.push({
      companyId: f.sub.companyId,
      startsAt: billingPeriod(f.sub.activatedAt, new Date()).startsAt,
      uploadedFiles: 80,
    });
    const anchor = f.sub.activatedAt.getTime();
    await f.service.changePlan(f.owner, PlanCode.PREMIUM);
    expect(f.sub.planCode).toBe(PlanCode.PREMIUM);
    expect(f.sub.pendingPlanCode).toBeUndefined();
    expect(f.sub.activatedAt.getTime()).toBe(anchor);
    expect(f.periods[0].uploadedFiles).toBe(80);
    expect(f.api.subscriptions.update).toHaveBeenCalledWith(
      f.sub.stripeSubscriptionId,
      expect.objectContaining({
        proration_behavior: 'none',
        payment_behavior: 'error_if_incomplete',
      }),
      expect.any(Object),
    );
  });

  it('queues a legal Premium downgrade for the anniversary and confirms the schedule only once', async () => {
    await f.activate();
    f.addEmployees(2);
    f.addPending(3);
    await f.service.changePlan(f.owner, PlanCode.BASIC);
    expect(f.sub.planCode).toBe(PlanCode.PREMIUM);
    expect(f.sub.pendingPlanCode).toBe(PlanCode.BASIC);
    const params = f.api.subscriptionSchedules.update.mock
      .calls[0] as unknown as [string, Stripe.SubscriptionScheduleUpdateParams];
    expect(params[1].phases?.[1]).toMatchObject({
      proration_behavior: 'none',
      billing_cycle_anchor: 'automatic',
      items: [{ price: 'price_basic', quantity: 2 }],
    });
    await f.service.reconcileCompany(f.owner.companyId);
    expect(f.api.subscriptionSchedules.update).toHaveBeenCalledTimes(1);
  });

  it('rejects downgrades exceeding accepted/pending seats or stored files', async () => {
    await f.activate();
    f.addEmployees(8);
    f.addPending(3);
    await expect(
      f.service.changePlan(f.owner, PlanCode.BASIC),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.api.subscriptionSchedules.create).not.toHaveBeenCalled();
    f.invitations.length = 0;
    f.periods.push({
      companyId: f.sub.companyId,
      startsAt: billingPeriod(f.sub.activatedAt, new Date()).startsAt,
      uploadedFiles: 101,
    });
    for (let i = 0; i < 101; i++) f.files.push({ companyId: f.sub.companyId });
    await expect(f.service.changePlan(f.owner, PlanCode.BASIC)).rejects.toThrow(
      'Stored files',
    );
    f.files.length = 100;
    await f.service.changePlan(f.owner, PlanCode.BASIC);
    expect(f.sub.pendingPlanCode).toBe(PlanCode.BASIC);
  });

  it('cancels immediately without proration and uses stored files rather than monthly history', async () => {
    const remote = await f.activate(PlanCode.BASIC);
    const anchor = f.sub.activatedAt;
    f.periods.push({
      companyId: f.sub.companyId,
      startsAt: billingPeriod(anchor, new Date()).startsAt,
      uploadedFiles: 101,
    });
    for (let i = 0; i < 10; i++) f.files.push({ companyId: f.sub.companyId });
    f.files.push({ companyId: f.other.companyId });
    const result = await f.service.changePlan(f.owner, PlanCode.FREE);
    expect(result.planCode).toBe(PlanCode.FREE);
    expect(remote.status).toBe('canceled');
    expect(f.api.subscriptions.cancel).toHaveBeenCalledWith(
      remote.id,
      { invoice_now: false, prorate: false },
      expect.any(Object),
    );
    expect(f.sub.activatedAt).toEqual(anchor);
    expect(f.sub.pendingPlanCode).toBeUndefined();
    expect(f.sub.paymentAccess).toBe(PaymentAccess.ACTIVE);
    expect(f.periods[0].uploadedFiles).toBe(101);
  });

  it.each([PlanCode.BASIC, PlanCode.PREMIUM])(
    'can buy %s again after an immediate Free downgrade',
    async (plan) => {
      const previous = await f.activate();
      const anchor = f.sub.activatedAt;
      await f.service.changePlan(f.owner, PlanCode.FREE);
      await f.service.checkout(f.owner, plan);
      expect(f.sub.planCode).toBe(PlanCode.FREE);
      expect(() => assertPaymentAccess(f.sub, true)).not.toThrow();
      const checkout = f.sessions.get(f.sub.stripeCheckoutSessionId!)!;
      checkout.status = 'complete';
      await f.deliver(
        f.event('checkout.session.completed', 'evt_rebuy', { id: checkout.id }),
      );
      expect(f.sub.planCode).toBe(plan);
      expect(f.sub.stripeSubscriptionId).not.toBe(previous.id);
      expect(previous.status).toBe('canceled');
      expect(f.sub.activatedAt).toEqual(anchor);
      await f.deliver(
        f.event('customer.subscription.deleted', 'evt_old_deleted', {
          id: previous.id,
        }),
      );
      expect(f.sub.planCode).toBe(plan);
    },
  );

  it('releases a queued Basic schedule before canceling immediately to Free', async () => {
    await f.activate();
    await f.service.changePlan(f.owner, PlanCode.BASIC);
    await f.service.changePlan(f.owner, PlanCode.FREE);
    expect(f.api.subscriptionSchedules.release).toHaveBeenCalledTimes(1);
    expect(f.sub.stripeScheduleId).toBeUndefined();
    expect(f.sub.planCode).toBe(PlanCode.FREE);
  });

  it.each(['employees', 'invitations'])(
    'rejects Free with remaining %s',
    async (kind) => {
      await f.activate();
      if (kind === 'employees') f.addEmployees(1);
      else f.addPending(1);
      await expect(
        f.service.changePlan(f.owner, PlanCode.FREE),
      ).rejects.toThrow('Accepted employees');
      expect(f.api.subscriptions.cancel).not.toHaveBeenCalled();
    },
  );

  it('rejects Free until extra stored files are deleted', async () => {
    await f.activate();
    for (let i = 0; i < 11; i++) f.files.push({ companyId: f.sub.companyId });
    await expect(f.service.changePlan(f.owner, PlanCode.FREE)).rejects.toThrow(
      'Stored files',
    );
    expect(f.api.subscriptions.cancel).not.toHaveBeenCalled();
    f.files.pop();
    await f.service.changePlan(f.owner, PlanCode.FREE);
    expect(f.sub.planCode).toBe(PlanCode.FREE);
  });

  it('does not grant Free on cancellation failure and retries the recorded intent', async () => {
    await f.activate(PlanCode.BASIC);
    f.api.subscriptions.cancel.mockRejectedValueOnce(
      new Error('provider failure'),
    );
    await expect(
      f.service.changePlan(f.owner, PlanCode.FREE),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.sub.planCode).toBe(PlanCode.BASIC);
    expect(f.sub.pendingPlanCode).toBe(PlanCode.FREE);
    await f.service.reconcileCompany(f.owner.companyId);
    expect(f.sub.planCode).toBe(PlanCode.FREE);
  });

  it('recovers a lost cancellation response without canceling twice', async () => {
    const remote = await f.activate(PlanCode.BASIC);
    f.api.subscriptions.cancel.mockImplementationOnce(() => {
      remote.status = 'canceled';
      return Promise.reject(new Error('response lost'));
    });
    await expect(
      f.service.changePlan(f.owner, PlanCode.FREE),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.sub.planCode).toBe(PlanCode.BASIC);
    await f.service.reconcileCompany(f.owner.companyId);
    expect(f.sub.planCode).toBe(PlanCode.FREE);
    expect(f.api.subscriptions.cancel).toHaveBeenCalledTimes(1);
  });

  it('suspends an externally canceled company that cannot fit Free, without deleting data', async () => {
    const remote = await f.activate();
    f.addEmployees(1);
    remote.status = 'canceled';
    await f.deliver(f.event('customer.subscription.deleted'));
    expect(f.sub.planCode).toBe(PlanCode.PREMIUM);
    expect(f.sub.paymentAccess).toBe(PaymentAccess.SUSPENDED);
    expect(f.sub.paymentSyncIssue).toBe(PaymentSyncIssue.PLAN_CONFLICT);
    f.users.splice(1);
    await f.service.reconcileCompany(f.owner.companyId);
    expect(f.sub.planCode).toBe(PlanCode.FREE);
  });

  it('synchronizes accepted employees only, excluding owner and pending invitations', async () => {
    const remote = await f.activate(PlanCode.BASIC);
    f.addEmployees(3);
    f.addPending(4);
    await f.service.reconcileCompany(f.owner.companyId);
    expect(remote.items.data[0].quantity).toBe(3);
    f.users.pop();
    await f.service.reconcileCompany(f.owner.companyId);
    expect(remote.items.data[0].quantity).toBe(2);
    expect(f.api.subscriptions.update).toHaveBeenLastCalledWith(
      remote.id,
      expect.objectContaining({
        items: [{ id: remote.items.data[0].id, quantity: 2 }],
        proration_behavior: 'none',
      }),
      expect.any(Object),
    );
  });

  it('records exact authoritative Premium overage in a transactional outbox and submits each identifier once', async () => {
    await f.activate();
    const period = billingPeriod(f.sub.activatedAt, new Date());
    await f.service.enqueueOverage(
      f.sub,
      period,
      1003,
      150,
      new Date(),
      {} as never,
    );
    expect(f.usages[0]).toMatchObject({
      companyId: f.sub.companyId,
      quantity: 3,
      customerId: f.sub.stripeCustomerId,
      subscriptionId: f.sub.stripeSubscriptionId,
    });
    await f.service.reconcileCompany(f.owner.companyId);
    await f.service.reconcileCompany(f.owner.companyId);
    expect(f.api.billing.meterEvents.create).toHaveBeenCalledTimes(1);
    expect(f.usages[0].state).toBe(UsageDeliveryState.SUBMITTED);
    expect(
      f.api.billing.meterEvents.create.mock.calls[0][0].payload.value,
    ).toBe('3');
    expect(f.usageModel.create).toHaveBeenCalledWith(expect.any(Array), {
      session: expect.any(Object) as unknown,
    });
  });

  it('does not enqueue included uploads or accept fractional money', async () => {
    await f.activate();
    const period = billingPeriod(f.sub.activatedAt, new Date());
    await f.service.enqueueOverage(
      f.sub,
      period,
      999,
      0,
      new Date(),
      {} as never,
    );
    expect(f.usages).toHaveLength(0);
    await expect(
      f.service.enqueueOverage(
        f.sub,
        period,
        1001,
        49,
        new Date(),
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('retries ambiguous metering with a stable identifier but freezes it before deduplication expiry', async () => {
    await f.activate();
    await f.service.enqueueOverage(
      f.sub,
      billingPeriod(f.sub.activatedAt, new Date()),
      1001,
      50,
      new Date(),
      {} as never,
    );
    f.api.billing.meterEvents.create.mockRejectedValueOnce(
      new Error('private diagnostic omitted'),
    );
    await expect(
      f.service.reconcileCompany(f.owner.companyId),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const identifier = f.usages[0].identifier;
    await f.service.reconcileCompany(f.owner.companyId);
    expect(
      f.api.billing.meterEvents.create.mock.calls.map(
        (call) => call[0].identifier,
      ),
    ).toEqual([identifier, identifier]);
    f.usages[0].state = UsageDeliveryState.PENDING;
    f.usages[0].firstAttemptAt = new Date(Date.now() - 24 * 3600000);
    await f.service.reconcileCompany(f.owner.companyId);
    expect(f.usages[0].state).toBe(UsageDeliveryState.RECONCILIATION_REQUIRED);
    expect(f.api.billing.meterEvents.create).toHaveBeenCalledTimes(2);
    expect(f.sub.paymentSyncIssue).toBe(
      PaymentSyncIssue.RECONCILIATION_REQUIRED,
    );
  });

  it('halts an ambiguous Checkout create outside the idempotency window', async () => {
    f.api.checkout.sessions.create.mockRejectedValueOnce(new Error('omitted'));
    await expect(
      f.service.checkout(f.owner, PlanCode.BASIC),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    f.sub.stripeCheckoutAttemptAt = new Date(Date.now() - 24 * 3600000);
    await expect(
      f.service.checkout(f.owner, PlanCode.BASIC),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.api.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it('keeps invoice prices/amounts separate from the local estimate and scopes them to the tenant customer', async () => {
    await f.activate();
    f.invoices.push({
      id: 'in_fixture',
      customer: f.sub.stripeCustomerId,
      status: 'paid',
      currency: 'usd',
      amount_due: 30050,
      amount_paid: 30050,
      total: 30050,
      created: 1700000000,
      hosted_invoice_url: 'https://invoice.stripe.test/fixture',
    } as Stripe.Invoice);
    const info = await f.service.current(f.owner);
    expect(info.invoices[0]).toMatchObject({
      amountDueCents: 30050,
      amountPaidCents: 30050,
      totalCents: 30050,
    });
    expect(f.api.invoices.list).toHaveBeenLastCalledWith({
      customer: f.sub.stripeCustomerId,
      limit: 10,
    });
    expect(JSON.stringify(info)).not.toContain('pm_fixture');
  });

  it('allows only a portal without plan/cancel controls and hides Stripe failures', async () => {
    await f.service.portal(f.owner);
    f.api.billingPortal.configurations.retrieve.mockResolvedValueOnce({
      id: 'bpc_fixture',
      active: true,
      livemode: false,
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        subscription_update: { enabled: true },
        subscription_cancel: { enabled: false },
      },
    });
    await expect(f.service.portal(f.owner)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    f.api.customers.create.mockRejectedValueOnce(
      new Error('sensitive error not surfaced'),
    );
    f.sub.stripeCustomerId = undefined;
    await expect(f.service.portal(f.owner)).rejects.toThrow(
      'temporarily unavailable',
    );
  });

  it('fences concurrent company operations with a durable lease', async () => {
    f.sub.stripeLeaseUntil = new Date(Date.now() + 60000);
    f.sub.stripeLeaseToken = 'another-process';
    await expect(
      f.service.checkout(f.owner, PlanCode.BASIC),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.api.customers.create).not.toHaveBeenCalled();
  });

  it('rejects a mismatched tenant or billing anchor from Stripe', async () => {
    const remote = await f.activate();
    remote.metadata.companyId = f.other.companyId;
    await expect(f.deliver(f.event())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(f.events).toHaveLength(1);
    remote.metadata.companyId = f.owner.companyId;
    remote.billing_cycle_anchor_config!.day_of_month = 1;
    await expect(f.deliver(f.event())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('aligns metering windows to minute boundaries without changing local periods', () => {
    const period = {
      startsAt: new Date('2024-02-29T12:05:07.321Z'),
      endsAt: new Date('2024-03-31T12:05:07.321Z'),
    };
    const window = meterWindow(period.startsAt, period.endsAt);
    expect(window.start % 60).toBe(0);
    expect(window.end % 60).toBe(0);
    expect(window.start * 1000).toBeGreaterThan(period.startsAt.getTime());
    expect(period.startsAt.toISOString()).toBe('2024-02-29T12:05:07.321Z');
  });

  it('allows owners to undo queued cancellation without changing the anniversary', async () => {
    await f.activate(PlanCode.BASIC);
    const remote = f.remote.get(f.sub.stripeSubscriptionId!)!;
    remote.cancel_at_period_end = true;
    f.sub.pendingPlanCode = PlanCode.FREE;
    f.sub.pendingPlanAt = new Date(Date.now() + 86400000);
    f.sub.stripePlanConfirmed = true;
    await f.service.changePlan(f.owner, PlanCode.BASIC);
    expect(f.sub.stripeCancelAtPeriodEnd).toBe(false);
    expect(f.sub.pendingPlanCode).toBeUndefined();
  });

  it('holds a Premium draft until meter summaries match, then reconciles its exact quantity', async () => {
    await f.activate();
    const period = billingPeriod(f.sub.activatedAt, new Date());
    await f.service.enqueueOverage(
      f.sub,
      period,
      1002,
      100,
      new Date(),
      {} as never,
    );
    const invoice = {
      id: 'in_metered',
      customer: f.sub.stripeCustomerId,
      livemode: false,
      status: 'draft',
      auto_advance: true,
      metadata: {},
      parent: {
        subscription_details: { subscription: f.sub.stripeSubscriptionId },
      },
    } as Stripe.Invoice;
    f.invoices.push(invoice);
    f.api.invoices.listLineItems.mockResolvedValue({
      has_more: false,
      data: [
        {
          id: 'il_usage',
          quantity: 0,
          period: {
            start: Math.floor(period.startsAt.getTime() / 1000),
            end: Math.floor(period.endsAt.getTime() / 1000),
          },
          pricing: { price_details: { price: 'price_overage' } },
        } as Stripe.InvoiceLineItem,
      ],
    });
    await f.service.reconcileCompany(f.owner.companyId);
    expect(invoice.auto_advance).toBe(false);
    expect(f.sub.paymentSyncIssue).toBe(
      PaymentSyncIssue.RECONCILIATION_REQUIRED,
    );
    expect(() => assertPaymentAccess(f.sub, true)).toThrow();
    f.api.billing.meters.listEventSummaries.mockResolvedValue({
      data: [{ aggregated_value: 2 }],
    });
    await f.service.reconcileCompany(f.owner.companyId);
    expect(f.api.invoices.updateLineItem).toHaveBeenCalledWith(
      'in_metered',
      'il_usage',
      { quantity: 2 },
      { idempotencyKey: 'dv-invoice-overage-in_metered-2' },
    );
    expect(invoice.auto_advance).toBe(true);
    expect(f.sub.paymentSyncIssue).toBe(PaymentSyncIssue.NONE);
  });

  it('snapshots accepted Basic employees for a draft without billing pending invitations', async () => {
    await f.activate(PlanCode.BASIC);
    f.addEmployees(4);
    f.addPending(3);
    const invoice = {
      id: 'in_seats',
      customer: f.sub.stripeCustomerId,
      livemode: false,
      status: 'draft',
      auto_advance: true,
      metadata: {},
      parent: {
        subscription_details: { subscription: f.sub.stripeSubscriptionId },
      },
    } as Stripe.Invoice;
    f.invoices.push(invoice);
    f.api.invoices.listLineItems.mockResolvedValue({
      has_more: false,
      data: [
        {
          id: 'il_seats',
          quantity: 0,
          pricing: { price_details: { price: 'price_basic' } },
        } as Stripe.InvoiceLineItem,
      ],
    });
    await f.service.reconcileCompany(f.owner.companyId);
    expect(invoice.metadata?.datavault_employee_count).toBe('4');
    f.users.pop();
    await f.service.reconcileCompany(f.owner.companyId);
    expect(invoice.metadata?.datavault_employee_count).toBe('4');
    expect(f.api.invoices.updateLineItem).toHaveBeenLastCalledWith(
      'in_seats',
      'il_seats',
      { quantity: 4 },
      { idempotencyKey: 'dv-invoice-quantity-in_seats' },
    );
  });

  it('detects finalized overage discrepancies without rewriting invoices', async () => {
    const remote = await f.activate();
    const period = billingPeriod(f.sub.activatedAt, new Date());
    remote.latest_invoice = {
      id: 'in_finalized',
      customer: f.sub.stripeCustomerId,
      status: 'paid',
      parent: { subscription_details: { subscription: remote.id } },
    } as Stripe.Invoice;
    f.api.invoices.listLineItems.mockResolvedValue({
      has_more: false,
      data: [
        {
          id: 'il_finalized',
          quantity: 2,
          period: {
            start: Math.floor(period.startsAt.getTime() / 1000),
            end: Math.floor(period.endsAt.getTime() / 1000),
          },
          pricing: { price_details: { price: 'price_overage' } },
        } as Stripe.InvoiceLineItem,
      ],
    });
    await f.service.reconcileCompany(f.owner.companyId);
    expect(f.sub.paymentSyncIssue).toBe(
      PaymentSyncIssue.RECONCILIATION_REQUIRED,
    );
    expect(f.api.invoices.updateLineItem).not.toHaveBeenCalled();
    expect(() => assertPaymentAccess(f.sub, true)).toThrow();
  });

  it('does not ignore an invoice arriving before a known Checkout subscription ID is persisted', async () => {
    await f.service.checkout(f.owner, PlanCode.BASIC);
    await expect(
      f.deliver(
        f.event('invoice.created', 'evt_racing', {
          customer: f.sub.stripeCustomerId,
          parent: { subscription_details: { subscription: 'sub_not_saved' } },
        }),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.events).toHaveLength(0);
  });

  it('rejects a changed period even when the Stripe anchor configuration looks correct', async () => {
    const remote = await f.activate();
    remote.items.data[0].current_period_end += 86400;
    await expect(f.deliver(f.event())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('keeps fresh incomplete subscriptions from granting paid entitlements', async () => {
    const create = f.api.subscriptions.create.getMockImplementation()!;
    f.api.subscriptions.create.mockImplementationOnce(async (params) => {
      const remote = await create(params);
      remote.status = 'incomplete';
      return remote;
    });
    await f.activate();
    expect(f.sub.planCode).toBe(PlanCode.FREE);
    expect(f.sub.paymentAccess).toBe(PaymentAccess.SUSPENDED);
    expect(() => assertPaymentAccess(f.sub, true)).toThrow();
  });

  it('never acknowledges an unrelated uniqueness failure as a processed event', async () => {
    await f.activate();
    f.eventModel.create.mockRejectedValueOnce(
      Object.assign(new Error('uniqueness failure'), { code: 11000 }),
    );
    const event = f.event(
      'customer.subscription.updated',
      'evt_unrelated_collision',
    );
    await expect(f.deliver(event)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(f.events.some((row) => row.eventId === event.id)).toBe(false);
    await f.deliver(event);
    expect(f.events.some((row) => row.eventId === event.id)).toBe(true);
  });

  it('retains schedule ownership after a downgrade and releases it before a later upgrade', async () => {
    const remote = await f.activate();
    await f.service.changePlan(f.owner, PlanCode.BASIC);
    remote.items.data = [
      {
        ...remote.items.data[0],
        price: { id: 'price_basic' } as Stripe.Price,
        quantity: 0,
      },
    ];
    await f.deliver(f.event());
    expect(f.sub.planCode).toBe(PlanCode.BASIC);
    expect(f.sub.pendingPlanCode).toBeUndefined();
    expect(f.sub.stripeScheduleId).toBe('sub_sched');
    await f.service.changePlan(f.owner, PlanCode.PREMIUM);
    expect(f.api.subscriptionSchedules.release).toHaveBeenCalledWith(
      'sub_sched',
      {},
      expect.any(Object),
    );
    expect(f.sub.planCode).toBe(PlanCode.PREMIUM);
    expect(f.sub.stripeScheduleId).toBeUndefined();
  });

  it('immediately replaces an existing confirmed period-end Free cancellation', async () => {
    const remote = await f.activate(PlanCode.BASIC);
    remote.cancel_at_period_end = true;
    f.sub.pendingPlanCode = PlanCode.FREE;
    f.sub.stripePlanConfirmed = true;
    f.sub.pendingPlanAt = new Date(Date.now() - 1000);
    await f.service.changePlan(f.owner, PlanCode.FREE);
    expect(remote.status).toBe('canceled');
    expect(f.sub.planCode).toBe(PlanCode.FREE);
    expect(f.sub.pendingPlanCode).toBeUndefined();
  });

  it('commits the event ID and local access change atomically and retries failed persistence', async () => {
    const remote = await f.activate();
    remote.status = 'past_due';
    f.eventModel.create.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const event = f.event(
      'customer.subscription.updated',
      'evt_database_retry',
    );
    await expect(f.deliver(event)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(f.sub.paymentAccess).toBe(PaymentAccess.DEFERRED);
    expect(f.events).toHaveLength(1);
    await f.deliver(event);
    expect(f.sub.paymentAccess).toBe(PaymentAccess.SUSPENDED);
    expect(f.events).toHaveLength(2);
  });

  it('preserves a day-31 anchor through a leap-year February and rejects reset dates', async () => {
    jest.useFakeTimers({ now: new Date('2024-02-10T10:00:00Z') });
    try {
      const remote = await f.activate();
      expect(remote.items.data[0].current_period_end).toBe(
        Math.floor(new Date('2024-02-29T12:05:07.321Z').getTime() / 1000),
      );
      expect(remote.billing_cycle_anchor_config?.day_of_month).toBe(31);
      remote.items.data[0].current_period_end = Math.floor(
        new Date('2024-03-10T10:00:00Z').getTime() / 1000,
      );
      await expect(f.deliver(f.event())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
