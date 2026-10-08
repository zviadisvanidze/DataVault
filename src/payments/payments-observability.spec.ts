import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { mongo } from 'mongoose';
import Stripe from 'stripe';
import { paymentFixture } from '../../test/payments.fixture';
import { PlanCode } from '../plans/plan.constants';

describe('Stripe webhook safe operational logging', () => {
  let f: ReturnType<typeof paymentFixture>;
  let warn: jest.SpyInstance;
  let errorLog: jest.SpyInstance;
  beforeEach(() => {
    f = paymentFixture();
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('classifies a real creation-before-ID-persistence race and lets its retry commit once', async () => {
    const create = f.api.subscriptions.create.getMockImplementation()!;
    let racingEvent: Stripe.Event;
    f.api.subscriptions.create.mockImplementationOnce(async (params) => {
      const remote = await create(params);
      racingEvent = f.event(
        'customer.subscription.created',
        'evt_racing_creation',
        remote,
      );
      await expect(f.deliver(racingEvent)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(f.events.some((row) => row.eventId === racingEvent.id)).toBe(
        false,
      );
      return remote;
    });
    await f.activate(PlanCode.BASIC);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      message: 'Stripe webhook synchronization failed',
      reason: 'checkout_mapping_pending',
      failureKind: 'expected_retry',
      retryable: true,
      eventType: 'customer.subscription.created',
      eventId: 'evt_racing_creation',
      companyId: f.owner.companyId,
      subscriptionId: f.sub._id.toString(),
    });
    await f.deliver(racingEvent!);
    expect(await f.deliver(racingEvent!)).toMatchObject({ duplicate: true });
    expect(
      f.events.filter((row) => row.eventId === racingEvent!.id),
    ).toHaveLength(1);
    expect(f.api.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('classifies a busy company lease without duplicate logging or losing the event', async () => {
    await f.activate(PlanCode.BASIC);
    f.sub.stripeLeaseUntil = new Date(Date.now() + 60000);
    f.sub.stripeLeaseToken = 'another-operation';
    const event = f.event('customer.subscription.updated', 'evt_lease_busy');
    await expect(f.deliver(event)).rejects.toThrow(
      'Stripe synchronization temporarily unavailable',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'company_lease_busy',
        eventId: event.id,
        stripeSubscriptionId: f.sub.stripeSubscriptionId,
        retryable: true,
      }),
    );
    f.sub.set('stripeLeaseUntil', undefined);
    f.sub.set('stripeLeaseToken', undefined);
    await f.deliver(event);
    expect(await f.deliver(event)).toMatchObject({ duplicate: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('classifies an exhausted transient transaction failure and preserves atomic retry', async () => {
    await f.activate(PlanCode.BASIC);
    f.transaction.mockRejectedValueOnce(
      new mongo.MongoServerError({
        message: 'sensitive database text',
        errorLabels: ['TransientTransactionError'],
      }),
    );
    const event = f.event(
      'customer.subscription.updated',
      'evt_database_retry',
    );
    await expect(f.deliver(event)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'database_retry',
        eventId: event.id,
        retryable: true,
      }),
    );
    expect(f.events.some((row) => row.eventId === event.id)).toBe(false);
    await f.deliver(event);
    expect(await f.deliver(event)).toMatchObject({ duplicate: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      'sensitive database text',
    );
  });

  it('classifies Stripe connection failures without logging provider details', async () => {
    await f.activate();
    f.api.subscriptions.retrieve.mockRejectedValueOnce(
      new Stripe.errors.StripeConnectionError({ message: 'sk_test_sensitive' }),
    );
    await expect(f.deliver(f.event())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'stripe_sync_retry',
        failureKind: 'expected_retry',
        retryable: true,
      }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk_test_sensitive');
  });

  it('logs permanent mapping validation distinctly while preserving its existing 503 contract', async () => {
    const remote = await f.activate();
    remote.metadata.companyId = f.other.companyId;
    await expect(f.deliver(f.event())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'stripe_sync_validation',
        failureKind: 'validation_failure',
        retryable: false,
      }),
    );
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('surfaces unknown failures at error level without emitting error objects, signatures, or webhook data', async () => {
    await f.activate();
    const sensitive = [
      'sk_test_hidden',
      'whsec_hidden',
      'pm_hidden',
      'user@example.test',
      'jwt_hidden',
      'mongodb://user:password@host',
    ];
    f.api.subscriptions.retrieve.mockRejectedValueOnce(
      Object.assign(new Error(sensitive.join(' ')), {
        raw: {
          payment_method: sensitive[2],
          customer: { email: sensitive[3] },
        },
        headers: { authorization: sensitive[4] },
      }),
    );
    const signed = f.signed(
      f.event('customer.subscription.updated', 'evt_safe_context', {
        id: f.sub.stripeSubscriptionId,
        secret: sensitive,
        signature: 'signature_hidden',
      }),
    );
    await expect(
      f.service.webhook(signed.body, signed.signature),
    ).rejects.toThrow('Stripe synchronization temporarily unavailable');
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith({
      message: 'Stripe webhook synchronization failed',
      reason: 'stripe_sync_retry',
      failureKind: 'unexpected_failure',
      retryable: null,
      eventType: 'customer.subscription.updated',
      eventId: 'evt_safe_context',
      companyId: f.owner.companyId,
      subscriptionId: f.sub._id.toString(),
      stripeSubscriptionId: f.sub.stripeSubscriptionId,
    });
    const logged = JSON.stringify(errorLog.mock.calls);
    for (const value of [...sensitive, signed.signature, 'signature_hidden'])
      expect(logged).not.toContain(value);
    expect(f.events.some((row) => row.eventId === 'evt_safe_context')).toBe(
      false,
    );
  });

  it('leaves unsupported, duplicate, and invalid-signature behavior quiet', async () => {
    expect(await f.deliver(f.event('setup_intent.created'))).toMatchObject({
      ignored: true,
    });
    await f.activate();
    expect(
      await f.deliver(f.event('checkout.session.completed', 'evt_checkout')),
    ).toMatchObject({ duplicate: true });
    await expect(
      f.service.webhook(Buffer.from('secret'), 'secret'),
    ).rejects.toThrow('Invalid Stripe signature');
    expect(warn).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('classifies safeApi failures once without changing responses or logging typed lease rethrows', async () => {
    f.api.customers.create.mockRejectedValueOnce(
      new Stripe.errors.StripeConnectionError({
        message: 'private provider response',
      }),
    );
    await expect(f.service.checkout(f.owner, PlanCode.BASIC)).rejects.toThrow(
      'Stripe Test Mode request temporarily unavailable',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      message: 'Stripe Test Mode request failed',
      reason: 'stripe_sync_retry',
      failureKind: 'expected_retry',
      retryable: true,
    });
    f.sub.stripeLeaseUntil = new Date(Date.now() + 60000);
    await expect(f.service.checkout(f.owner, PlanCode.BASIC)).rejects.toThrow(
      'Billing synchronization is in progress; retry shortly',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
  });
});
