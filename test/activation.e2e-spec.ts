import { ExecutionContext, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { Request } from 'express';
import { Types } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { GoogleUser } from '../src/auth/auth.types';
import { RESEND_VERIFICATION_RESPONSE } from '../src/auth/company-verification.service';
import { configureApp } from '../src/config/configure-app';
import { EmailMessage, EmailSender } from '../src/email/email-sender';
import { Role } from '../src/enums/roles.enum';
import { GoogleOauthGuard } from '../src/guards/google-oauth.guard';
import { PlanCode } from '../src/plans/plan.constants';

interface CompanyState {
  _id: Types.ObjectId;
  name: string;
  country: string;
  industry: string;
  activatedAt: Date | null;
}
interface UserState {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  email: string;
  password: string;
  fullName?: string;
  role: Role;
  save: () => Promise<void>;
  toJSON: () => Record<string, unknown>;
}
interface VerificationState {
  companyId: Types.ObjectId;
  ownerId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  lastSentAt: Date;
}
interface SubscriptionState {
  companyId: Types.ObjectId;
  planCode: PlanCode;
  activatedAt: Date;
  planChangedAt: Date;
}
interface CompanyFilter {
  _id: Types.ObjectId;
  activatedAt?: null | { $ne: null };
}
interface UserFilter {
  email?: string;
  _id?: string | Types.ObjectId;
  companyId?: string | Types.ObjectId;
  role?: Role;
  password?: string;
}

const registration = {
  companyName: '  Acme  ',
  email: 'OWNER@EXAMPLE.COM ',
  password: 'TenantPassword42!',
  country: ' ge ',
  industry: '  Financial   Services ',
};
const duplicate = (field?: string) =>
  Object.assign(new Error('Duplicate key'), {
    code: 11000,
    keyPattern: field ? { [field]: 1 } : undefined,
  });
const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

// HTTP integration uses stateful database providers and a mocked outbound sender.
// Actual replica-set transactions and index enforcement require a database integration suite.
describe('company registration and activation (e2e)', () => {
  let app: INestApplication<App>;
  const companies = new Map<string, CompanyState>();
  const users = new Map<string, UserState>();
  const verifications = new Map<string, VerificationState>();
  const subscriptions = new Map<string, SubscriptionState>();
  const googleExchanges = new Map<
    string,
    { userId: Types.ObjectId; expiresAt: Date }
  >();
  const sender = { send: jest.fn<Promise<void>, [EmailMessage]>() };

  function findCompany(filter: CompanyFilter) {
    const company = companies.get(filter._id.toString());
    if (!company) return null;
    if (filter.activatedAt === null && company.activatedAt !== null)
      return null;
    if (filter.activatedAt && company.activatedAt === null) return null;
    return company;
  }

  beforeEach(async () => {
    companies.clear();
    users.clear();
    verifications.clear();
    subscriptions.clear();
    googleExchanges.clear();
    sender.send.mockReset().mockResolvedValue(undefined);
    const companyModel = {
      create: jest.fn((inputs: Omit<CompanyState, '_id'>[]) => {
        const input = inputs[0];
        if (
          [...companies.values()].some(
            (company) =>
              company.name.toLowerCase() === input.name.toLowerCase(),
          )
        )
          throw duplicate('name');
        const company = { _id: new Types.ObjectId(), ...input };
        companies.set(company._id.toString(), company);
        return Promise.resolve([company]);
      }),
      findById: jest.fn((id: string) =>
        Promise.resolve(companies.get(id) ?? null),
      ),
      findOne: jest.fn((filter: CompanyFilter) =>
        Promise.resolve(findCompany(filter)),
      ),
      findOneAndUpdate: jest.fn(
        (filter: CompanyFilter, update: { $set: { activatedAt: Date } }) => {
          const company = findCompany(filter);
          if (company) company.activatedAt = update.$set.activatedAt;
          return Promise.resolve(company);
        },
      ),
    };
    const userModel = {
      create: jest.fn(
        (inputs: Omit<UserState, '_id' | 'save' | 'toJSON'>[]) => {
          const input = inputs[0];
          if ([...users.values()].some((user) => user.email === input.email))
            throw duplicate('email');
          const user: UserState = {
            ...input,
            _id: new Types.ObjectId(),
            save: jest.fn().mockResolvedValue(undefined),
            toJSON: () => ({
              _id: user._id,
              companyId: user.companyId,
              email: user.email,
              fullName: user.fullName,
              role: user.role,
            }),
          };
          users.set(user._id.toString(), user);
          return Promise.resolve([user]);
        },
      ),
      findById: jest.fn((id: string | Types.ObjectId) =>
        Promise.resolve(users.get(id.toString()) ?? null),
      ),
      findOne: jest.fn((filter: UserFilter) => {
        const user =
          [...users.values()].find(
            (value) =>
              (filter.email === undefined || value.email === filter.email) &&
              (filter._id === undefined ||
                value._id.toString() === filter._id.toString()) &&
              (filter.companyId === undefined ||
                value.companyId.toString() === filter.companyId.toString()) &&
              (filter.role === undefined || value.role === filter.role) &&
              (filter.password === undefined ||
                value.password === filter.password),
          ) ?? null;
        const result = Promise.resolve(user);
        return Object.assign(result, { select: () => result });
      }),
      findOneAndUpdate: jest.fn(
        (
          filter: UserFilter,
          update: Partial<UserState> | { $set: Partial<UserState> },
        ) => {
          const user = [...users.values()].find(
            (value) =>
              (filter._id === undefined ||
                value._id.toString() === filter._id.toString()) &&
              (filter.companyId === undefined ||
                value.companyId.toString() === filter.companyId.toString()) &&
              (filter.password === undefined ||
                value.password === filter.password),
          );
          if (user)
            Object.assign(user, '$set' in update ? update.$set : update);
          return Promise.resolve(user ?? null);
        },
      ),
      countDocuments: jest.fn((filter: { companyId: string; role: Role }) =>
        Promise.resolve(
          [...users.values()].filter(
            (user) =>
              user.companyId.toString() === filter.companyId &&
              user.role === filter.role,
          ).length,
        ),
      ),
    };
    const verificationModel = {
      create: jest.fn((inputs: VerificationState[]) => {
        verifications.set(inputs[0].companyId.toString(), inputs[0]);
        return Promise.resolve(inputs);
      }),
      findOneAndDelete: jest.fn(
        (filter: { tokenHash: string; expiresAt: { $gt: Date } }) => {
          const verification = [...verifications.values()].find(
            (value) =>
              value.tokenHash === filter.tokenHash &&
              value.expiresAt > filter.expiresAt.$gt,
          );
          if (verification)
            verifications.delete(verification.companyId.toString());
          return Promise.resolve(verification ?? null);
        },
      ),
      findOneAndUpdate: jest.fn(
        (
          filter: {
            companyId: Types.ObjectId;
            $or: { lastSentAt: { $lte?: Date } }[];
          },
          update: {
            $set: Pick<
              VerificationState,
              'tokenHash' | 'expiresAt' | 'lastSentAt'
            >;
            $setOnInsert: Pick<VerificationState, 'companyId' | 'ownerId'>;
          },
        ) => {
          const id = filter.companyId.toString();
          const existing = verifications.get(id);
          if (existing && existing.lastSentAt > filter.$or[0].lastSentAt.$lte!)
            throw duplicate();
          const verification = {
            ...(existing ?? update.$setOnInsert),
            ...update.$set,
          };
          verifications.set(id, verification);
          return Promise.resolve(verification);
        },
      ),
    };
    const subscriptionModel = {
      create: jest.fn((inputs: SubscriptionState[]) => {
        subscriptions.set(inputs[0].companyId.toString(), inputs[0]);
        return Promise.resolve(inputs);
      }),
      findOne: jest.fn((filter: { companyId: string }) =>
        Promise.resolve(subscriptions.get(filter.companyId) ?? null),
      ),
    };
    const connection = {
      close: jest.fn(),
      transaction: jest.fn(
        async (work: (session: object) => Promise<unknown>) => {
          const snapshots = [
            new Map(companies),
            new Map(users),
            new Map(verifications),
            new Map(subscriptions),
          ] as const;
          try {
            return await work({});
          } catch (error) {
            companies.clear();
            snapshots[0].forEach((value, key) => companies.set(key, value));
            users.clear();
            snapshots[1].forEach((value, key) => users.set(key, value));
            verifications.clear();
            snapshots[2].forEach((value, key) => verifications.set(key, value));
            subscriptions.clear();
            snapshots[3].forEach((value, key) => subscriptions.set(key, value));
            throw error;
          }
        },
      ),
    };
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(getConnectionToken())
      .useValue(connection)
      .overrideProvider(getModelToken('company'))
      .useValue(companyModel)
      .overrideProvider(getModelToken('user'))
      .useValue(userModel)
      .overrideProvider(getModelToken('platformAdmin'))
      .useValue({})
      .overrideProvider(getModelToken('adminAudit'))
      .useValue({})
      .overrideProvider(getModelToken('adminAccessRequest'))
      .useValue({})
      .overrideProvider(getModelToken('companyVerification'))
      .useValue(verificationModel)
      .overrideProvider(getModelToken('googleOAuthState'))
      .useValue({})
      .overrideProvider(getModelToken('googleOAuthExchange'))
      .useValue({
        create: jest.fn(
          (record: {
            codeHash: string;
            userId: Types.ObjectId;
            expiresAt: Date;
          }) => {
            googleExchanges.set(record.codeHash, record);
            return Promise.resolve(record);
          },
        ),
        findOneAndDelete: jest.fn(
          (filter: { codeHash: string; expiresAt: { $gt: Date } }) => {
            const record = googleExchanges.get(filter.codeHash);
            if (!record || record.expiresAt <= filter.expiresAt.$gt)
              return Promise.resolve(null);
            googleExchanges.delete(filter.codeHash);
            return Promise.resolve(record);
          },
        ),
      })
      .overrideProvider(getModelToken('subscription'))
      .useValue(subscriptionModel)
      .overrideProvider(getModelToken('subscriptionPeriod'))
      .useValue({ findOne: jest.fn().mockResolvedValue(null) })
      .overrideProvider(getModelToken('employeeInvitation'))
      .useValue({ countDocuments: jest.fn().mockResolvedValue(0) })
      .overrideProvider(getModelToken('companyFile'))
      .useValue({ countDocuments: jest.fn().mockResolvedValue(0) })
      .overrideProvider(getModelToken('plan'))
      .useValue({ bulkWrite: jest.fn() })
      .overrideProvider(EmailSender)
      .useValue(sender)
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          JWT_SECRET: 'a-secure-test-secret-with-32-characters',
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
          ACCOUNT_ACTIVATION_URL: 'https://client.example.test/auth/activate',
          EMPLOYEE_INVITATION_URL:
            'https://client.example.test/invitations/accept',
          FILE_MAX_SIZE_BYTES: 10485760,
          FRONT_URI: 'https://client.example.test',
          GOOGLE_CLIENT_ID: 'test-client-id',
          GOOGLE_CLIENT_SECRET: 'test-client-secret',
          GOOGLE_CALLBACK_URL: 'https://api.example.test/auth/google/callback',
        }),
      )
      .overrideGuard(GoogleOauthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context
            .switchToHttp()
            .getRequest<Request & { user: GoogleUser }>().user = {
            email: 'owner@example.com',
            fullName: 'Owner',
          };
          return true;
        },
      })
      .overrideProvider(getModelToken('aiConversation'))
      .useValue({})
      .overrideProvider(getModelToken('aiMessage'))
      .useValue({})
      .overrideProvider(getModelToken('aiUsage'))
      .useValue({})
      .compile();
    app = fixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(() => app?.close());

  function lastToken() {
    const message = sender.send.mock.calls.at(-1)?.[0];
    const url = message?.text
      .split('\n')
      .find((line) => line.startsWith('https://'));
    if (!url) throw new Error('No activation email captured');
    return new URL(url).searchParams.get('token')!;
  }
  function register(overrides: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .post('/auth/sign-up')
      .send({ ...registration, ...overrides });
  }
  function verify(token: string) {
    return request(app.getHttpServer())
      .post('/auth/verify-account')
      .send({ token });
  }

  it('collects only the required registration fields, normalizes data, hashes the token and provisions Free', async () => {
    const response = await register().expect(202);
    const company = [...companies.values()][0];
    const user = [...users.values()][0];
    expect(company).toMatchObject({
      name: 'Acme',
      country: 'GE',
      industry: 'Financial Services',
      activatedAt: null,
    });
    expect(company).not.toHaveProperty('email');
    expect(company).not.toHaveProperty('password');
    expect(user.email).toBe('owner@example.com');
    expect(user.password).not.toBe('TenantPassword42!');
    expect(user.fullName).toBeUndefined();
    expect(user.companyId).toEqual(company._id);
    expect(user.role).toBe(Role.COMPANY_OWNER);
    expect(subscriptions.get(company._id.toString())?.planCode).toBe(
      PlanCode.FREE,
    );
    const token = lastToken();
    expect(verifications.get(company._id.toString())?.tokenHash).toBe(
      hash(token),
    );
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(JSON.stringify(response.body)).not.toContain(hash(token));
    expect(response.body).not.toHaveProperty('accessToken');
  });

  it.each([
    { country: undefined },
    { country: 'XX' },
    { industry: ' ' },
    { companyName: ' ' },
    { email: 'invalid' },
    { password: 'short' },
    { password: 'longbutmissingrules' },
    { password: 'A'.repeat(60) + 'a1!é'.repeat(5) },
    { fullName: null },
    { activatedAt: new Date().toISOString() },
    { role: Role.COMPANY_OWNER },
  ])(
    'rejects invalid/missing registration fields and client-controlled state: %p',
    async (override) => {
      await register(override).expect(400);
      expect(companies.size).toBe(0);
      expect(sender.send).not.toHaveBeenCalled();
    },
  );

  it('accepts a strong password longer than the old 20-character sign-in limit', async () => {
    const password = 'A'.repeat(60) + 'a1!';
    await register({ password }).expect(202);
    await verify(lastToken()).expect(200);
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: 'owner@example.com', password })
      .expect(201);
  });

  it('blocks login and all protected tenant functionality until activation, then permits normal sign-in', async () => {
    await register().expect(202);
    const user = [...users.values()][0];
    const forgedToken = app.get(JwtService).sign({ id: user._id.toString() });
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: user.email, password: 'TenantPassword42!' })
      .expect(401);
    for (const path of [
      '/auth/current-user',
      '/companies/current',
      '/users',
      '/subscriptions/current',
      '/subscriptions/current/billing',
      '/files',
    ]) {
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', 'Bearer ' + forgedToken)
        .expect(401);
    }
    const token = lastToken();
    await verify(token).expect(200);
    await verify(token).expect(400);
    expect(verifications.size).toBe(0);
    const login = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: user.email, password: 'TenantPassword42!' })
      .expect(201);
    const body = login.body as unknown as { accessToken: string };
    await request(app.getHttpServer())
      .get('/companies/current')
      .set('Authorization', 'Bearer ' + body.accessToken)
      .expect(200);
    await request(app.getHttpServer())
      .get('/subscriptions/current')
      .set('Authorization', 'Bearer ' + body.accessToken)
      .expect(200)
      .expect(({ body }: { body: { plan: { code: PlanCode } } }) =>
        expect(body.plan.code).toBe(PlanCode.FREE),
      );
    await request(app.getHttpServer())
      .get('/auth/current-user')
      .set('Authorization', 'Bearer ' + body.accessToken)
      .expect(200)
      .expect(({ body }: { body: Record<string, unknown> }) =>
        expect(body).not.toHaveProperty('password'),
      );
  });

  it('changes owner and employee passwords only after verifying the current password', async () => {
    await register().expect(202);
    await verify(lastToken()).expect(200);
    const owner = [...users.values()][0];
    const ownerLogin = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: owner.email, password: 'TenantPassword42!' })
      .expect(201);
    const ownerToken = (ownerLogin.body as { accessToken: string }).accessToken;
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

    await request(app.getHttpServer())
      .patch('/users/me/password')
      .send({
        currentPassword: 'TenantPassword42!',
        newPassword: 'NewPassword42!',
      })
      .expect(401);
    await request(app.getHttpServer())
      .patch('/users/me/password')
      .set(auth(ownerToken))
      .send({
        currentPassword: 'wrong-password',
        newPassword: 'NewPassword42!',
      })
      .expect(401);
    await request(app.getHttpServer())
      .patch('/users/me/password')
      .set(auth(ownerToken))
      .send({ currentPassword: 'TenantPassword42!', newPassword: 'short' })
      .expect(400);
    await request(app.getHttpServer())
      .patch('/users/me/password')
      .set(auth(ownerToken))
      .send({
        currentPassword: 'TenantPassword42!',
        newPassword: 'NewPassword42!',
        companyId: new Types.ObjectId().toString(),
      })
      .expect(400);

    for (const unsafe of [
      { password: 'bypass-password' },
      { email: 'changed@example.com' },
      { role: Role.COMPANY_OWNER },
      { companyId: new Types.ObjectId().toString() },
    ]) {
      await request(app.getHttpServer())
        .patch(`/users/${owner._id.toString()}`)
        .set(auth(ownerToken))
        .send(unsafe)
        .expect(400);
    }

    await request(app.getHttpServer())
      .patch('/users/me/password')
      .set(auth(ownerToken))
      .send({
        currentPassword: 'TenantPassword42!',
        newPassword: 'NewPassword42!',
      })
      .expect(200)
      .expect({ message: 'Password changed successfully' });
    expect(await bcrypt.compare('NewPassword42!', owner.password)).toBe(true);
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: owner.email, password: 'TenantPassword42!' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: owner.email, password: 'NewPassword42!' })
      .expect(201);

    const employee: UserState = {
      _id: new Types.ObjectId(),
      companyId: owner.companyId,
      email: 'employee@example.com',
      password: await bcrypt.hash('employee-password', 10),
      fullName: 'Employee',
      role: Role.COMPANY_MEMBER,
      save: jest.fn().mockResolvedValue(undefined),
      toJSON: () => ({
        _id: employee._id,
        companyId: employee.companyId,
        email: employee.email,
        fullName: employee.fullName,
        role: employee.role,
      }),
    };
    users.set(employee._id.toString(), employee);
    const employeeToken = app
      .get(JwtService)
      .sign({ id: employee._id.toString() });
    await request(app.getHttpServer())
      .patch('/users/me/password')
      .set(auth(employeeToken))
      .send({
        currentPassword: 'employee-password',
        newPassword: 'EmployeeNew42!',
      })
      .expect(200);
    expect(await bcrypt.compare('EmployeeNew42!', employee.password)).toBe(
      true,
    );
  });

  it('rejects invalid, malformed, expired tokens and tenant selectors without activation', async () => {
    await register().expect(202);
    const token = lastToken();
    await verify('b'.repeat(43)).expect(400);
    await verify('malformed').expect(400);
    await request(app.getHttpServer())
      .post('/auth/verify-account')
      .send({ token, companyId: new Types.ObjectId().toString() })
      .expect(400);
    [...verifications.values()][0].expiresAt = new Date(Date.now() - 1);
    await verify(token).expect(400);
    expect([...companies.values()][0].activatedAt).toBeNull();
  });

  it('resends with generic responses, enforces cooldown, replaces old tokens and skips active/unknown accounts', async () => {
    await register().expect(202);
    const oldToken = lastToken();
    const resend = (email: string) =>
      request(app.getHttpServer())
        .post('/auth/resend-verification')
        .send({ email });
    await resend('owner@example.com')
      .expect(202)
      .expect(RESEND_VERIFICATION_RESPONSE);
    expect(sender.send).toHaveBeenCalledTimes(1);
    [...verifications.values()][0].lastSentAt = new Date(Date.now() - 61_000);
    await resend('OWNER@EXAMPLE.COM')
      .expect(202)
      .expect(RESEND_VERIFICATION_RESPONSE);
    expect(sender.send).toHaveBeenCalledTimes(2);
    const newToken = lastToken();
    expect(newToken).not.toBe(oldToken);
    await verify(oldToken).expect(400);
    await verify(newToken).expect(200);
    await resend('owner@example.com')
      .expect(202)
      .expect(RESEND_VERIFICATION_RESPONSE);
    await resend('unknown@example.com')
      .expect(202)
      .expect(RESEND_VERIFICATION_RESPONSE);
    expect(sender.send).toHaveBeenCalledTimes(2);
  });

  it('rate-limits public resend requests including unknown addresses', async () => {
    for (let index = 0; index < 5; index++) {
      await request(app.getHttpServer())
        .post('/auth/resend-verification')
        .send({ email: 'unknown@example.com' })
        .expect(202);
    }
    await request(app.getHttpServer())
      .post('/auth/resend-verification')
      .send({ email: 'unknown@example.com' })
      .expect(429);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('keeps committed registration and Free subscription recoverable after SMTP failure', async () => {
    sender.send.mockRejectedValueOnce(new Error('SMTP unavailable'));
    await register().expect(503);
    expect(companies.size).toBe(1);
    expect(users.size).toBe(1);
    expect(subscriptions.size).toBe(1);
    [...verifications.values()][0].lastSentAt = new Date(Date.now() - 61_000);
    await request(app.getHttpServer())
      .post('/auth/resend-verification')
      .send({ email: 'owner@example.com' })
      .expect(202);
    await verify(lastToken()).expect(200);
  });

  it('keeps inactive accounts out of Google sign-in', async () => {
    await register().expect(202);
    await request(app.getHttpServer())
      .get('/auth/google/callback')
      .expect(302)
      .expect(({ headers }: { headers: Record<string, string> }) => {
        const redirect = new URL(headers.location);
        expect(redirect.searchParams.get('error')).toBe('account_unavailable');
        expect(redirect.hash).toBe('');
      });
    await verify(lastToken()).expect(200);
    await request(app.getHttpServer())
      .get('/auth/google/callback')
      .expect(302)
      .expect(({ headers }: { headers: Record<string, string> }) => {
        const redirect = new URL(headers.location);
        expect(redirect.origin).toBe('https://client.example.test');
        expect(redirect.searchParams.get('token')).toBeNull();
        expect(new URLSearchParams(redirect.hash.slice(1)).get('code')).toMatch(
          /^[A-Za-z0-9_-]{43}$/,
        );
      });
  });

  it('exchanges the Google redirect code once, without a JWT in the URL', async () => {
    await register().expect(202);
    await verify(lastToken()).expect(200);
    const callback = await request(app.getHttpServer())
      .get('/auth/google/callback')
      .expect(302);
    expect(callback.headers['referrer-policy']).toBe('no-referrer');
    const redirect = new URL(callback.headers.location);
    const code = new URLSearchParams(redirect.hash.slice(1)).get('code');
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redirect.searchParams.has('token')).toBe(false);
    expect(redirect.searchParams.has('code')).toBe(false);
    const exchanged = await request(app.getHttpServer())
      .post('/auth/google/exchange')
      .send({ code })
      .expect(200);
    expect(typeof (exchanged.body as Record<string, unknown>).accessToken).toBe(
      'string',
    );
    expect(exchanged.headers['cache-control']).toBe('private, no-store');
    await request(app.getHttpServer())
      .post('/auth/google/exchange')
      .send({ code })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/google/exchange')
      .send({ code: 'A'.repeat(43) })
      .expect(401);
  });

  it('keeps the Google redirect fixed and provider errors generic', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/google/callback')
      .query({
        error: 'access_denied',
        error_description: 'sensitive provider text',
        redirect: 'https://evil.example.test',
      })
      .expect(302);
    const redirect = new URL(response.headers.location);
    expect(redirect.origin).toBe('https://client.example.test');
    expect(redirect.pathname).toBe('/auth/sign-in');
    expect(redirect.searchParams.get('error')).toBe('google_auth_cancelled');
    expect(redirect.toString()).not.toContain('sensitive provider text');
    expect(redirect.toString()).not.toContain('evil.example.test');
    expect(redirect.searchParams.has('token')).toBe(false);
    expect(redirect.hash).toBe('');
  });

  it('does not issue an exchange JWT over insecure production transport', async () => {
    const config = app.get(ConfigService);
    const previous = config.get<string>('NODE_ENV');
    config.set('NODE_ENV', 'production');
    try {
      await request(app.getHttpServer())
        .post('/auth/google/exchange')
        .send({ code: 'A'.repeat(43) })
        .expect(403);
    } finally {
      config.set('NODE_ENV', previous);
    }
  });

  it('activates only the token company and preserves tenant isolation', async () => {
    await register().expect(202);
    const firstToken = lastToken();
    const firstCompany = [...companies.values()][0];
    const firstOwner = [...users.values()][0];
    await register({ companyName: 'Other', email: 'other@example.com' }).expect(
      202,
    );
    const otherCompany = [...companies.values()][1];
    const otherOwner = [...users.values()][1];
    await verify(firstToken).expect(200);
    expect(firstCompany.activatedAt).not.toBeNull();
    expect(otherCompany.activatedAt).toBeNull();
    const otherJwt = app
      .get(JwtService)
      .sign({ id: otherOwner._id.toString() });
    await request(app.getHttpServer())
      .get('/companies/current')
      .set('Authorization', 'Bearer ' + otherJwt)
      .expect(401);
    const firstJwt = app
      .get(JwtService)
      .sign({ id: firstOwner._id.toString() });
    await request(app.getHttpServer())
      .get('/companies/current')
      .set('Authorization', 'Bearer ' + firstJwt)
      .expect(200)
      .expect(({ body }: { body: { _id: string } }) =>
        expect(body._id).toBe(firstCompany._id.toString()),
      );
  });

  it('preserves duplicate constraints and rolls back rejected onboarding', async () => {
    await register().expect(202);
    await register({ companyName: 'Different' }).expect(409);
    await register({ companyName: 'acme', email: 'other@example.com' }).expect(
      409,
    );
    expect(companies.size).toBe(1);
    expect(users.size).toBe(1);
    expect(subscriptions.size).toBe(1);
    expect(verifications.size).toBe(1);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });
});
