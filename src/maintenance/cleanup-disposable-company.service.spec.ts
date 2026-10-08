import { Connection, Types } from 'mongoose';
import { Role } from '../enums/roles.enum';
import { PlanCode } from '../plans/plan.constants';
import { CliFailureCategory } from './cli-errors';
import {
  CleanupCollections,
  CleanupOptions,
  CleanupRefusalReason,
  DisposableCompanyCleanup,
  StoredRecord,
  cleanupArguments,
} from './cleanup-disposable-company.service';

const keys: (keyof CleanupCollections)[] = [
  'companies',
  'users',
  'subscriptions',
  'verifications',
  'files',
  'invitations',
  'periods',
  'stripeEvents',
  'stripeUsage',
  'aiConversations',
  'aiMessages',
  'aiUsage',
  'audits',
];
function match(row: StoredRecord, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or')
      return (expected as Record<string, unknown>[]).some((clause) =>
        match(row, clause),
      );
    const value = row[key];
    if (expected instanceof Types.ObjectId)
      return value instanceof Types.ObjectId && value.equals(expected);
    if (expected instanceof RegExp)
      return typeof value === 'string' && expected.test(value);
    if (expected && typeof expected === 'object') {
      const operators = expected as Record<string, unknown>;
      if (operators.$in)
        return (operators.$in as unknown[]).some((entry) =>
          match(row, { [key]: entry }),
        );
      if (operators.$type === 'null') return value === null;
      throw new Error('Unsupported cleanup test operator');
    }
    return value === expected;
  });
}
function fixture() {
  const companyId = new Types.ObjectId(),
    ownerId = new Types.ObjectId();
  const timestamp = new Date('2026-09-18T12:00:00.000Z');
  const stamp = { createdAt: timestamp, updatedAt: timestamp, __v: 0 };
  const rows: Record<keyof CleanupCollections, StoredRecord[]> = {
    companies: [],
    users: [],
    subscriptions: [],
    verifications: [],
    files: [],
    invitations: [],
    periods: [],
    stripeEvents: [],
    stripeUsage: [],
    aiConversations: [],
    aiMessages: [],
    aiUsage: [],
    audits: [],
  };
  rows.companies.push({
    _id: companyId,
    name: 'Disposable test',
    country: 'US',
    industry: 'Software',
    activatedAt: null,
    platformStatus: 'active',
    ...stamp,
  });
  rows.users.push({
    _id: ownerId,
    companyId,
    email: 'unreachable@fixture.test',
    password: 'secret-hash',
    role: Role.COMPANY_OWNER,
    ...stamp,
  });
  rows.subscriptions.push({
    _id: new Types.ObjectId(),
    companyId,
    planCode: PlanCode.FREE,
    activatedAt: timestamp,
    planChangedAt: timestamp,
    revision: 0,
    stripeManaged: false,
    paymentAccess: 'unmanaged',
    paymentSyncIssue: 'none',
    stripeCancelAtPeriodEnd: false,
    stripePlanConfirmed: false,
    ...stamp,
  });
  rows.verifications.push({
    _id: new Types.ObjectId(),
    companyId,
    ownerId,
    tokenHash: 'secret-token-hash',
    expiresAt: timestamp,
    lastSentAt: timestamp,
    ...stamp,
  });
  const mocks = Object.fromEntries(
    keys.map((key) => [
      key,
      {
        findOne: jest.fn((filter: Record<string, unknown>) =>
          Promise.resolve(rows[key].find((row) => match(row, filter)) ?? null),
        ),
        find: jest.fn(
          (
            filter: Record<string, unknown>,
            options?: { projection?: Record<string, number> },
          ) => ({
            toArray: () =>
              Promise.resolve(
                rows[key]
                  .filter((row) => match(row, filter))
                  .map(
                    (row) =>
                      Object.fromEntries(
                        Object.entries(row).filter(
                          ([field]) => options?.projection?.[field] !== 0,
                        ),
                      ) as StoredRecord,
                  ),
              ),
          }),
        ),
        countDocuments: jest.fn((filter: Record<string, unknown>) =>
          Promise.resolve(rows[key].filter((row) => match(row, filter)).length),
        ),
        deleteOne: jest.fn((filter: Record<string, unknown>) => {
          const index = rows[key].findIndex((row) => match(row, filter));
          if (index < 0) return Promise.resolve({ deletedCount: 0 });
          rows[key].splice(index, 1);
          return Promise.resolve({ deletedCount: 1 });
        }),
        deleteMany: jest.fn((filter: Record<string, unknown>) => {
          const removed = rows[key].filter((row) => match(row, filter));
          rows[key] = rows[key].filter((row) => !match(row, filter));
          return Promise.resolve({ deletedCount: removed.length });
        }),
      },
    ]),
  ) as Record<
    keyof CleanupCollections,
    {
      findOne: jest.Mock;
      find: jest.Mock;
      countDocuments: jest.Mock;
      deleteOne: jest.Mock;
      deleteMany: jest.Mock;
    }
  >;
  const session = {};
  const connection = {
    transaction: jest.fn(
      async (work: (session: object) => Promise<unknown>) => {
        const snapshot = Object.fromEntries(
          keys.map((key) => [key, rows[key].map((row) => ({ ...row }))]),
        ) as typeof rows;
        try {
          return await work(session);
        } catch (error) {
          for (const key of keys) rows[key] = snapshot[key];
          throw error;
        }
      },
    ),
  };
  const service = new DisposableCompanyCleanup(
    connection as unknown as Connection,
    mocks as unknown as CleanupCollections,
  );
  const options: CleanupOptions = {
    companyId: companyId.toHexString(),
    environment: 'development',
    confirmDisposable: false,
    confirmApplicationStopped: false,
  };
  return {
    rows,
    mocks,
    service,
    options,
    companyId,
    ownerId,
    session,
    connection,
  };
}

describe('disposable unactivated company cleanup', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
  });
  const noDeletes = () => {
    for (const key of keys) {
      expect(f.mocks[key].deleteOne).not.toHaveBeenCalled();
      expect(f.mocks[key].deleteMany).not.toHaveBeenCalled();
    }
  };
  it('defaults to a consistent read-only dry run with safe counts, never reading hashes', async () => {
    const before = JSON.stringify(f.rows);
    const report = await f.service.run(f.options);
    expect(report).toMatchObject({
      mode: 'dry_run',
      eligible: true,
      deleted: null,
      matched: {
        companies: 1,
        ownerUsers: 1,
        freeSubscriptions: 1,
        verificationRecords: 1,
      },
    });
    expect(JSON.stringify(report)).not.toMatch(
      /secret|fixture.test|password|tokenHash/,
    );
    expect(f.mocks.users.find).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projection: { password: 0 },
        session: f.session,
      }),
    );
    expect(f.mocks.verifications.find).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projection: { tokenHash: 0 },
        session: f.session,
      }),
    );
    expect(JSON.stringify(f.rows)).toBe(before);
    noDeletes();
  });
  it('deletes only exact signup records transactionally and leaves another company and unrelated audit history intact', async () => {
    const otherId = new Types.ObjectId();
    for (const key of [
      'companies',
      'users',
      'subscriptions',
      'verifications',
    ] as const)
      f.rows[key].push({
        ...f.rows[key][0],
        _id: key === 'companies' ? otherId : new Types.ObjectId(),
        companyId: otherId,
        ownerId: new Types.ObjectId(),
      });
    f.rows.audits.push({
      _id: new Types.ObjectId(),
      targetId: otherId,
      action: 'company_suspended',
    });
    const report = await f.service.run({
      ...f.options,
      confirmDisposable: true,
      confirmApplicationStopped: true,
    });
    expect(report).toMatchObject({
      mode: 'deleted',
      deleted: {
        companies: 1,
        ownerUsers: 1,
        freeSubscriptions: 1,
        verificationRecords: 1,
      },
    });
    for (const key of [
      'companies',
      'users',
      'subscriptions',
      'verifications',
    ] as const)
      expect(f.rows[key]).toHaveLength(1);
    expect(f.rows.audits).toHaveLength(1);
    for (const key of [
      'files',
      'invitations',
      'periods',
      'stripeEvents',
      'stripeUsage',
      'aiConversations',
      'aiMessages',
      'aiUsage',
      'audits',
    ] as const)
      expect(f.mocks[key].deleteMany).not.toHaveBeenCalled();
    expect(f.connection.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      }),
    );
  });
  it('allows an already TTL-expired verification record to be absent', async () => {
    f.rows.verifications.splice(0);
    expect(
      (
        await f.service.run({
          ...f.options,
          confirmDisposable: true,
          confirmApplicationStopped: true,
        })
      ).deleted?.verificationRecords,
    ).toBe(0);
  });
  it.each(['production', undefined, '', 'staging'])(
    'refuses an unsafe or unspecified environment before querying (%s)',
    async (environment) => {
      await expect(
        f.service.run({ ...f.options, environment }),
      ).rejects.toMatchObject({
        reason: CleanupRefusalReason.PRODUCTION_ENVIRONMENT,
      });
      expect(f.connection.transaction).not.toHaveBeenCalled();
      noDeletes();
    },
  );
  it('requires offline confirmation for deletion', async () => {
    await expect(
      f.service.run({ ...f.options, confirmDisposable: true }),
    ).rejects.toMatchObject({
      reason: CleanupRefusalReason.MAINTENANCE_NOT_CONFIRMED,
    });
    noDeletes();
  });
  const cases: [
    string,
    (f: ReturnType<typeof fixture>) => void,
    CleanupRefusalReason,
  ][] = [
    [
      'activated',
      (f) => {
        f.rows.companies[0].activatedAt = new Date();
      },
      CleanupRefusalReason.ACTIVATED,
    ],
    [
      'missing activation marker',
      (f) => {
        delete f.rows.companies[0].activatedAt;
      },
      CleanupRefusalReason.ACTIVATED,
    ],
    [
      'suspended',
      (f) => {
        f.rows.companies[0].platformStatus = 'suspended';
      },
      CleanupRefusalReason.PLATFORM_HISTORY,
    ],
    [
      'reactivated history',
      (f) => {
        f.rows.companies[0].platformStatusReason = 'review_completed';
      },
      CleanupRefusalReason.PLATFORM_HISTORY,
    ],
    [
      'changed company',
      (f) => {
        f.rows.companies[0].updatedAt = new Date();
      },
      CleanupRefusalReason.HISTORY,
    ],
    [
      'unknown company state',
      (f) => {
        f.rows.companies[0].customBillingData = 'secret';
      },
      CleanupRefusalReason.HISTORY,
    ],
    [
      'missing owner',
      (f) => {
        f.rows.users.splice(0);
      },
      CleanupRefusalReason.USERS,
    ],
    [
      'accepted employee',
      (f) => {
        f.rows.users.push({
          ...f.rows.users[0],
          _id: new Types.ObjectId(),
          role: Role.COMPANY_MEMBER,
        });
      },
      CleanupRefusalReason.USERS,
    ],
    [
      'changed owner',
      (f) => {
        f.rows.users[0].updatedAt = new Date();
      },
      CleanupRefusalReason.USERS,
    ],
    [
      'OAuth evidence',
      (f) => {
        f.rows.users[0].avatar = 'avatar';
      },
      CleanupRefusalReason.USERS,
    ],
    [
      'string owner relationship',
      (f) => {
        f.rows.users[0].companyId = f.companyId.toHexString();
      },
      CleanupRefusalReason.USERS,
    ],
    [
      'missing subscription',
      (f) => {
        f.rows.subscriptions.splice(0);
      },
      CleanupRefusalReason.SUBSCRIPTION,
    ],
    [
      'paid plan',
      (f) => {
        f.rows.subscriptions[0].planCode = PlanCode.BASIC;
      },
      CleanupRefusalReason.SUBSCRIPTION,
    ],
    [
      'prior accounting revision',
      (f) => {
        f.rows.subscriptions[0].revision = 1;
      },
      CleanupRefusalReason.SUBSCRIPTION,
    ],
    [
      'Stripe managed',
      (f) => {
        f.rows.subscriptions[0].stripeManaged = true;
      },
      CleanupRefusalReason.SUBSCRIPTION,
    ],
    [
      'Stripe customer',
      (f) => {
        f.rows.subscriptions[0].stripeCustomerId = 'cus_test';
      },
      CleanupRefusalReason.SUBSCRIPTION,
    ],
    [
      'Stripe operation',
      (f) => {
        f.rows.subscriptions[0].stripeCheckoutOperation = 'secret-operation';
      },
      CleanupRefusalReason.SUBSCRIPTION,
    ],
    [
      'pending plan',
      (f) => {
        f.rows.subscriptions[0].pendingPlanCode = 'basic';
      },
      CleanupRefusalReason.SUBSCRIPTION,
    ],
    [
      'zero usage period',
      (f) => {
        f.rows.periods.push({
          _id: new Types.ObjectId(),
          companyId: f.companyId,
          uploadedFiles: 0,
          fileOverageCents: 0,
        });
      },
      CleanupRefusalReason.PERIODS,
    ],
    [
      'stored file',
      (f) => {
        f.rows.files.push({
          _id: new Types.ObjectId(),
          companyId: f.companyId,
        });
      },
      CleanupRefusalReason.FILES,
    ],
    [
      'legacy string file reference',
      (f) => {
        f.rows.files.push({
          _id: new Types.ObjectId(),
          companyId: f.companyId.toHexString().toUpperCase(),
        });
      },
      CleanupRefusalReason.FILES,
    ],
    [
      'cross-tenant uploader reference',
      (f) => {
        f.rows.files.push({
          _id: new Types.ObjectId(),
          companyId: new Types.ObjectId(),
          uploaderId: f.ownerId,
        });
      },
      CleanupRefusalReason.FILES,
    ],
    [
      'pending invitation',
      (f) => {
        f.rows.invitations.push({
          _id: new Types.ObjectId(),
          companyId: f.companyId,
          status: 'pending',
        });
      },
      CleanupRefusalReason.INVITATIONS,
    ],
    [
      'accepted invitation',
      (f) => {
        f.rows.invitations.push({
          _id: new Types.ObjectId(),
          companyId: f.companyId,
          status: 'accepted',
        });
      },
      CleanupRefusalReason.INVITATIONS,
    ],
    [
      'Stripe event history',
      (f) => {
        f.rows.stripeEvents.push({
          _id: new Types.ObjectId(),
          companyId: f.companyId,
        });
      },
      CleanupRefusalReason.STRIPE,
    ],
    [
      'Stripe usage history',
      (f) => {
        f.rows.stripeUsage.push({
          _id: new Types.ObjectId(),
          companyId: f.companyId,
        });
      },
      CleanupRefusalReason.STRIPE,
    ],
    [
      'AI conversation history',
      (f) => {
        f.rows.aiConversations.push({
          _id: new Types.ObjectId(),
          companyId: f.companyId,
          userId: f.ownerId,
        });
      },
      CleanupRefusalReason.AI_HISTORY,
    ],
    [
      'cross-tenant AI owner reference',
      (f) => {
        f.rows.aiUsage.push({
          _id: new Types.ObjectId(),
          companyId: new Types.ObjectId(),
          userId: f.ownerId,
        });
      },
      CleanupRefusalReason.AI_HISTORY,
    ],
    [
      'company audit history',
      (f) => {
        f.rows.audits.push({
          _id: new Types.ObjectId(),
          targetId: f.companyId,
        });
      },
      CleanupRefusalReason.PLATFORM_HISTORY,
    ],
    [
      'owner audit history',
      (f) => {
        f.rows.audits.push({ _id: new Types.ObjectId(), targetId: f.ownerId });
      },
      CleanupRefusalReason.PLATFORM_HISTORY,
    ],
    [
      'mismatched verification',
      (f) => {
        f.rows.verifications[0].ownerId = new Types.ObjectId();
      },
      CleanupRefusalReason.VERIFICATION,
    ],
    [
      'cross-tenant verification',
      (f) => {
        f.rows.verifications[0].companyId = new Types.ObjectId();
      },
      CleanupRefusalReason.VERIFICATION,
    ],
  ];
  it.each(cases)(
    'refuses %s without any deletion',
    async (_label, mutate, reason) => {
      mutate(f);
      await expect(
        f.service.run({
          ...f.options,
          confirmDisposable: true,
          confirmApplicationStopped: true,
        }),
      ).rejects.toMatchObject({ reason });
      noDeletes();
    },
  );
  it('revalidates at deletion rather than trusting a prior dry run', async () => {
    await f.service.run(f.options);
    f.rows.companies[0].activatedAt = new Date();
    await expect(
      f.service.run({
        ...f.options,
        confirmDisposable: true,
        confirmApplicationStopped: true,
      }),
    ).rejects.toMatchObject({ reason: CleanupRefusalReason.ACTIVATED });
    noDeletes();
  });
  it('rolls back all partial deletions when a count or database operation fails, with sanitized diagnostics', async () => {
    const before = JSON.stringify(f.rows);
    f.mocks.companies.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });
    await expect(
      f.service.run({
        ...f.options,
        confirmDisposable: true,
        confirmApplicationStopped: true,
      }),
    ).rejects.toMatchObject({ category: CliFailureCategory.CLEANUP_COUNTS });
    expect(JSON.stringify(f.rows)).toBe(before);
    f.mocks.subscriptions.deleteOne.mockRejectedValueOnce(
      new Error('mongodb+srv://secret:password@example.test private-token'),
    );
    await expect(
      f.service.run({
        ...f.options,
        confirmDisposable: true,
        confirmApplicationStopped: true,
      }),
    ).rejects.toThrow(CliFailureCategory.MONGO_TRANSACTION);
    expect(JSON.stringify(f.rows)).toBe(before);
  });
  it.each(
    [
      [],
      ['--company-id', 'not-an-id'],
      ['--company-id', new Types.ObjectId().toHexString(), '--force'],
      [
        '--company-id',
        new Types.ObjectId().toHexString(),
        '--confirm-app-stopped',
      ],
      [
        '--company-id',
        new Types.ObjectId().toHexString(),
        '--confirm-disposable',
        '--confirm-disposable',
      ],
    ].map((args) => [args]),
  )('rejects ambiguous/unsafe CLI arguments (%j)', (args) => {
    expect(() => cleanupArguments(args, 'development')).toThrow(
      CliFailureCategory.INVALID_CLEANUP_ARGUMENTS,
    );
  });
  it('parses an exact ID and two explicit confirmation flags without accepting selectors', () => {
    expect(
      cleanupArguments(
        [
          '--company-id',
          f.companyId.toHexString(),
          '--confirm-disposable',
          '--confirm-app-stopped',
        ],
        'development',
      ),
    ).toEqual({
      ...f.options,
      confirmDisposable: true,
      confirmApplicationStopped: true,
    });
  });
});
