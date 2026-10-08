import { ClientSession, Connection, Types } from 'mongoose';
import { InvitationStatus } from '../invitations/entities/employee-invitation.entity';
import { PaymentAccess, PaymentSyncIssue } from '../payments/payment.constants';
import { PlanCode } from '../plans/plan.constants';
import { CliFailureCategory } from './cli-errors';
import {
  StripeResetCollections,
  StripeResetOptions,
  StripeResetRecord,
  StripeResetRefusalReason,
  StripeTestStateReset,
  assertStripeTestKeyForExecution,
  stripeResetArguments,
} from './reset-stripe-test.service';

function matches(row: StripeResetRecord, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, expected]) => {
    const value = row[key];
    if (expected instanceof Types.ObjectId)
      return value instanceof Types.ObjectId && value.equals(expected);
    if (expected instanceof Date)
      return value instanceof Date && value.getTime() === expected.getTime();
    if (expected && typeof expected === 'object' && '$exists' in expected)
      return (value !== undefined) === expected.$exists;
    if (expected && typeof expected === 'object' && '$gt' in expected)
      return (
        value instanceof Date &&
        expected.$gt instanceof Date &&
        value > expected.$gt
      );
    if (expected && typeof expected === 'object' && '$in' in expected)
      return (expected.$in as unknown[]).some((item) =>
        item instanceof RegExp
          ? typeof value === 'string' && item.test(value)
          : item instanceof Types.ObjectId
            ? value instanceof Types.ObjectId && value.equals(item)
            : value === item,
      );
    return value === expected;
  });
}

function fixture() {
  const companyId = new Types.ObjectId();
  const otherId = new Types.ObjectId();
  const activatedAt = new Date('2026-08-31T10:00:00.000Z');
  const subscription: StripeResetRecord = {
    _id: new Types.ObjectId(),
    companyId,
    planCode: PlanCode.FREE,
    activatedAt,
    planChangedAt: activatedAt,
    revision: 4,
    stripeManaged: false,
    stripeCustomerId: 'cus_oldFixture123',
    stripeCustomerAttemptAt: new Date('2026-09-01T00:00:00.000Z'),
    stripeCheckoutOperation: 'fixture-operation',
    stripeCheckoutPlan: PlanCode.BASIC,
    paymentAccess: PaymentAccess.UNMANAGED,
    paymentSyncIssue: PaymentSyncIssue.RETRY_REQUIRED,
    stripeCancelAtPeriodEnd: false,
    stripePlanConfirmed: false,
  };
  const otherSubscription: StripeResetRecord = {
    ...subscription,
    _id: new Types.ObjectId(),
    companyId: otherId,
    stripeCustomerId: 'cus_otherFixture456',
  };
  const rows: Record<keyof StripeResetCollections, StripeResetRecord[]> = {
    companies: [{ _id: companyId }, { _id: otherId }],
    subscriptions: [subscription, otherSubscription],
    stripeEvents: [],
    stripeUsage: [],
    users: [{ _id: new Types.ObjectId(), companyId, role: 'company_owner' }],
    invitations: [],
    periods: [],
  };
  const updateCalls: Array<keyof StripeResetCollections> = [];
  const readCalls: Array<keyof StripeResetCollections> = [];
  const collections = Object.fromEntries(
    (Object.keys(rows) as Array<keyof StripeResetCollections>).map((key) => [
      key,
      {
        findOne: jest.fn((filter: Record<string, unknown>) => {
          readCalls.push(key);
          return Promise.resolve(
            rows[key].find((row) => matches(row, filter)) ?? null,
          );
        }),
        find: jest.fn((filter: Record<string, unknown>) => ({
          toArray: () => {
            readCalls.push(key);
            return Promise.resolve(
              rows[key].filter((row) => matches(row, filter)),
            );
          },
        })),
        countDocuments: jest.fn((filter: Record<string, unknown>) => {
          readCalls.push(key);
          return Promise.resolve(
            rows[key].filter((row) => matches(row, filter)).length,
          );
        }),
        updateOne: jest.fn(
          (
            filter: Record<string, unknown>,
            update: Record<string, Record<string, unknown>>,
          ) => {
            updateCalls.push(key);
            const target = rows[key].find((row) => matches(row, filter));
            if (!target)
              return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
            for (const field of Object.keys(update.$unset ?? {}))
              delete target[field];
            Object.assign(target, update.$set);
            for (const [field, increment] of Object.entries(update.$inc ?? {}))
              target[field] = Number(target[field]) + Number(increment);
            return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
          },
        ),
      },
    ]),
  ) as unknown as StripeResetCollections;
  const transaction = jest.fn(
    (work: (session: ClientSession) => Promise<unknown>) =>
      work({} as ClientSession),
  );
  const service = new StripeTestStateReset(
    { transaction } as unknown as Connection,
    collections,
    () => new Date('2026-09-15T10:00:00.000Z'),
  );
  const options: StripeResetOptions = {
    companyId: companyId.toHexString(),
    environment: 'development',
    execute: false,
    confirmReset: false,
    confirmAppStopped: false,
    confirmOldStripeQuiescent: false,
    recoverUnmanagedBasic: false,
    confirmTransitionToFree: false,
  };
  const execute: StripeResetOptions = {
    ...options,
    execute: true,
    expectedRevision: 4,
    confirmReset: true,
    confirmAppStopped: true,
    confirmOldStripeQuiescent: true,
    recoverUnmanagedBasic: false,
    confirmTransitionToFree: false,
  };
  return {
    service,
    rows,
    collections,
    subscription,
    otherSubscription,
    activatedAt,
    updateCalls,
    readCalls,
    options,
    execute,
  };
}

function basicRecoveryFixture() {
  const f = fixture();
  Object.assign(f.subscription, {
    planCode: PlanCode.BASIC,
    revision: 12,
    stripeCheckoutSessionId: 'cs_test_fixture123',
    stripeCheckoutPlan: PlanCode.PREMIUM,
    stripeCheckoutOperation: '48bea95a-3f15-47a9-b5e5-c52c3aed3bc5',
    stripeCheckoutAttemptAt: new Date('2026-09-10T10:00:00.000Z'),
    stripeNextSyncAt: new Date('2026-09-15T11:00:00.000Z'),
  });
  f.rows.periods.push({
    _id: new Types.ObjectId(),
    companyId: f.subscription.companyId,
    startsAt: new Date('2026-08-31T10:00:00.000Z'),
    endsAt: new Date('2026-09-30T10:00:00.000Z'),
    uploadedFiles: 3,
    fileOverageCents: 0,
  });
  return {
    ...f,
    options: { ...f.options, recoverUnmanagedBasic: true },
    execute: {
      ...f.execute,
      expectedRevision: 12,
      recoverUnmanagedBasic: true,
      confirmTransitionToFree: true,
    },
  };
}

describe('Stripe Test Mode mapping reset', () => {
  it('dry-runs the exact Free company without modifying any record', async () => {
    const f = fixture();
    const original = JSON.stringify(f.rows);
    await expect(f.service.run(f.options)).resolves.toMatchObject({
      mode: 'dry_run',
      eligible: true,
      revision: 4,
      planCode: PlanCode.FREE,
      stripeEvents: 0,
      stripeUsage: 0,
      updated: false,
    });
    expect(JSON.stringify(f.rows)).toBe(original);
    expect(f.updateCalls).toEqual([]);
  });

  it('refuses production and incomplete destructive confirmation before querying', async () => {
    const f = fixture();
    await expect(
      f.service.run({ ...f.options, environment: 'production' }),
    ).rejects.toMatchObject({
      reason: StripeResetRefusalReason.PRODUCTION,
    });
    await expect(
      f.service.run({ ...f.execute, confirmAppStopped: false }),
    ).rejects.toMatchObject({
      reason: StripeResetRefusalReason.CONFIRMATION,
    });
    await expect(
      f.service.run({ ...f.execute, confirmOldStripeQuiescent: false }),
    ).rejects.toMatchObject({
      reason: StripeResetRefusalReason.CONFIRMATION,
    });
    expect(f.readCalls).toEqual([]);
  });

  it('rejects invalid, duplicated, or unknown CLI arguments', () => {
    expect(() => stripeResetArguments([], 'development')).toThrow();
    expect(() =>
      stripeResetArguments(['--company-id', 'invalid'], 'development'),
    ).toThrow();
    expect(() =>
      stripeResetArguments(
        ['--company-id', new Types.ObjectId().toHexString(), '--execute'],
        'development',
      ),
    ).toThrow();
    expect(() =>
      stripeResetArguments(
        ['--company-id', new Types.ObjectId().toHexString(), '--unknown'],
        'development',
      ),
    ).toThrow();
    expect(() =>
      stripeResetArguments(
        [
          '--company-id',
          new Types.ObjectId().toHexString(),
          '--company-id',
          'x',
        ],
        'development',
      ),
    ).toThrow();
    expect(() =>
      stripeResetArguments(
        [
          '--company-id',
          new Types.ObjectId().toHexString(),
          '--expected-revision',
          '-1',
        ],
        'development',
      ),
    ).toThrow();
  });

  it('requires a Test Mode secret key for execution without disclosing it', () => {
    expect(() =>
      assertStripeTestKeyForExecution('sk_test_fixture123'),
    ).not.toThrow();
    for (const value of [undefined, '', 'sk_live_fixture123', 'sk_test_']) {
      expect(() => assertStripeTestKeyForExecution(value)).toThrow(
        CliFailureCategory.INVALID_STRIPE_RESET_ARGUMENTS,
      );
    }
  });

  it('resets only the stale mapping and preserves the Free plan, billing anchor, and other tenant', async () => {
    const f = fixture();
    const other = JSON.stringify(f.otherSubscription);
    await expect(f.service.run(f.execute)).resolves.toMatchObject({
      mode: 'reset',
      previousRevision: 4,
      revision: 5,
      updated: true,
      fieldsCleared: expect.arrayContaining([
        'stripeCustomerId',
        'stripeCheckoutOperation',
      ]) as unknown,
    });
    expect(f.subscription).toMatchObject({
      planCode: PlanCode.FREE,
      activatedAt: f.activatedAt,
      planChangedAt: f.activatedAt,
      revision: 5,
      stripeManaged: false,
      paymentAccess: PaymentAccess.UNMANAGED,
      paymentSyncIssue: PaymentSyncIssue.NONE,
    });
    for (const field of [
      'stripeCustomerId',
      'stripeCustomerAttemptAt',
      'stripeCheckoutOperation',
      'stripeCheckoutPlan',
    ])
      expect(f.subscription[field]).toBeUndefined();
    expect(JSON.stringify(f.otherSubscription)).toBe(other);
    expect(f.updateCalls).toEqual(['subscriptions']);
  });

  it('refuses missing company and a changed revision', async () => {
    const f = fixture();
    await expect(
      f.service.run({
        ...f.options,
        companyId: new Types.ObjectId().toHexString(),
      }),
    ).rejects.toMatchObject({ reason: StripeResetRefusalReason.COMPANY });
    await expect(
      f.service.run({ ...f.execute, expectedRevision: 3 }),
    ).rejects.toMatchObject({ reason: StripeResetRefusalReason.REVISION });
    expect(f.updateCalls).toEqual([]);
  });

  it.each([
    [
      'paid plan',
      (f: ReturnType<typeof fixture>) =>
        (f.subscription.planCode = PlanCode.BASIC),
      StripeResetRefusalReason.PAID_OR_MANAGED,
    ],
    [
      'managed Free plan',
      (f: ReturnType<typeof fixture>) => (f.subscription.stripeManaged = true),
      StripeResetRefusalReason.PAID_OR_MANAGED,
    ],
    [
      'remote subscription',
      (f: ReturnType<typeof fixture>) =>
        (f.subscription.stripeSubscriptionId = 'sub_old'),
      StripeResetRefusalReason.PAID_OR_MANAGED,
    ],
    [
      'payment access',
      (f: ReturnType<typeof fixture>) =>
        (f.subscription.paymentAccess = PaymentAccess.ACTIVE),
      StripeResetRefusalReason.PAID_OR_MANAGED,
    ],
    [
      'checkout session',
      (f: ReturnType<typeof fixture>) =>
        (f.subscription.stripeCheckoutSessionId = 'cs_old'),
      StripeResetRefusalReason.IN_FLIGHT,
    ],
    [
      'checkout API attempt',
      (f: ReturnType<typeof fixture>) =>
        (f.subscription.stripeCheckoutAttemptAt = new Date()),
      StripeResetRefusalReason.IN_FLIGHT,
    ],
    [
      'meter state',
      (f: ReturnType<typeof fixture>) =>
        (f.subscription.stripeMeterStartedAt = new Date()),
      StripeResetRefusalReason.IN_FLIGHT,
    ],
    [
      'lease state',
      (f: ReturnType<typeof fixture>) =>
        (f.subscription.stripeLeaseToken = 'token'),
      StripeResetRefusalReason.IN_FLIGHT,
    ],
    [
      'queued plan',
      (f: ReturnType<typeof fixture>) =>
        (f.subscription.pendingPlanCode = PlanCode.BASIC),
      StripeResetRefusalReason.IN_FLIGHT,
    ],
    [
      'reconciliation issue',
      (f: ReturnType<typeof fixture>) =>
        (f.subscription.paymentSyncIssue =
          PaymentSyncIssue.RECONCILIATION_REQUIRED),
      StripeResetRefusalReason.IN_FLIGHT,
    ],
    [
      'unknown future field',
      (f: ReturnType<typeof fixture>) =>
        (f.subscription.stripeFutureMapping = 'future'),
      StripeResetRefusalReason.UNKNOWN_STATE,
    ],
    [
      'no old customer',
      (f: ReturnType<typeof fixture>) => {
        delete f.subscription.stripeCustomerId;
      },
      StripeResetRefusalReason.NO_MAPPING,
    ],
    [
      'event history',
      (f: ReturnType<typeof fixture>) => {
        f.rows.stripeEvents.push({
          _id: new Types.ObjectId(),
          companyId: f.subscription.companyId,
        });
      },
      StripeResetRefusalReason.HISTORY,
    ],
    [
      'usage outbox',
      (f: ReturnType<typeof fixture>) => {
        f.rows.stripeUsage.push({
          _id: new Types.ObjectId(),
          companyId: f.subscription.companyId,
        });
      },
      StripeResetRefusalReason.HISTORY,
    ],
  ])('refuses unsafe %s', async (_label, change, reason) => {
    const f = fixture();
    change(f);
    await expect(f.service.run(f.options)).rejects.toMatchObject({ reason });
    expect(f.updateCalls).toEqual([]);
  });

  it('refuses malformed subscription multiplicity and failed conditional writes', async () => {
    const f = fixture();
    f.rows.subscriptions.push({ ...f.subscription, _id: new Types.ObjectId() });
    await expect(f.service.run(f.options)).rejects.toMatchObject({
      reason: StripeResetRefusalReason.SUBSCRIPTION,
    });
    f.rows.subscriptions.pop();
    jest.spyOn(f.collections.subscriptions, 'updateOne').mockResolvedValueOnce({
      matchedCount: 0,
      modifiedCount: 0,
    } as never);
    await expect(f.service.run(f.execute)).rejects.toMatchObject({
      category: CliFailureCategory.STRIPE_RESET_COUNT_MISMATCH,
    });
  });
});

describe('unmanaged Basic checkout recovery', () => {
  it('requires the explicit Basic recovery mode and Free-transition confirmation in CLI arguments', () => {
    const id = new Types.ObjectId().toHexString();
    expect(
      stripeResetArguments(
        ['--company-id', id, '--recover-unmanaged-basic'],
        'development',
      ),
    ).toMatchObject({
      recoverUnmanagedBasic: true,
      execute: false,
    });
    expect(() =>
      stripeResetArguments(
        [
          '--company-id',
          id,
          '--recover-unmanaged-basic',
          '--expected-revision',
          '12',
          '--execute',
          '--confirm-reset',
          '--confirm-app-stopped',
          '--confirm-old-stripe-quiescent',
        ],
        'development',
      ),
    ).toThrow();
  });

  it('dry-runs the exact stale Basic shape and retains all records', async () => {
    const f = basicRecoveryFixture();
    const original = JSON.stringify(f.rows);
    await expect(f.service.run(f.options)).resolves.toMatchObject({
      mode: 'dry_run_basic_recovery',
      fromPlan: PlanCode.BASIC,
      toPlan: PlanCode.FREE,
      revision: 12,
      acceptedEmployees: 0,
      pendingInvitations: 0,
      successfulUploads: 3,
      updated: false,
    });
    expect(JSON.stringify(f.rows)).toBe(original);
    expect(f.updateCalls).toEqual([]);
  });

  it('requires production refusal and separate confirmation of the Free transition', async () => {
    const f = basicRecoveryFixture();
    await expect(
      f.service.run({ ...f.options, environment: 'production' }),
    ).rejects.toMatchObject({ reason: StripeResetRefusalReason.PRODUCTION });
    await expect(
      f.service.run({ ...f.execute, confirmTransitionToFree: false }),
    ).rejects.toMatchObject({ reason: StripeResetRefusalReason.CONFIRMATION });
    expect(f.readCalls).toEqual([]);
  });

  it('transitions only this subscription to Free while retaining anchors and authoritative data', async () => {
    const f = basicRecoveryFixture();
    const other = JSON.stringify(f.otherSubscription);
    const users = JSON.stringify(f.rows.users);
    const invitations = JSON.stringify(f.rows.invitations);
    const periods = JSON.stringify(f.rows.periods);
    await expect(f.service.run(f.execute)).resolves.toMatchObject({
      mode: 'recovered_unmanaged_basic',
      fromPlan: PlanCode.BASIC,
      toPlan: PlanCode.FREE,
      previousRevision: 12,
      revision: 13,
      updated: true,
    });
    expect(f.subscription).toMatchObject({
      planCode: PlanCode.FREE,
      revision: 13,
      activatedAt: f.activatedAt,
      paymentAccess: PaymentAccess.UNMANAGED,
      paymentSyncIssue: PaymentSyncIssue.NONE,
      stripeManaged: false,
    });
    expect(f.subscription.planChangedAt).toEqual(
      new Date('2026-09-15T10:00:00.000Z'),
    );
    for (const field of [
      'stripeCustomerId',
      'stripeCheckoutSessionId',
      'stripeCheckoutOperation',
      'stripeCheckoutPlan',
      'stripeNextSyncAt',
    ])
      expect(f.subscription[field]).toBeUndefined();
    expect(JSON.stringify(f.otherSubscription)).toBe(other);
    expect(JSON.stringify(f.rows.users)).toBe(users);
    expect(JSON.stringify(f.rows.invitations)).toBe(invitations);
    expect(JSON.stringify(f.rows.periods)).toBe(periods);
    expect(f.updateCalls).toEqual(['subscriptions']);
  });

  it('refuses revision changes and failed conditional writes without changing data', async () => {
    const f = basicRecoveryFixture();
    await expect(
      f.service.run({ ...f.execute, expectedRevision: 11 }),
    ).rejects.toMatchObject({ reason: StripeResetRefusalReason.REVISION });
    expect(f.updateCalls).toEqual([]);
    jest.spyOn(f.collections.subscriptions, 'updateOne').mockResolvedValueOnce({
      matchedCount: 0,
      modifiedCount: 0,
    } as never);
    await expect(f.service.run(f.execute)).rejects.toMatchObject({
      category: CliFailureCategory.STRIPE_RESET_COUNT_MISMATCH,
    });
    expect(f.subscription.planCode).toBe(PlanCode.BASIC);
  });

  it.each([
    [
      'Stripe-managed',
      (f: ReturnType<typeof basicRecoveryFixture>) => {
        f.subscription.stripeManaged = true;
      },
      StripeResetRefusalReason.BASIC_RECOVERY_STATE,
    ],
    [
      'paid access',
      (f: ReturnType<typeof basicRecoveryFixture>) => {
        f.subscription.paymentAccess = PaymentAccess.ACTIVE;
      },
      StripeResetRefusalReason.BASIC_RECOVERY_STATE,
    ],
    [
      'confirmed plan',
      (f: ReturnType<typeof basicRecoveryFixture>) => {
        f.subscription.stripePlanConfirmed = true;
      },
      StripeResetRefusalReason.BASIC_RECOVERY_STATE,
    ],
    [
      'subscription ID',
      (f: ReturnType<typeof basicRecoveryFixture>) => {
        f.subscription.stripeSubscriptionId = 'sub_old';
      },
      StripeResetRefusalReason.BASIC_RECOVERY_STATE,
    ],
    [
      'non-test checkout session',
      (f: ReturnType<typeof basicRecoveryFixture>) => {
        f.subscription.stripeCheckoutSessionId = 'cs_live_fixture123';
      },
      StripeResetRefusalReason.BASIC_RECOVERY_STATE,
    ],
    [
      'subscription creation attempt',
      (f: ReturnType<typeof basicRecoveryFixture>) => {
        f.subscription.stripeSubscriptionAttemptAt = new Date();
      },
      StripeResetRefusalReason.BASIC_RECOVERY_STATE,
    ],
    [
      'accepted employee',
      (f: ReturnType<typeof basicRecoveryFixture>) => {
        f.rows.users.push({
          _id: new Types.ObjectId(),
          companyId: f.subscription.companyId,
          role: 'company_member',
        });
      },
      StripeResetRefusalReason.ACCOUNT,
    ],
    [
      'pending invitation',
      (f: ReturnType<typeof basicRecoveryFixture>) => {
        f.rows.invitations.push({
          _id: new Types.ObjectId(),
          companyId: f.subscription.companyId,
          status: InvitationStatus.PENDING,
          expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        });
      },
      StripeResetRefusalReason.FREE_CAPACITY,
    ],
    [
      'too many current uploads',
      (f: ReturnType<typeof basicRecoveryFixture>) => {
        f.rows.periods[0].uploadedFiles = 11;
      },
      StripeResetRefusalReason.FREE_CAPACITY,
    ],
    [
      'existing overage',
      (f: ReturnType<typeof basicRecoveryFixture>) => {
        f.rows.periods[0].fileOverageCents = 50;
      },
      StripeResetRefusalReason.PERIOD,
    ],
    [
      'Stripe event history',
      (f: ReturnType<typeof basicRecoveryFixture>) => {
        f.rows.stripeEvents.push({
          _id: new Types.ObjectId(),
          companyId: f.subscription.companyId,
        });
      },
      StripeResetRefusalReason.HISTORY,
    ],
    [
      'Stripe usage outbox',
      (f: ReturnType<typeof basicRecoveryFixture>) => {
        f.rows.stripeUsage.push({
          _id: new Types.ObjectId(),
          companyId: f.subscription.companyId,
        });
      },
      StripeResetRefusalReason.HISTORY,
    ],
  ])('refuses unsafe %s', async (_label, change, reason) => {
    const f = basicRecoveryFixture();
    change(f);
    await expect(f.service.run(f.options)).rejects.toMatchObject({ reason });
    expect(f.updateCalls).toEqual([]);
  });
});
