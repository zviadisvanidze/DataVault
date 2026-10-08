import { ConfigService } from '@nestjs/config';
import { Connection, Model, Mongoose, Types } from 'mongoose';
import Stripe from 'stripe';
import { AuthenticatedUser } from '../src/common/types/authenticated-user';
import { Role } from '../src/enums/roles.enum';
import { InvitationStatus } from '../src/invitations/entities/employee-invitation.entity';
import { PLAN_CATALOG, PlanCode } from '../src/plans/plan.constants';
import { PlansService } from '../src/plans/plans.service';
import {
  Subscription,
  subscriptionSchema,
} from '../src/subscriptions/entities/subscription.entity';
import { billingPeriod } from '../src/subscriptions/billing-period';
import {
  PaymentAccess,
  STRIPE_API_VERSION,
  UsageDeliveryState,
} from '../src/payments/payment.constants';
import { PaymentsService } from '../src/payments/payments.service';

export const paymentConfig = {
  TRUST_PROXY_HOPS: 0,
  STRIPE_ENABLED: true,
  STRIPE_SECRET_KEY: 'sk_test_fixture',
  STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
  STRIPE_BASIC_PRICE_ID: 'price_basic',
  STRIPE_PREMIUM_PRICE_ID: 'price_premium',
  STRIPE_OVERAGE_PRICE_ID: 'price_overage',
  STRIPE_OVERAGE_METER_ID: 'mtr_fixture',
  STRIPE_OVERAGE_EVENT_NAME: 'datavault_upload_overage',
  STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_fixture',
  STRIPE_CHECKOUT_SUCCESS_URL: 'https://client.test/payments/success',
  STRIPE_CHECKOUT_CANCEL_URL: 'https://client.test/payments/cancel',
  STRIPE_PORTAL_RETURN_URL: 'https://client.test/settings',
  STRIPE_SYNC_INTERVAL_MS: 30000,
};

type Row = Record<string, unknown>;
const scalar = (value: unknown): unknown =>
  value instanceof Types.ObjectId
    ? value.toString()
    : value instanceof Date
      ? value.getTime()
      : value;
export function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$and')
      return (expected as Row[]).every((part) => matches(row, part));
    if (key === '$or')
      return (expected as Row[]).some((part) => matches(row, part));
    const actual = scalar(row[key]);
    if (
      expected &&
      typeof expected === 'object' &&
      !(expected instanceof Date) &&
      !(expected instanceof Types.ObjectId)
    )
      return Object.entries(expected).every(([op, value]) => {
        const right = scalar(value);
        if (op === '$exists') return (actual !== undefined) === value;
        if (op === '$ne') return actual !== right;
        if (op === '$gt')
          return actual !== undefined && (actual as number) > (right as number);
        if (op === '$gte')
          return (
            actual !== undefined && (actual as number) >= (right as number)
          );
        if (op === '$lt')
          return actual !== undefined && (actual as number) < (right as number);
        if (op === '$lte')
          return (
            actual !== undefined && (actual as number) <= (right as number)
          );
        return false;
      });
    return actual === scalar(expected);
  });
}
class Query<T> implements PromiseLike<T> {
  constructor(private value: T) {}
  select() {
    return this;
  }
  session() {
    return this;
  }
  sort() {
    return this;
  }
  limit(n: number) {
    if (Array.isArray(this.value)) this.value = this.value.slice(0, n) as T;
    return this;
  }
  then<TResult1 = T, TResult2 = never>(
    fulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.value).then(fulfilled, rejected);
  }
}
function patch(row: Row, change: Row) {
  Object.assign(row, change.$set ?? {});
  for (const key of Object.keys(change.$unset ?? {})) delete row[key];
  for (const [key, value] of Object.entries((change.$inc ?? {}) as Row))
    row[key] = Number(row[key] ?? 0) + Number(value);
}
function memory(rows: Row[], unique?: string) {
  return {
    find: jest.fn(
      (filter: Row) => new Query(rows.filter((row) => matches(row, filter))),
    ),
    findOne: jest.fn(
      (filter: Row) =>
        new Query(rows.find((row) => matches(row, filter)) ?? null),
    ),
    exists: jest.fn(
      (filter: Row) =>
        new Query(
          rows.find((row) => matches(row, filter)) ? { _id: 'exists' } : null,
        ),
    ),
    countDocuments: jest.fn(
      (filter: Row) =>
        new Query(rows.filter((row) => matches(row, filter)).length),
    ),
    updateOne: jest.fn((filter: Row, change: Row) => {
      const row = rows.find((row) => matches(row, filter));
      if (row) patch(row, change);
      return new Query({ matchedCount: row ? 1 : 0 });
    }),
    create: jest.fn((input: Row | Row[]) => {
      const items = Array.isArray(input) ? input : [input];
      for (const item of items) {
        if (unique && rows.some((row) => row[unique] === item[unique]))
          throw Object.assign(new Error('duplicate'), { code: 11000 });
        rows.push({
          _id: new Types.ObjectId(),
          state: UsageDeliveryState.PENDING,
          ...item,
        });
      }
      return Promise.resolve(
        Array.isArray(input) ? rows.slice(-items.length) : rows.at(-1),
      );
    }),
  };
}
export function paymentFixture() {
  const companyId = new Types.ObjectId();
  const owner: AuthenticatedUser = {
    id: new Types.ObjectId().toString(),
    companyId: companyId.toString(),
    role: Role.COMPANY_OWNER,
  };
  const member: AuthenticatedUser = {
    id: new Types.ObjectId().toString(),
    companyId: companyId.toString(),
    role: Role.COMPANY_MEMBER,
  };
  const other: AuthenticatedUser = {
    id: new Types.ObjectId().toString(),
    companyId: new Types.ObjectId().toString(),
    role: Role.COMPANY_OWNER,
  };
  // A real schema document exercises new defaults and update/unset behavior.
  const mongo = new Mongoose();
  const SubscriptionModel = mongo.model(
    'fixtureSubscription',
    subscriptionSchema,
  );
  const sub = new SubscriptionModel({
    companyId,
    activatedAt: new Date('2024-01-31T12:05:07.321Z'),
    planChangedAt: new Date(),
    planCode: PlanCode.FREE,
  });
  const subscriptions = [sub];
  const subModel = {
    findOne: jest.fn((filter: Row) =>
      Promise.resolve(
        subscriptions.find((row) =>
          matches(row.toObject() as unknown as Row, filter),
        ) ?? null,
      ),
    ),
    exists: jest.fn((filter: Row) =>
      Promise.resolve(
        subscriptions.some((row) =>
          matches(row.toObject() as unknown as Row, filter),
        ),
      ),
    ),
    findOneAndUpdate: jest.fn((filter: Row, change: Row) => {
      const row = subscriptions.find((row) =>
        matches(row.toObject() as unknown as Row, filter),
      );
      if (row) {
        for (const [key, value] of Object.entries((change.$set ?? {}) as Row))
          row.set(key, value);
        for (const key of Object.keys(change.$unset ?? {}))
          row.set(key, undefined);
        for (const [key, value] of Object.entries((change.$inc ?? {}) as Row))
          row.set(key, Number(row.get(key)) + Number(value));
      }
      return Promise.resolve(row ?? null);
    }),
    updateOne: jest.fn((filter: Row, change: Row) => {
      const row = subscriptions.find((row) =>
        matches(row.toObject() as unknown as Row, filter),
      );
      if (row) {
        for (const [key, value] of Object.entries((change.$set ?? {}) as Row))
          row.set(key, value);
        for (const key of Object.keys(change.$unset ?? {}))
          row.set(key, undefined);
      }
      return Promise.resolve({ matchedCount: row ? 1 : 0 });
    }),
  };
  const users: Row[] = [
    {
      _id: new Types.ObjectId(owner.id),
      companyId,
      role: Role.COMPANY_OWNER,
      email: 'fixture@example.test',
    },
  ];
  const invitations: Row[] = [];
  const periods: Row[] = [];
  const files: Row[] = [];
  const usages: Row[] = [];
  const events: Row[] = [];
  const userModel = memory(users);
  const invitationModel = memory(invitations);
  const periodModel = memory(periods);
  const usageModel = memory(usages, 'identifier');
  const eventModel = memory(events, 'eventId');
  const remote = new Map<string, Stripe.Subscription>();
  const sessions = new Map<string, Stripe.Checkout.Session>();
  const invoices: Stripe.Invoice[] = [];
  const sdk = new Stripe('sk_test_fixture', { apiVersion: STRIPE_API_VERSION });
  const api = {
    webhooks: sdk.webhooks,
    prices: {
      retrieve: jest.fn((id: string) =>
        Promise.resolve({
          id,
          livemode: false,
          active: true,
          currency: 'usd',
          unit_amount:
            id === 'price_basic' ? 500 : id === 'price_premium' ? 30000 : 50,
          billing_scheme: 'per_unit',
          recurring: {
            interval: 'month',
            interval_count: 1,
            usage_type: id === 'price_overage' ? 'metered' : 'licensed',
            meter: id === 'price_overage' ? 'mtr_fixture' : null,
          },
        }),
      ),
    },
    customers: {
      create: jest.fn(() =>
        Promise.resolve({ id: `cus_${companyId.toString()}`, livemode: false }),
      ),
    },
    checkout: {
      sessions: {
        create: jest.fn((params: Stripe.Checkout.SessionCreateParams) => {
          const s = {
            id: `cs_${sessions.size}`,
            ...params,
            status: 'open',
            livemode: false,
            url: 'https://checkout.stripe.test/session',
            setup_intent: 'seti_fixture',
          } as Stripe.Checkout.Session;
          sessions.set(s.id, s);
          return Promise.resolve(s);
        }),
        retrieve: jest.fn((id: string) => Promise.resolve(sessions.get(id)!)),
      },
    },
    setupIntents: {
      retrieve: jest.fn(() =>
        Promise.resolve({
          id: 'seti_fixture',
          livemode: false,
          status: 'succeeded',
          customer: sub.stripeCustomerId,
          payment_method: 'pm_fixture',
        }),
      ),
    },
    subscriptions: {
      create: jest.fn((params: Stripe.SubscriptionCreateParams) => {
        const s = {
          ...params,
          id: `sub_${remote.size}`,
          livemode: false,
          status: 'active',
          cancel_at_period_end: false,
          latest_invoice: null,
          items: {
            data: params.items!.map((item, index) => ({
              id: `si_${index}`,
              price: { id: item.price },
              quantity: item.quantity,
              current_period_start: Math.floor(Date.now() / 1000),
              current_period_end: Math.floor(
                billingPeriod(sub.activatedAt, new Date()).endsAt.getTime() /
                  1000,
              ),
            })),
          },
        } as unknown as Stripe.Subscription;
        remote.set(s.id, s);
        return Promise.resolve(s);
      }),
      cancel: jest.fn((id: string) => {
        const subscription = remote.get(id)!;
        subscription.status = 'canceled';
        subscription.cancel_at_period_end = false;
        return Promise.resolve(subscription);
      }),
      retrieve: jest.fn((id: string) => Promise.resolve(remote.get(id)!)),
      update: jest.fn((id: string, params: Stripe.SubscriptionUpdateParams) => {
        const s = remote.get(id)!;
        if (params.cancel_at_period_end !== undefined)
          s.cancel_at_period_end = params.cancel_at_period_end;
        for (const item of params.items ?? []) {
          const old = s.items.data.find((entry) => entry.id === item.id);
          if (old) {
            if (item.quantity !== undefined) old.quantity = item.quantity;
            if (item.price) old.price.id = item.price;
          } else
            s.items.data.push({
              id: `si_${s.items.data.length}`,
              price: { id: item.price },
              quantity: item.quantity,
              current_period_start: Math.floor(Date.now() / 1000),
              current_period_end: Math.floor(
                billingPeriod(sub.activatedAt, new Date()).endsAt.getTime() /
                  1000,
              ),
            } as Stripe.SubscriptionItem);
        }
        return Promise.resolve(s);
      }),
    },
    subscriptionSchedules: {
      create: jest.fn((params: Stripe.SubscriptionScheduleCreateParams) => {
        remote.get(params.from_subscription!)!.schedule = 'sub_sched';
        return Promise.resolve({
          id: 'sub_sched',
          current_phase: {
            start_date: Math.floor(
              billingPeriod(sub.activatedAt, new Date()).startsAt.getTime() /
                1000,
            ),
            end_date: Math.floor(
              billingPeriod(sub.activatedAt, new Date()).endsAt.getTime() /
                1000,
            ),
          },
        });
      }),
      retrieve: jest.fn(() =>
        Promise.resolve({
          id: 'sub_sched',
          current_phase: {
            start_date: Math.floor(
              billingPeriod(sub.activatedAt, new Date()).startsAt.getTime() /
                1000,
            ),
            end_date: Math.floor(
              billingPeriod(sub.activatedAt, new Date()).endsAt.getTime() /
                1000,
            ),
          },
        }),
      ),
      update: jest.fn(() => Promise.resolve({ id: 'sub_sched' })),
      release: jest.fn((id: string) => {
        for (const subscription of remote.values())
          if (subscription.schedule === id) subscription.schedule = null;
        return Promise.resolve({ id });
      }),
    },
    invoices: {
      list: jest.fn((params: Stripe.InvoiceListParams) =>
        Promise.resolve({
          data: invoices.filter(
            (invoice) =>
              invoice.customer === params.customer &&
              (!params.status || invoice.status === params.status),
          ),
          has_more: false,
        }),
      ),
      update: jest.fn((id: string, params: Stripe.InvoiceUpdateParams) => {
        const invoice = invoices.find((entry) => entry.id === id)!;
        Object.assign(invoice, params, {
          metadata: { ...invoice.metadata, ...params.metadata },
        });
        return Promise.resolve(invoice);
      }),
      listLineItems: jest.fn(() =>
        Promise.resolve({
          data: [] as Stripe.InvoiceLineItem[],
          has_more: false,
        }),
      ),
      updateLineItem: jest.fn(() => Promise.resolve({})),
    },
    billing: {
      meters: {
        retrieve: jest.fn(() =>
          Promise.resolve({
            id: 'mtr_fixture',
            livemode: false,
            status: 'active',
            event_name: paymentConfig.STRIPE_OVERAGE_EVENT_NAME,
            default_aggregation: { formula: 'sum' },
            customer_mapping: { event_payload_key: 'stripe_customer_id' },
            value_settings: { event_payload_key: 'value' },
          }),
        ),
        listEventSummaries: jest.fn(() =>
          Promise.resolve({ data: [] as { aggregated_value: number }[] }),
        ),
      },
      meterEvents: {
        create: jest.fn((params: Stripe.Billing.MeterEventCreateParams) =>
          Promise.resolve({ ...params, livemode: false }),
        ),
      },
    },
    billingPortal: {
      configurations: {
        retrieve: jest.fn(() =>
          Promise.resolve({
            id: 'bpc_fixture',
            active: true,
            livemode: false,
            features: {
              payment_method_update: { enabled: true },
              invoice_history: { enabled: true },
              subscription_update: { enabled: false },
              subscription_cancel: { enabled: false },
            },
          }),
        ),
      },
      sessions: {
        create: jest.fn(() =>
          Promise.resolve({ url: 'https://billing.stripe.test/portal' }),
        ),
      },
    },
  };
  const transaction = jest.fn(
    async (work: (session: unknown) => Promise<unknown>) => {
      const before = sub.toObject() as unknown as Row;
      const eventCount = events.length;
      try {
        return await work({ fixture: true });
      } catch (error) {
        for (const key of Object.keys(sub.toObject())) sub.set(key, undefined);
        sub.set(before);
        events.splice(eventCount);
        throw error;
      }
    },
  );
  const client = { enabled: true, api: api as unknown as Stripe };
  const config = new ConfigService(paymentConfig);
  const plans = { findOne: (code: PlanCode) => PLAN_CATALOG[code] };
  const service = new PaymentsService(
    client,
    config,
    plans as PlansService,
    subModel as unknown as Model<Subscription>,
    periodModel as never,
    userModel as never,
    invitationModel as never,
    eventModel as never,
    usageModel as never,
    { transaction } as unknown as Connection,
    memory(files) as never,
  );
  const event = (
    type = 'customer.subscription.updated',
    id = `evt_${events.length}`,
    object?: unknown,
  ) =>
    ({
      id,
      type,
      livemode: false,
      api_version: STRIPE_API_VERSION,
      data: { object: object ?? { id: sub.stripeSubscriptionId } },
      created: Math.floor(Date.now() / 1000),
    }) as Stripe.Event;
  const signed = (e: Stripe.Event) => {
    const body = Buffer.from(JSON.stringify(e));
    return {
      body,
      signature: sdk.webhooks.generateTestHeaderString({
        payload: body.toString(),
        secret: paymentConfig.STRIPE_WEBHOOK_SECRET,
      }),
    };
  };
  const deliver = (e: Stripe.Event) => {
    const { body, signature } = signed(e);
    return service.webhook(body, signature);
  };
  const activate = async (code = PlanCode.PREMIUM) => {
    await service.checkout(owner, code);
    const checkout = sessions.get(sub.stripeCheckoutSessionId!)!;
    checkout.status = 'complete';
    await deliver(
      event('checkout.session.completed', 'evt_checkout', { id: checkout.id }),
    );
    return remote.get(sub.stripeSubscriptionId!)!;
  };
  const addEmployees = (n: number) => {
    for (let i = 0; i < n; i++)
      users.push({
        _id: new Types.ObjectId(),
        companyId,
        role: Role.COMPANY_MEMBER,
      });
  };
  const addPending = (n: number) => {
    for (let i = 0; i < n; i++)
      invitations.push({
        companyId,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 86400000),
      });
  };
  return {
    service,
    api,
    client,
    config,
    owner,
    member,
    other,
    sub,
    subModel,
    users,
    invitations,
    periods,
    files,
    usages,
    events,
    sessions,
    remote,
    invoices,
    userModel,
    usageModel,
    eventModel,
    transaction,
    event,
    signed,
    deliver,
    activate,
    addEmployees,
    addPending,
    PaymentAccess,
  };
}
