import { INestApplication, Logger } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { mongo, Types } from 'mongoose';
import Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { configureApp } from '../src/config/configure-app';
import { IsAuthGuard } from '../src/guards/is-auth.guard';
import { Role } from '../src/enums/roles.enum';
import { PlanCode } from '../src/plans/plan.constants';
import {
  PaymentAccess,
  UsageDeliveryState,
} from '../src/payments/payment.constants';
import { billingPeriod } from '../src/subscriptions/billing-period';
import {
  PaymentsController,
  StripeWebhookController,
} from '../src/payments/payments.controller';
import { PaymentsService } from '../src/payments/payments.service';
import { paymentFixture } from './payments.fixture';

describe('Stripe Test Mode HTTP/security (e2e, mocked Stripe)', () => {
  let app: INestApplication<App>;
  let f: ReturnType<typeof paymentFixture>;
  let ownerToken: string;
  let memberToken: string;
  let otherToken: string;
  let inactiveToken: string;
  beforeEach(async () => {
    f = paymentFixture();
    const inactive = {
      _id: new Types.ObjectId(),
      companyId: new Types.ObjectId(),
      role: Role.COMPANY_OWNER,
    };
    const actors = [f.owner, f.member, f.other].map((actor) => ({
      _id: new Types.ObjectId(actor.id),
      companyId: new Types.ObjectId(actor.companyId),
      role: actor.role,
    }));
    actors.push(inactive);
    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: 'test-jwt-secret-for-mocked-payments',
          signOptions: { algorithm: 'HS256' },
          verifyOptions: { algorithms: ['HS256'] },
        }),
        ThrottlerModule.forRoot([
          { name: 'publicAuth', limit: 1000, ttl: 60000 },
        ]),
      ],
      controllers: [PaymentsController, StripeWebhookController],
      providers: [
        { provide: ConfigService, useValue: f.config },
        IsAuthGuard,
        RolesGuard,
        { provide: PaymentsService, useValue: f.service },
        {
          provide: getModelToken('user'),
          useValue: {
            findById: (id: string) =>
              actors.find((actor) => actor._id.toString() === id),
          },
        },
        {
          provide: getModelToken('company'),
          useValue: {
            findOne: (filter: { _id: Types.ObjectId }) =>
              filter._id.equals(inactive.companyId)
                ? null
                : { _id: filter._id, activatedAt: new Date() },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication<INestApplication<App>>({
      rawBody: true,
      logger: false,
    });
    configureApp(app);
    await app.init();
    const jwt = module.get(JwtService);
    [ownerToken, memberToken, otherToken, inactiveToken] = [
      f.owner.id,
      f.member.id,
      f.other.id,
      inactive._id.toString(),
    ].map((id) => jwt.sign({ id }));
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('logs the real Checkout provisioning race once, then accepts and deduplicates its retry', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const create = f.api.subscriptions.create.getMockImplementation()!;
    let racingEvent: ReturnType<typeof f.event>;
    f.api.subscriptions.create.mockImplementationOnce(async (params) => {
      const remote = await create(params);
      racingEvent = f.event(
        'customer.subscription.created',
        'evt_http_provisioning',
        remote,
      );
      const signed = f.signed(racingEvent);
      await request(app.getHttpServer())
        .post('/payments/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signed.signature)
        .send(signed.body.toString())
        .expect(503)
        .expect(({ body }: { body: { message: string } }) => {
          expect(body.message).toBe(
            'Stripe synchronization temporarily unavailable',
          );
        });
      return remote;
    });
    await request(app.getHttpServer())
      .post('/payments/checkout')
      .set(auth(ownerToken))
      .send({ planCode: 'basic' })
      .expect(201);
    f.sessions.get(f.sub.stripeCheckoutSessionId!)!.status = 'complete';
    const checkout = f.signed(
      f.event('checkout.session.completed', 'evt_http_setup_complete', {
        id: f.sub.stripeCheckoutSessionId,
      }),
    );
    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', checkout.signature)
      .send(checkout.body.toString())
      .expect(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'checkout_mapping_pending',
        eventType: 'customer.subscription.created',
        eventId: 'evt_http_provisioning',
        companyId: f.owner.companyId,
        retryable: true,
      }),
    );
    const retry = f.signed(racingEvent!);
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .post('/payments/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', retry.signature)
        .send(retry.body.toString())
        .expect(200);
    expect(
      f.events.filter((row) => row.eventId === racingEvent!.id),
    ).toHaveLength(1);
    expect(f.api.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(f.sub.planCode).toBe(PlanCode.BASIC);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it.each([
    'company_lease_busy',
    'database_retry',
    'stripe_sync_retry',
  ] as const)(
    'keeps HTTP retry and idempotency behavior for %s',
    async (reason) => {
      await f.activate();
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const errorLog = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      if (reason === 'company_lease_busy') {
        f.sub.stripeLeaseUntil = new Date(Date.now() + 60000);
        f.sub.stripeLeaseToken = 'another-worker';
      } else if (reason === 'database_retry') {
        f.transaction.mockRejectedValueOnce(
          new mongo.MongoServerError({
            message: 'private transaction diagnostics',
            code: 112,
          }),
        );
      } else
        f.api.subscriptions.retrieve.mockRejectedValueOnce(
          new Stripe.errors.StripeConnectionError({
            message: 'private Stripe diagnostics',
          }),
        );
      const event = f.event(
        'customer.subscription.updated',
        'evt_http_retry_classification',
      );
      const signed = f.signed(event);
      const send = () =>
        request(app.getHttpServer())
          .post('/payments/webhook')
          .set('Content-Type', 'application/json')
          .set('Stripe-Signature', signed.signature)
          .send(signed.body.toString());
      await send().expect(503);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          reason,
          failureKind: 'expected_retry',
          eventType: event.type,
          eventId: event.id,
          retryable: true,
        }),
      );
      expect(f.events.some((row) => row.eventId === event.id)).toBe(false);
      f.sub.set('stripeLeaseUntil', undefined);
      f.sub.set('stripeLeaseToken', undefined);
      await send().expect(200);
      await send()
        .expect(200)
        .expect(({ body }: { body: { duplicate: boolean } }) =>
          expect(body.duplicate).toBe(true),
        );
      expect(f.events.filter((row) => row.eventId === event.id)).toHaveLength(
        1,
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(errorLog).not.toHaveBeenCalled();
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain('private');
      expect(logged).not.toContain(signed.signature);
    },
  );

  it('surfaces unknown failures safely and leaves unsupported events quiet', async () => {
    await f.activate();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const privateData = [
      'sk_test_hidden',
      'whsec_hidden',
      'pm_hidden',
      'jwt_hidden',
      'employee@example.test',
    ];
    f.api.subscriptions.retrieve.mockRejectedValueOnce(
      new Error(privateData.join(' ')),
    );
    const event = f.event(
      'customer.subscription.updated',
      'evt_http_unexpected',
      { id: f.sub.stripeSubscriptionId, sensitive: privateData },
    );
    const signed = f.signed(event);
    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signed.signature)
      .send(signed.body.toString())
      .expect(503);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'stripe_sync_retry',
        failureKind: 'unexpected_failure',
        retryable: null,
      }),
    );
    const logged = JSON.stringify(errorLog.mock.calls);
    for (const value of [...privateData, signed.signature])
      expect(logged).not.toContain(value);
    const ignored = f.signed(
      f.event('customer.updated', 'evt_unsupported', {
        sensitive: privateData,
      }),
    );
    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', ignored.signature)
      .send(ignored.body.toString())
      .expect(200)
      .expect(({ body }: { body: { ignored: boolean } }) =>
        expect(body.ignored).toBe(true),
      );
    expect(warn).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('does not classify a permanent tenant mapping failure as transient', async () => {
    const remote = await f.activate();
    remote.metadata.companyId = f.other.companyId;
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const signed = f.signed(
      f.event('customer.subscription.updated', 'evt_http_invalid_mapping'),
    );
    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signed.signature)
      .send(signed.body.toString())
      .expect(503);
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'stripe_sync_validation',
        retryable: false,
        failureKind: 'validation_failure',
      }),
    );
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('requires authentication, activation and owner privileges', async () => {
    await request(app.getHttpServer())
      .post('/payments/checkout')
      .send({ planCode: 'basic' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/payments/checkout')
      .set(auth(inactiveToken))
      .send({ planCode: 'basic' })
      .expect(401);
    for (const endpoint of [
      'checkout',
      'portal',
      'plan',
      'cancel',
      'reconcile',
    ])
      await request(app.getHttpServer())
        .post(`/payments/${endpoint}`)
        .set(auth(memberToken))
        .send({})
        .expect(403);
    await request(app.getHttpServer())
      .get('/payments/current')
      .set(auth(memberToken))
      .expect(403);
    expect(f.api.customers.create).not.toHaveBeenCalled();
  });

  it.each(['basic', 'premium'])(
    'creates hosted %s setup with server-selected tenant and no redirect activation',
    async (planCode) => {
      await request(app.getHttpServer())
        .post('/payments/checkout')
        .set(auth(ownerToken))
        .send({ planCode })
        .expect(201)
        .expect(
          ({
            body,
          }: {
            body: { mode: string; paymentCollected: boolean; url: string };
          }) => {
            expect(body.mode).toBe('setup');
            expect(body.paymentCollected).toBe(false);
            expect(body.url).toMatch(/^https:/);
          },
        );
      expect(f.sub.planCode).toBe(PlanCode.FREE);
    },
  );

  it('rejects company, quantity, prices, URLs and usage injection', async () => {
    for (const field of [
      'companyId',
      'quantity',
      'priceId',
      'successUrl',
      'uploadedFiles',
      'totalAmountCents',
    ])
      await request(app.getHttpServer())
        .post('/payments/checkout')
        .set(auth(ownerToken))
        .send({ planCode: 'basic', [field]: 'injected' })
        .expect(400);
    await request(app.getHttpServer())
      .post('/payments/checkout')
      .set(auth(ownerToken))
      .send({ planCode: 'free' })
      .expect(400);
    await request(app.getHttpServer())
      .get('/payments/current?companyId=other')
      .set(auth(ownerToken))
      .expect(400);
    await request(app.getHttpServer())
      .post('/payments/cancel')
      .set(auth(ownerToken))
      .send({ companyId: f.other.companyId })
      .expect(400);
    expect(f.api.customers.create).not.toHaveBeenCalled();
  });

  it('isolates payment reads and returns private no-store metadata', async () => {
    await request(app.getHttpServer())
      .get('/payments/current')
      .set(auth(otherToken))
      .expect(404);
    await request(app.getHttpServer())
      .get('/payments/current')
      .set(auth(ownerToken))
      .expect('Cache-Control', 'private, no-store')
      .expect(200)
      .expect(({ body }: { body: { mode: string; invoices: unknown[] } }) => {
        expect(body.mode).toBe('test');
        expect(body.invoices).toEqual([]);
      });
  });

  it('rejects invalid signatures and tampered raw bodies', async () => {
    await request(app.getHttpServer())
      .post('/payments/webhook')
      .send({})
      .expect(400);
    const signed = f.signed(f.event());
    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signed.signature)
      .send('{}')
      .expect(400);
    expect(f.events).toHaveLength(0);
  });

  it('uses Nest rawBody for valid signatures, activates server-side and deduplicates delivery', async () => {
    await request(app.getHttpServer())
      .post('/payments/checkout')
      .set(auth(ownerToken))
      .send({ planCode: 'premium' })
      .expect(201);
    f.sessions.get(f.sub.stripeCheckoutSessionId!)!.status = 'complete';
    const signed = f.signed(
      f.event('checkout.session.completed', 'evt_http_checkout', {
        id: f.sub.stripeCheckoutSessionId,
      }),
    );
    for (let attempt = 0; attempt < 2; attempt++)
      await request(app.getHttpServer())
        .post('/payments/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signed.signature)
        .send(signed.body.toString())
        .expect(200);
    expect(f.sub.planCode).toBe(PlanCode.PREMIUM);
    expect(f.api.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(f.events).toHaveLength(1);
  });

  it('processes failures and recovery from canonical state even with reordered notifications', async () => {
    const remote = await f.activate();
    remote.status = 'past_due';
    const signed = f.signed(f.event());
    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signed.signature)
      .send(signed.body.toString())
      .expect(200);
    expect(f.sub.paymentAccess).toBe(PaymentAccess.SUSPENDED);
    remote.status = 'active';
    await request(app.getHttpServer())
      .post('/payments/reconcile')
      .set(auth(ownerToken))
      .send({})
      .expect(201);
    expect(f.sub.paymentAccess).toBe(PaymentAccess.DEFERRED);
  });

  it('prevents paid activation through the legacy-style plan action before Checkout', async () => {
    await request(app.getHttpServer())
      .post('/payments/plan')
      .set(auth(ownerToken))
      .send({ planCode: 'premium' })
      .expect(409);
    expect(f.sub.planCode).toBe(PlanCode.FREE);
  });

  it('rejects a downgrade that conflicts with accepted and pending employees', async () => {
    await f.activate();
    f.addEmployees(9);
    f.addPending(2);
    await request(app.getHttpServer())
      .post('/payments/plan')
      .set(auth(ownerToken))
      .send({ planCode: 'basic' })
      .expect(409);
    expect(f.api.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it('confirms immediate cancellation before granting Free', async () => {
    await f.activate(PlanCode.BASIC);
    await request(app.getHttpServer())
      .post('/payments/cancel')
      .set(auth(ownerToken))
      .send({})
      .expect(201);
    expect(f.sub.planCode).toBe(PlanCode.FREE);
    expect(f.sub.pendingPlanCode).toBeUndefined();
    expect(f.sub.stripeCancelAtPeriodEnd).toBe(false);
    expect(f.api.subscriptions.cancel).toHaveBeenCalledTimes(1);
  });

  it('returns a safe file-limit reason and allows retry after deleting an extra stored file', async () => {
    await f.activate();
    for (let i = 0; i < 11; i++) f.files.push({ companyId: f.sub.companyId });
    await request(app.getHttpServer())
      .post('/payments/cancel')
      .set(auth(ownerToken))
      .send({})
      .expect(409)
      .expect(({ body }: { body: { code: string } }) =>
        expect(body.code).toBe('plan_file_limit'),
      );
    expect(f.api.subscriptions.cancel).not.toHaveBeenCalled();
    f.files.pop();
    await request(app.getHttpServer())
      .post('/payments/cancel')
      .set(auth(ownerToken))
      .send({})
      .expect(201);
    expect(f.sub.planCode).toBe(PlanCode.FREE);
  });

  it('returns safe failures and keeps failed webhook delivery retryable', async () => {
    await f.activate();
    f.api.subscriptions.retrieve.mockRejectedValueOnce(
      new Error('do not expose private provider diagnostics'),
    );
    const signed = f.signed(f.event());
    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signed.signature)
      .send(signed.body.toString())
      .expect(503)
      .expect(({ body }: { body: { message: string } }) => {
        expect(body.message).toBe(
          'Stripe synchronization temporarily unavailable',
        );
      });
    expect(f.events).toHaveLength(1);
    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signed.signature)
      .send(signed.body.toString())
      .expect(200);
    expect(f.events).toHaveLength(2);
  });

  it('synchronizes Basic accepted seats through owner reconciliation, excluding pending seats', async () => {
    const remote = await f.activate(PlanCode.BASIC);
    f.addEmployees(3);
    f.addPending(4);
    await request(app.getHttpServer())
      .post('/payments/reconcile')
      .set(auth(ownerToken))
      .send({})
      .expect(201);
    expect(remote.items.data[0].quantity).toBe(3);
    f.users.pop();
    await request(app.getHttpServer())
      .post('/payments/reconcile')
      .set(auth(ownerToken))
      .send({})
      .expect(201);
    expect(remote.items.data[0].quantity).toBe(2);
  });

  it('reports recorded Premium overage once through reconciliation without accepting client usage', async () => {
    await f.activate();
    await f.service.enqueueOverage(
      f.sub,
      billingPeriod(f.sub.activatedAt, new Date()),
      1002,
      100,
      new Date(),
      {} as never,
    );
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .post('/payments/reconcile')
        .set(auth(ownerToken))
        .send({})
        .expect(201);
    expect(f.api.billing.meterEvents.create).toHaveBeenCalledTimes(1);
    expect(
      f.api.billing.meterEvents.create.mock.calls[0][0].payload.value,
    ).toBe('2');
    expect(f.usages[0].state).toBe(UsageDeliveryState.SUBMITTED);
    await request(app.getHttpServer())
      .post('/payments/reconcile')
      .set(auth(ownerToken))
      .send({ overageUploads: 0 })
      .expect(400);
  });

  it('serializes simultaneous plan requests instead of applying competing changes', async () => {
    await f.activate(PlanCode.BASIC);
    const retrieve = f.api.subscriptions.retrieve.getMockImplementation()!;
    f.api.subscriptions.retrieve.mockImplementationOnce(async (id) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      return retrieve(id);
    });
    const results = await Promise.all([
      request(app.getHttpServer())
        .post('/payments/plan')
        .set(auth(ownerToken))
        .send({ planCode: 'premium' }),
      request(app.getHttpServer())
        .post('/payments/plan')
        .set(auth(ownerToken))
        .send({ planCode: 'premium' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(f.sub.planCode).toBe(PlanCode.PREMIUM);
  });
});
