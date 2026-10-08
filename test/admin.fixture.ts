import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Connection, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { AdminService } from '../src/admin/admin.service';
import { AdminAuthService } from '../src/admin/admin-auth.service';
import { platformAdminJwtOptions } from '../src/admin/admin-security';
import { CompanyPlatformStatus } from '../src/companies/platform-status';
import { Role } from '../src/enums/roles.enum';
import { CompanyFileVisibility } from '../src/files/entities/company-file.entity';
import { InvitationStatus } from '../src/invitations/entities/employee-invitation.entity';
import {
  PaymentAccess,
  PaymentSyncIssue,
} from '../src/payments/payment.constants';
import { PLAN_CATALOG, PlanCode } from '../src/plans/plan.constants';
import { PlansService } from '../src/plans/plans.service';
import { BillingService } from '../src/subscriptions/billing.service';
import { billingPeriod } from '../src/subscriptions/billing-period';
import { SubscriptionsService } from '../src/subscriptions/subscriptions.service';
import { AuthService } from '../src/auth/auth.service';
import { EmailMessage } from '../src/email/email-sender';

type Row = Record<string, unknown>;
class FixtureConfig extends ConfigService {
  constructor(private readonly values: Record<string | symbol, unknown>) {
    super(values);
  }
  override set<T = unknown>(key: string | symbol, value: T) {
    this.values[key] = value;
  }
}
const scalar = (value: unknown) =>
  value instanceof Types.ObjectId
    ? value.toString()
    : value instanceof Date
      ? value.getTime()
      : value;
const path = (row: Row, key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (value, field) =>
        value && typeof value === 'object' ? (value as Row)[field] : undefined,
      row,
    );
function expr(value: unknown, row: Row): unknown {
  if (typeof value === 'string' && value.startsWith('$'))
    return path(row, value.slice(1));
  if (
    !value ||
    typeof value !== 'object' ||
    value instanceof Date ||
    value instanceof Types.ObjectId
  )
    return value;
  const [operator, operand] = Object.entries(value as Row)[0];
  const args = Array.isArray(operand)
    ? operand.map((entry: unknown) => expr(entry, row))
    : [];
  if (operator === '$ifNull') return args[0] ?? args[1];
  if (operator === '$eq') return scalar(args[0]) === scalar(args[1]);
  if (operator === '$ne') return scalar(args[0]) !== scalar(args[1]);
  if (operator === '$lt')
    return (scalar(args[0]) as number) < (scalar(args[1]) as number);
  if (operator === '$and') return args.every(Boolean);
  if (operator === '$or') return args.some(Boolean);
  if (operator === '$cond') return args[0] ? args[1] : args[2];
  throw new Error('Unsupported fixture aggregation expression');
}
function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === '$or')
      return (expected as Row[]).some((part) => matches(row, part));
    if (field === '$and')
      return (expected as Row[]).every((part) => matches(row, part));
    if (field === '$expr') return Boolean(expr(expected, row));
    const value = path(row, field);
    if (Array.isArray(value) && !Array.isArray(expected))
      return value.some((entry) => scalar(entry) === scalar(expected));
    if (expected instanceof RegExp)
      return typeof value === 'string' && expected.test(value);
    if (expected === null) return value == null;
    if (
      expected &&
      typeof expected === 'object' &&
      !(expected instanceof Types.ObjectId) &&
      !(expected instanceof Date)
    )
      return Object.entries(expected).every(([operator, right]) => {
        if (operator === '$exists') return (value !== undefined) === right;
        if (operator === '$ne') return scalar(value) !== scalar(right);
        if (operator === '$gt')
          return (
            value !== undefined &&
            (scalar(value) as number) > (scalar(right) as number)
          );
        if (operator === '$gte')
          return (
            value !== undefined &&
            (scalar(value) as number) >= (scalar(right) as number)
          );
        if (operator === '$lt')
          return (
            value !== undefined &&
            (scalar(value) as number) < (scalar(right) as number)
          );
        if (operator === '$lte')
          return (
            value !== undefined &&
            (scalar(value) as number) <= (scalar(right) as number)
          );
        if (operator === '$in')
          return (right as unknown[]).some(
            (candidate) => scalar(candidate) === scalar(value),
          );
        throw new Error('Unsupported fixture match operator');
      });
    return scalar(value) === scalar(expected);
  });
}
function project(row: Row, projection: Row) {
  return Object.fromEntries(
    Object.entries(projection)
      .filter(([, value]) => value !== 0)
      .map(([key, value]) => [
        key,
        value === 1 ? path(row, key) : expr(value, row),
      ]),
  );
}
function aggregate(
  input: Row[],
  pipeline: Row[],
  registry: Record<string, Row[]>,
): Row[] {
  let rows = input.map((row) => ({ ...row }));
  for (const stage of pipeline) {
    if (stage.$match)
      rows = rows.filter((row) => matches(row, stage.$match as Row));
    else if (stage.$sort)
      rows.sort((a, b) => {
        for (const [field, direction] of Object.entries(stage.$sort as Row)) {
          const left = scalar(path(a, field)) as string | number;
          const right = scalar(path(b, field)) as string | number;
          if (left !== right)
            return (left < right ? -1 : 1) * Number(direction);
        }
        return 0;
      });
    else if (stage.$skip !== undefined) rows = rows.slice(Number(stage.$skip));
    else if (stage.$limit !== undefined)
      rows = rows.slice(0, Number(stage.$limit));
    else if (stage.$project)
      rows = rows.map((row) => project(row, stage.$project as Row));
    else if (stage.$count)
      rows = rows.length ? [{ [stage.$count as string]: rows.length }] : [];
    else if (stage.$lookup) {
      const lookup = stage.$lookup as {
        from: string;
        localField: string;
        foreignField: string;
        as: string;
        pipeline: Row[];
      };
      rows = rows.map((row) => ({
        ...row,
        [lookup.as]: aggregate(
          registry[lookup.from].filter(
            (foreign) =>
              scalar(path(foreign, lookup.foreignField)) ===
              scalar(path(row, lookup.localField)),
          ),
          lookup.pipeline,
          registry,
        ),
      }));
    } else if (stage.$unwind) {
      const unwind = stage.$unwind as {
        path: string;
        preserveNullAndEmptyArrays: boolean;
      };
      const key = unwind.path.slice(1);
      rows = rows.flatMap((row) =>
        (row[key] as Row[]).length
          ? (row[key] as Row[]).map((value) => ({ ...row, [key]: value }))
          : [{ ...row, [key]: undefined }],
      );
    } else if (stage.$facet)
      rows = [
        Object.fromEntries(
          Object.entries(stage.$facet as Record<string, Row[]>).map(
            ([name, stages]) => [name, aggregate(rows, stages, registry)],
          ),
        ),
      ];
    else if (stage.$group) {
      const group = stage.$group as Row;
      const groups = new Map<unknown, Row[]>();
      for (const row of rows) {
        const key = expr(group._id, row);
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      rows = [...groups.entries()].map(([key, members]) => ({
        _id: key,
        ...Object.fromEntries(
          Object.entries(group)
            .filter(([field]) => field !== '_id')
            .map(([field, value]) => [
              field,
              members.reduce(
                (sum, row) => sum + Number(expr((value as Row).$sum, row) ?? 0),
                0,
              ),
            ]),
        ),
      }));
    } else throw new Error('Unsupported fixture pipeline stage');
  }
  return rows;
}
class Query<T> implements PromiseLike<T> {
  constructor(private value: T) {}
  select(selection: string) {
    if (selection && !selection.startsWith('+') && this.value) {
      const fields = selection
        .split(/\s+/)
        .map((key) => key.replace(/^\+/, ''));
      this.value = {
        _id: (this.value as Row)._id,
        ...Object.fromEntries(
          fields.map((key) => [key, (this.value as Row)[key]]),
        ),
      } as T;
    }
    return this;
  }
  lean() {
    return this;
  }
  session() {
    return this;
  }
  option() {
    return this;
  }
  sort(specification: Row) {
    if (Array.isArray(this.value))
      this.value.sort((left, right) => {
        for (const [field, direction] of Object.entries(specification)) {
          const a = scalar(path(left as Row, field)) as string | number;
          const b = scalar(path(right as Row, field)) as string | number;
          if (a !== b) return (a < b ? -1 : 1) * Number(direction);
        }
        return 0;
      });
    return this;
  }
  skip(n: number) {
    if (Array.isArray(this.value)) this.value = this.value.slice(n) as T;
    return this;
  }
  limit(n: number) {
    if (Array.isArray(this.value)) this.value = this.value.slice(0, n) as T;
    return this;
  }
  then<A = T, B = never>(
    fulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    rejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return Promise.resolve(this.value).then(fulfilled, rejected);
  }
}
function model(rows: Row[], name: string, registry: Record<string, Row[]>) {
  return {
    collection: { name },
    init: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn(
      (id: unknown) =>
        new Query(rows.find((row) => scalar(row._id) === scalar(id)) ?? null),
    ),
    findOne: jest.fn(
      (filter: Row) =>
        new Query(rows.find((row) => matches(row, filter)) ?? null),
    ),
    find: jest.fn(
      (filter: Row) => new Query(rows.filter((row) => matches(row, filter))),
    ),
    exists: jest.fn(
      (filter: Row) => new Query(rows.some((row) => matches(row, filter))),
    ),
    countDocuments: jest.fn((filter: Row = {}) =>
      Promise.resolve(rows.filter((row) => matches(row, filter)).length),
    ),
    aggregate: jest.fn(
      (pipeline: Row[]) => new Query(aggregate(rows, pipeline, registry)),
    ),
    create: jest.fn((input: Row | Row[]) => {
      const now = new Date();
      const created = (Array.isArray(input) ? input : [input]).map((row) => ({
        _id: row._id ?? new Types.ObjectId(),
        createdAt: row.createdAt ?? now,
        updatedAt: row.updatedAt ?? now,
        ...row,
      }));
      rows.push(...created);
      return Promise.resolve(Array.isArray(input) ? created : created[0]);
    }),
    findOneAndUpdate: jest.fn(
      (filter: Row, update: { $set?: Row; $inc?: Row; $unset?: Row }) => {
        const row = rows.find((value) => matches(value, filter));
        if (row) {
          Object.assign(row, update.$set);
          for (const [key, value] of Object.entries(update.$inc ?? {}))
            row[key] = Number(row[key] ?? 0) + Number(value);
          for (const key of Object.keys(update.$unset ?? {})) delete row[key];
          row.updatedAt = new Date();
        }
        return new Query(row ?? null);
      },
    ),
    updateOne: jest.fn(
      (filter: Row, update: { $set?: Row; $inc?: Row; $unset?: Row }) => {
        const row = rows.find((value) => matches(value, filter));
        if (row) {
          Object.assign(row, update.$set);
          for (const [key, value] of Object.entries(update.$inc ?? {}))
            row[key] = Number(row[key] ?? 0) + Number(value);
          for (const key of Object.keys(update.$unset ?? {})) delete row[key];
        }
        return Promise.resolve({ modifiedCount: row ? 1 : 0 });
      },
    ),
    deleteOne: jest.fn((filter: Row) => {
      const index = rows.findIndex((value) => matches(value, filter));
      if (index >= 0) rows.splice(index, 1);
      return Promise.resolve({ deletedCount: index >= 0 ? 1 : 0 });
    }),
    findOneAndDelete: jest.fn((filter: Row) => {
      const index = rows.findIndex((value) => matches(value, filter));
      return Promise.resolve(index >= 0 ? rows.splice(index, 1)[0] : null);
    }),
    deleteMany: jest.fn((filter: Row) => {
      const selected = rows.filter((value) => matches(value, filter));
      for (const row of selected) rows.splice(rows.indexOf(row), 1);
      return Promise.resolve({ deletedCount: selected.length });
    }),
  };
}

export async function adminFixture() {
  const config = new FixtureConfig({
    JWT_SECRET: 'fixture-root-secret-of-at-least-32-characters',
    ACCOUNT_ACTIVATION_URL: 'https://client.fixture.test/activate',
    TRUST_PROXY_HOPS: 0,
    STRIPE_ENABLED: true,
    PLATFORM_ADMIN_BOOTSTRAP_EMAIL: '',
    PLATFORM_ADMIN_BOOTSTRAP_PASSWORD: '',
    PLATFORM_ADMIN_BOOTSTRAP_FULL_NAME: '',
    OPENROUTER_ENABLED: false,
    OPENROUTER_FALLBACK_MODELS: [],
    OPENROUTER_MAX_OUTPUT_TOKENS: 1000,
    OPENROUTER_MAX_TOOL_ITERATIONS: 3,
    OPENROUTER_TIMEOUT_MS: 30000,
    OPENROUTER_REQUIRE_ZDR: false,
    AI_MAX_MESSAGE_CHARS: 8000,
    AI_MAX_HISTORY_MESSAGES: 20,
    AI_MAX_CONTEXT_CHARS: 40000,
    AI_MAX_CONVERSATION_MESSAGES: 100,
    AI_MAX_CONVERSATIONS_PER_USER: 100,
    AI_RATE_LIMIT_PER_MINUTE: 10,
  });
  const password = 'Admin-Testing-Password42!';
  const hash = await bcrypt.hash(password, 12);
  const tenantPassword = 'TenantPass42!';
  const tenantHash = await bcrypt.hash(tenantPassword, 10);
  const now = new Date();
  const adminId = new Types.ObjectId();
  const companies: Row[] = Object.values(PlanCode).map((plan, index) => ({
    _id: new Types.ObjectId(),
    name: ['Alpha', 'Beta', 'Gamma'][index],
    country: 'GE',
    industry: 'Technology',
    activatedAt: index === 2 ? null : now,
    createdAt: new Date(now.getTime() - (3 - index) * 10000),
    updatedAt: now,
    ...(index !== 0 ? { platformStatus: CompanyPlatformStatus.ACTIVE } : {}),
    privateInternal: 'hidden-company-internal',
  }));
  const users: Row[] = companies.map((company, index) => ({
    _id: new Types.ObjectId(),
    companyId: company._id,
    role: Role.COMPANY_OWNER,
    email: `owner${index}@fixture.test`,
    fullName: `Owner ${index}`,
    password: tenantHash,
    tokenHash: 'hidden-user-token',
    createdAt: now,
  }));
  users.push({
    _id: new Types.ObjectId(),
    companyId: companies[1]._id,
    role: Role.COMPANY_MEMBER,
    email: 'employee@fixture.test',
    fullName: 'Employee',
    password: tenantHash,
    createdAt: now,
  });
  const subscriptions: Row[] = companies.map((company, index) => ({
    _id: new Types.ObjectId(),
    companyId: company._id,
    planCode: Object.values(PlanCode)[index],
    activatedAt: new Date('2024-01-31T12:05:07.321Z'),
    planChangedAt: new Date('2024-01-31T12:05:07.321Z'),
    revision: 0,
    stripeManaged: index !== 0,
    paymentAccess:
      index === 0 ? PaymentAccess.UNMANAGED : PaymentAccess.DEFERRED,
    stripeStatus: 'active',
    stripeSyncedAt: now,
    paymentSyncIssue: PaymentSyncIssue.NONE,
    stripeCustomerId: `cus_fixture${index}`,
    stripeSubscriptionId: `sub_fixture${index}`,
    stripeCancelAtPeriodEnd: false,
    stripeLeaseToken: 'hidden-lease-token',
    stripeCheckoutOperation: 'hidden-checkout-operation',
  }));
  const periods: Row[] = subscriptions.map((subscription, index) => ({
    _id: new Types.ObjectId(),
    companyId: subscription.companyId,
    ...billingPeriod(subscription.activatedAt as Date, now),
    uploadedFiles: [2, 7, 1002][index],
    fileOverageCents: index === 2 ? 100 : 0,
  }));
  const files: Row[] = [0, 1, 1].map((companyIndex, index) => ({
    _id: new Types.ObjectId(),
    companyId: companies[companyIndex]._id,
    uploaderId: users[companyIndex]._id,
    originalFilename: `sheet${index}.csv`,
    mimeType: 'text/csv',
    fileType: 'csv',
    size: 100,
    visibility:
      index === 2
        ? CompanyFileVisibility.RESTRICTED
        : CompanyFileVisibility.COMPANY_WIDE,
    restrictedUserIds: index === 2 ? [users[3]._id] : [],
    storageKey: 'hidden-storage-key',
    createdAt: now,
    updatedAt: now,
  }));
  const invitations: Row[] = [
    {
      _id: new Types.ObjectId(),
      companyId: companies[1]._id,
      status: InvitationStatus.PENDING,
      email: 'invited@fixture.test',
      tokenHash: 'hidden-invitation-token',
      expiresAt: new Date(now.getTime() + 3600000),
    },
  ];
  const admins: Row[] = [
    {
      _id: adminId,
      email: 'platform@fixture.test',
      fullName: 'Platform Operator',
      password: hash,
      isActive: true,
    },
  ];
  const audits: Row[] = [];
  const aiConversations: Row[] = [];
  const aiMessages: Row[] = [];
  const aiUsages: Row[] = [];
  const registry = {
    companies,
    users,
    subscriptions,
    subscriptionperiods: periods,
    companyfiles: files,
    employeeinvitations: invitations,
    platformadmins: admins,
    adminaudits: audits,
    aiconversations: aiConversations,
    aimessages: aiMessages,
    aiusages: aiUsages,
  };
  const models = {
    company: model(companies, 'companies', registry),
    user: model(users, 'users', registry),
    subscription: model(subscriptions, 'subscriptions', registry),
    subscriptionPeriod: model(periods, 'subscriptionperiods', registry),
    companyFile: model(files, 'companyfiles', registry),
    employeeInvitation: model(invitations, 'employeeinvitations', registry),
    platformAdmin: model(admins, 'platformadmins', registry),
    adminAudit: model(audits, 'adminaudits', registry),
    aiConversation: model(aiConversations, 'aiconversations', registry),
    aiMessage: model(aiMessages, 'aimessages', registry),
    aiUsage: model(aiUsages, 'aiusages', registry),
  };
  const connection = {
    transaction: jest.fn(async (work: (session: object) => unknown) => {
      const backup = Object.values(registry).map((rows) =>
        rows.map((row) => ({ ...row })),
      );
      try {
        return await work({ fixture: true });
      } catch (error) {
        Object.values(registry).forEach((rows, index) => {
          rows.splice(0, rows.length, ...backup[index]);
        });
        throw error;
      }
    }),
  };
  const plans = {
    findOne: (code: PlanCode) => PLAN_CATALOG[code],
  } as PlansService;
  const billing = new BillingService(plans);
  const subscriptionsService = new SubscriptionsService(
    models.subscription as never,
    models.subscriptionPeriod as never,
    models.user as never,
    models.employeeInvitation as never,
    plans,
    billing,
    connection as unknown as Connection,
    models.companyFile as never,
    { enabled: true } as never,
  );
  const jwt = new JwtService(platformAdminJwtOptions(config));
  const emailSender = {
    send: jest.fn<Promise<void>, [EmailMessage]>().mockResolvedValue(undefined),
  };
  const tenantJwt = new JwtService({
    secret: config.getOrThrow<string>('JWT_SECRET'),
    signOptions: { algorithm: 'HS256', expiresIn: '1h' },
    verifyOptions: { algorithms: ['HS256'] },
  });
  const service = new AdminService(
    models.company as never,
    models.user as never,
    models.subscription as never,
    models.subscriptionPeriod as never,
    models.employeeInvitation as never,
    models.companyFile as never,
    models.adminAudit as never,
    subscriptionsService,
    config,
    connection as unknown as Connection,
  );
  const auth = new AdminAuthService(
    models.platformAdmin as never,
    models.adminAudit as never,
    jwt,
    connection as unknown as Connection,
    config,
    emailSender,
  );
  const tenantAuth = new AuthService(
    models.user as never,
    models.company as never,
    connection as unknown as Connection,
    tenantJwt,
    subscriptionsService,
    {} as never,
    {} as never,
  );
  return {
    ...registry,
    models,
    connection,
    config,
    jwt,
    tenantJwt,
    service,
    auth,
    emailSender,
    tenantAuth,
    subscriptionsService,
    plans,
    billing,
    password,
    tenantPassword,
    adminId,
    now,
  };
}
