import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/config/configure-app';
import { EmailMessage, EmailSender } from '../src/email/email-sender';
import { Role } from '../src/enums/roles.enum';
import {
  EmployeeInvitation,
  InvitationStatus,
} from '../src/invitations/entities/employee-invitation.entity';
import {
  INVITATION_RESEND_COOLDOWN_MS,
  RESEND_INVITATION_RESPONSE,
} from '../src/invitations/invitations.service';
import { PlanCode } from '../src/plans/plan.constants';

interface UserState {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  email: string;
  password?: string;
  fullName?: string;
  role: Role;
}

interface CompanyState {
  _id: Types.ObjectId;
  name: string;
  activatedAt: Date;
}

interface InvitationState extends EmployeeInvitation {
  _id: Types.ObjectId;
  tokenHash?: string;
}

interface SubscriptionState {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  planCode: PlanCode;
  activatedAt: Date;
  planChangedAt: Date;
  revision: number;
}

interface InvitationFilter {
  _id?: string | Types.ObjectId;
  companyId?: string | Types.ObjectId;
  email?: string;
  tokenHash?: string;
  status?: InvitationStatus;
  expiresAt?: { $gt?: Date; $lte?: Date };
  lastSentAt?: { $lte?: Date };
}

interface InvitationUpdate {
  $set?: Partial<InvitationState>;
  $unset?: Record<string, number>;
}

const duplicate = () =>
  Object.assign(new Error('Duplicate key'), { code: 11000 });

describe('employee invitations (e2e)', () => {
  let app: INestApplication<App>;
  const companies = new Map<string, CompanyState>();
  const users = new Map<string, UserState>();
  const invitations = new Map<string, InvitationState>();
  const subscriptions = new Map<string, SubscriptionState>();
  const sender = { send: jest.fn<Promise<void>, [EmailMessage]>() };
  const companyId = new Types.ObjectId();
  const otherCompanyId = new Types.ObjectId();
  const ownerId = new Types.ObjectId();
  const memberId = new Types.ObjectId();
  const otherOwnerId = new Types.ObjectId();
  let ownerToken: string;
  let memberToken: string;
  let otherOwnerToken: string;
  let transactionTail = Promise.resolve();

  const matchesInvitation = (
    invitation: InvitationState,
    filter: InvitationFilter,
  ) =>
    (filter._id === undefined ||
      invitation._id.toString() === String(filter._id)) &&
    (filter.companyId === undefined ||
      invitation.companyId.toString() === String(filter.companyId)) &&
    (filter.email === undefined || invitation.email === filter.email) &&
    (filter.tokenHash === undefined ||
      invitation.tokenHash === filter.tokenHash) &&
    (filter.status === undefined || invitation.status === filter.status) &&
    (filter.expiresAt?.$gt === undefined ||
      invitation.expiresAt > filter.expiresAt.$gt) &&
    (filter.expiresAt?.$lte === undefined ||
      invitation.expiresAt <= filter.expiresAt.$lte) &&
    (filter.lastSentAt?.$lte === undefined ||
      invitation.lastSentAt <= filter.lastSentAt.$lte);

  beforeAll(async () => {
    const userModel = {
      findById: jest.fn((id: string) => Promise.resolve(users.get(id) ?? null)),
      findOne: jest.fn(
        (filter: { email?: string; _id?: string | Types.ObjectId }) => {
          const user =
            [...users.values()].find(
              (value) =>
                (filter.email === undefined || value.email === filter.email) &&
                (filter._id === undefined ||
                  value._id.toString() === String(filter._id)),
            ) ?? null;
          const result = Promise.resolve(user);
          return Object.assign(result, { select: () => result });
        },
      ),
      exists: jest.fn((filter: { email: string }) => ({
        session: jest
          .fn()
          .mockResolvedValue(
            [...users.values()].some((user) => user.email === filter.email),
          ),
      })),
      create: jest.fn((inputs: Omit<UserState, '_id'>[]) => {
        const input = inputs[0];
        if ([...users.values()].some((user) => user.email === input.email))
          throw duplicate();
        const user = { ...input, _id: new Types.ObjectId() };
        users.set(user._id.toString(), user);
        return Promise.resolve([user]);
      }),
      countDocuments: jest.fn((filter: { companyId: string; role: Role }) =>
        Promise.resolve(
          [...users.values()].filter(
            (user) =>
              user.companyId.toString() === String(filter.companyId) &&
              user.role === filter.role,
          ).length,
        ),
      ),
    };
    const companyModel = {
      findOne: jest.fn((filter: { _id: string | Types.ObjectId }) =>
        Promise.resolve(companies.get(String(filter._id)) ?? null),
      ),
      findById: jest.fn((id: string) =>
        Promise.resolve(companies.get(String(id)) ?? null),
      ),
    };
    const invitationModel = {
      create: jest.fn((inputs: Omit<InvitationState, '_id'>[]) => {
        const input = inputs[0];
        if (
          input.status === InvitationStatus.PENDING &&
          [...invitations.values()].some(
            (value) =>
              value.status === InvitationStatus.PENDING &&
              value.email === input.email,
          )
        )
          throw duplicate();
        const invitation = { ...input, _id: new Types.ObjectId() };
        invitations.set(invitation._id.toString(), invitation);
        return Promise.resolve([invitation]);
      }),
      findOne: jest.fn((filter: InvitationFilter) =>
        Promise.resolve(
          [...invitations.values()].find((value) =>
            matchesInvitation(value, filter),
          ) ?? null,
        ),
      ),
      findOneAndUpdate: jest.fn(
        (filter: InvitationFilter, update: InvitationUpdate) => {
          const invitation = [...invitations.values()].find((value) =>
            matchesInvitation(value, filter),
          );
          if (!invitation) return Promise.resolve(null);
          Object.assign(invitation, update.$set ?? {});
          for (const key of Object.keys(update.$unset ?? {}))
            delete (invitation as unknown as Record<string, unknown>)[key];
          return Promise.resolve(invitation);
        },
      ),
      updateMany: jest.fn(
        (filter: InvitationFilter, update: InvitationUpdate) => {
          let modifiedCount = 0;
          for (const invitation of invitations.values()) {
            if (!matchesInvitation(invitation, filter)) continue;
            Object.assign(invitation, update.$set ?? {});
            for (const key of Object.keys(update.$unset ?? {}))
              delete (invitation as unknown as Record<string, unknown>)[key];
            modifiedCount++;
          }
          return Promise.resolve({ modifiedCount });
        },
      ),
      find: jest.fn((filter: InvitationFilter) => {
        let result = [...invitations.values()].filter((value) =>
          matchesInvitation(value, filter),
        );
        const query = {
          select: () => query,
          sort: () => query,
          skip: (count: number) => {
            result = result.slice(count);
            return query;
          },
          limit: (count: number) => Promise.resolve(result.slice(0, count)),
        };
        return query;
      }),
      countDocuments: jest.fn((filter: InvitationFilter) =>
        Promise.resolve(
          [...invitations.values()].filter((value) =>
            matchesInvitation(value, filter),
          ).length,
        ),
      ),
    };
    const subscriptionModel = {
      findOne: jest.fn((filter: { companyId: string | Types.ObjectId }) =>
        Promise.resolve(subscriptions.get(String(filter.companyId)) ?? null),
      ),
      findOneAndUpdate: jest.fn(
        (
          filter: { companyId?: string | Types.ObjectId; _id?: Types.ObjectId },
          update: {
            $set?: { planCode: PlanCode; planChangedAt: Date };
            $inc?: object;
          },
        ) => {
          const subscription = filter.companyId
            ? subscriptions.get(String(filter.companyId))
            : [...subscriptions.values()].find((value) =>
                value._id.equals(filter._id),
              );
          if (!subscription) return Promise.resolve(null);
          if (update.$inc) subscription.revision++;
          if (update.$set) Object.assign(subscription, update.$set);
          return Promise.resolve(subscription);
        },
      ),
      create: jest.fn(),
    };
    const connection = {
      close: jest.fn(),
      transaction: jest.fn((work: (session: object) => Promise<unknown>) => {
        const run = transactionTail.then(async () => {
          const invitationSnapshot = new Map(
            [...invitations].map(([key, value]) => [key, { ...value }]),
          );
          const userSnapshot = new Map(
            [...users].map(([key, value]) => [key, { ...value }]),
          );
          const subscriptionSnapshot = new Map(
            [...subscriptions].map(([key, value]) => [key, { ...value }]),
          );
          try {
            return await work({});
          } catch (error) {
            invitations.clear();
            invitationSnapshot.forEach((value, key) =>
              invitations.set(key, value),
            );
            users.clear();
            userSnapshot.forEach((value, key) => users.set(key, value));
            subscriptions.clear();
            subscriptionSnapshot.forEach((value, key) =>
              subscriptions.set(key, value),
            );
            throw error;
          }
        });
        transactionTail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      }),
    };

    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(getConnectionToken())
      .useValue(connection)
      .overrideProvider(getModelToken('user'))
      .useValue(userModel)
      .overrideProvider(getModelToken('company'))
      .useValue(companyModel)
      .overrideProvider(getModelToken('employeeInvitation'))
      .useValue(invitationModel)
      .overrideProvider(getModelToken('companyFile'))
      .useValue({ countDocuments: jest.fn().mockResolvedValue(0) })
      .overrideProvider(getModelToken('subscription'))
      .useValue(subscriptionModel)
      .overrideProvider(getModelToken('subscriptionPeriod'))
      .useValue({ findOne: jest.fn().mockResolvedValue(null) })
      .overrideProvider(getModelToken('platformAdmin'))
      .useValue({})
      .overrideProvider(getModelToken('adminAudit'))
      .useValue({})
      .overrideProvider(getModelToken('adminAccessRequest'))
      .useValue({})
      .overrideProvider(getModelToken('companyVerification'))
      .useValue({})
      .overrideProvider(getModelToken('googleOAuthState'))
      .useValue({})
      .overrideProvider(getModelToken('googleOAuthExchange'))
      .useValue({})
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
          EMPLOYEE_INVITATION_URL:
            'https://client.example.test/invitations/accept',
          FILE_MAX_SIZE_BYTES: 10485760,
        }),
      )
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
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
    const jwt = app.get(JwtService);
    ownerToken = jwt.sign({ id: ownerId.toString() });
    memberToken = jwt.sign({ id: memberId.toString() });
    otherOwnerToken = jwt.sign({ id: otherOwnerId.toString() });
  });

  beforeEach(() => {
    companies.clear();
    users.clear();
    invitations.clear();
    subscriptions.clear();
    transactionTail = Promise.resolve();
    sender.send.mockReset().mockResolvedValue(undefined);
    const activatedAt = new Date('2026-01-01T00:00:00.000Z');
    companies.set(companyId.toString(), {
      _id: companyId,
      name: 'Acme',
      activatedAt,
    });
    companies.set(otherCompanyId.toString(), {
      _id: otherCompanyId,
      name: 'Other',
      activatedAt,
    });
    users.set(ownerId.toString(), {
      _id: ownerId,
      companyId,
      email: 'owner@example.com',
      role: Role.COMPANY_OWNER,
    });
    users.set(memberId.toString(), {
      _id: memberId,
      companyId,
      email: 'member@example.com',
      role: Role.COMPANY_MEMBER,
    });
    users.set(otherOwnerId.toString(), {
      _id: otherOwnerId,
      companyId: otherCompanyId,
      email: 'other-owner@example.com',
      role: Role.COMPANY_OWNER,
    });
    for (const [id, planCode] of [
      [companyId, PlanCode.BASIC],
      [otherCompanyId, PlanCode.BASIC],
    ] as const)
      subscriptions.set(id.toString(), {
        _id: new Types.ObjectId(),
        companyId: id,
        planCode,
        activatedAt,
        planChangedAt: activatedAt,
        revision: 0,
      });
  });

  afterAll(() => app?.close());

  const authorization = (token: string) => ({
    Authorization: `Bearer ${token}`,
  });
  const rawToken = (call = sender.send.mock.calls.at(-1)) => {
    const url = call?.[0].text
      .split('\n')
      .find((line) => line.startsWith('https://'));
    if (!url) throw new Error('No invitation URL captured');
    return new URL(url).searchParams.get('token')!;
  };
  const invite = (email: string, token = ownerToken) =>
    request(app.getHttpServer())
      .post('/invitations')
      .set(authorization(token))
      .send({ email });

  it('permits only activated company owners and rejects tenant or role injection', async () => {
    await invite('new@example.com', memberToken).expect(403);
    await request(app.getHttpServer())
      .post('/invitations')
      .send({ email: 'new@example.com' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/invitations')
      .set(authorization(ownerToken))
      .send({
        email: 'new@example.com',
        companyId: otherCompanyId.toString(),
        role: Role.COMPANY_OWNER,
      })
      .expect(400);
    expect(invitations.size).toBe(0);
  });

  it('prevents members from listing, resending, or revoking invitations', async () => {
    await invite('managed@example.com').expect(202);
    const invitationId = [...invitations.keys()][0];
    await request(app.getHttpServer())
      .get('/invitations')
      .set(authorization(memberToken))
      .expect(403);
    await request(app.getHttpServer())
      .post(`/invitations/${invitationId}/resend`)
      .set(authorization(memberToken))
      .expect(403);
    await request(app.getHttpServer())
      .delete(`/invitations/${invitationId}`)
      .set(authorization(memberToken))
      .expect(403);
    expect(invitations.get(invitationId)?.status).toBe(
      InvitationStatus.PENDING,
    );
  });

  it('binds normalized invitations to the owner company and emails only the raw token', async () => {
    const response = await invite(' EMPLOYEE@EXAMPLE.COM ').expect(202);
    const state = [...invitations.values()][0];
    expect(state).toMatchObject({
      companyId: companyId.toString(),
      invitedBy: ownerId.toString(),
      email: 'employee@example.com',
      status: InvitationStatus.PENDING,
    });
    expect(state.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(response.body)).not.toContain(state.tokenHash!);
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'employee@example.com',
        subject: 'Join Acme on DataVault',
      }),
    );
    expect(rawToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('enforces Free, Basic, and Premium employee capacity including pending seats', async () => {
    subscriptions.get(companyId.toString())!.planCode = PlanCode.FREE;
    await invite('free@example.com').expect(403);

    subscriptions.get(companyId.toString())!.planCode = PlanCode.BASIC;
    // One accepted member already exists, leaving nine Basic employee seats.
    for (let index = 0; index < 9; index++)
      await invite(`basic-${index}@example.com`).expect(202);
    await invite('basic-over-limit@example.com').expect(403);

    subscriptions.get(companyId.toString())!.planCode = PlanCode.PREMIUM;
    await invite('premium-unlimited@example.com').expect(202);
  });

  it('accepts once, hashes the password, and derives company and member role', async () => {
    await invite('employee@example.com').expect(202);
    const token = rawToken();
    await request(app.getHttpServer())
      .post('/invitations/accept')
      .send({
        token,
        fullName: 'Employee Name',
        password: 'TenantPassword42!',
        companyId: otherCompanyId.toString(),
        role: Role.COMPANY_OWNER,
      })
      .expect(400);
    await request(app.getHttpServer())
      .post('/invitations/accept')
      .send({
        token,
        fullName: ' Employee Name ',
        password: 'TenantPassword42!',
      })
      .expect(200);
    const accepted = [...users.values()].find(
      (user) => user.email === 'employee@example.com',
    )!;
    expect(accepted.companyId.toString()).toBe(companyId.toString());
    expect(accepted.role).toBe(Role.COMPANY_MEMBER);
    expect(accepted.fullName).toBe('Employee Name');
    expect(await bcrypt.compare('TenantPassword42!', accepted.password!)).toBe(
      true,
    );
    const acceptedInvitation = [...invitations.values()][0];
    expect(acceptedInvitation.status).toBe(InvitationStatus.ACCEPTED);
    expect(acceptedInvitation).not.toHaveProperty('tokenHash');
    await request(app.getHttpServer())
      .post('/invitations/accept')
      .send({ token, fullName: 'Replay', password: 'TenantPassword42!' })
      .expect(400);
  });

  it('rejects invalid, expired, revoked, duplicate-email, and concurrent claims', async () => {
    await request(app.getHttpServer())
      .post('/invitations/accept')
      .send({
        token: 'a'.repeat(43),
        fullName: 'Employee',
        password: 'TenantPassword42!',
      })
      .expect(400);
    await invite('expired@example.com').expect(202);
    const expiredToken = rawToken();
    [...invitations.values()][0].expiresAt = new Date(Date.now() - 1);
    await request(app.getHttpServer())
      .post('/invitations/accept')
      .send({
        token: expiredToken,
        fullName: 'Employee',
        password: 'TenantPassword42!',
      })
      .expect(400);

    invitations.clear();
    await invite('revoked@example.com').expect(202);
    const revokedToken = rawToken();
    const invitationId = [...invitations.keys()][0];
    await request(app.getHttpServer())
      .delete(`/invitations/${invitationId}`)
      .set(authorization(ownerToken))
      .expect(200);
    await request(app.getHttpServer())
      .post('/invitations/accept')
      .send({
        token: revokedToken,
        fullName: 'Employee',
        password: 'TenantPassword42!',
      })
      .expect(400);
    await invite('member@example.com').expect(409);

    await invite('race@example.com').expect(202);
    const raceToken = rawToken();
    const acceptRacingInvitation = (fullName: string) =>
      request(app.getHttpServer()).post('/invitations/accept').send({
        token: raceToken,
        fullName,
        password: 'TenantPassword42!',
      });
    const results = await Promise.all([
      acceptRacingInvitation('First'),
      acceptRacingInvitation('Second'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect(
      [...users.values()].filter((user) => user.email === 'race@example.com'),
    ).toHaveLength(1);
  });

  it('serializes concurrent invitations so only one pending seat is reserved', async () => {
    const results = await Promise.all([
      invite('simultaneous@example.com'),
      invite('simultaneous@example.com'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([202, 409]);
    expect(
      [...invitations.values()].filter(
        (invitation) => invitation.email === 'simultaneous@example.com',
      ),
    ).toHaveLength(1);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('isolates listing/revocation and blocks downgrades with pending reservations', async () => {
    subscriptions.get(companyId.toString())!.planCode = PlanCode.PREMIUM;
    for (let index = 0; index < 10; index++)
      await invite(`pending-${index}@example.com`).expect(202);
    const ownId = [...invitations.keys()][0];
    await request(app.getHttpServer())
      .get('/invitations')
      .set(authorization(ownerToken))
      .expect(200)
      .expect(
        ({ body }: { body: { total: number; invitations: object[] } }) => {
          expect(body.total).toBe(10);
          expect(body.invitations).toHaveLength(10);
          expect(JSON.stringify(body)).not.toContain('tokenHash');
        },
      );
    await request(app.getHttpServer())
      .get('/invitations')
      .set(authorization(otherOwnerToken))
      .expect(200)
      .expect(({ body }: { body: { total: number } }) =>
        expect(body.total).toBe(0),
      );
    await request(app.getHttpServer())
      .delete(`/invitations/${ownId}`)
      .set(authorization(otherOwnerToken))
      .expect(404);
    await request(app.getHttpServer())
      .patch('/subscriptions/current')
      .set(authorization(ownerToken))
      .send({ planCode: PlanCode.BASIC })
      .expect(409);
  });

  it('serializes an invitation against a concurrent downgrade', async () => {
    users.delete(memberId.toString());
    subscriptions.get(companyId.toString())!.planCode = PlanCode.BASIC;

    const [invitationResponse, downgradeResponse] = await Promise.all([
      invite('race-with-plan@example.com'),
      request(app.getHttpServer())
        .patch('/subscriptions/current')
        .set(authorization(ownerToken))
        .send({ planCode: PlanCode.FREE }),
    ]);

    expect(
      [invitationResponse.status, downgradeResponse.status].sort(),
    ).toEqual([202, 409]);
    const currentPlan = subscriptions.get(companyId.toString())!.planCode;
    const pendingCount = [...invitations.values()].filter(
      (invitation) => invitation.status === InvitationStatus.PENDING,
    ).length;
    expect(
      currentPlan === PlanCode.FREE ? pendingCount === 0 : pendingCount === 1,
    ).toBe(true);
  });

  it('serializes concurrent plan changes without moving the billing anchor', async () => {
    users.delete(memberId.toString());
    const subscription = subscriptions.get(companyId.toString())!;
    const originalAnchor = subscription.activatedAt.getTime();

    const responses = await Promise.all([
      request(app.getHttpServer())
        .patch('/subscriptions/current')
        .set(authorization(ownerToken))
        .send({ planCode: PlanCode.PREMIUM }),
      request(app.getHttpServer())
        .patch('/subscriptions/current')
        .set(authorization(ownerToken))
        .send({ planCode: PlanCode.FREE }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect([PlanCode.PREMIUM, PlanCode.FREE]).toContain(subscription.planCode);
    expect(subscription.activatedAt.getTime()).toBe(originalAnchor);
    expect(subscription.revision).toBe(2);
  });

  it('rotates resend tokens, keeps responses generic, and recovers after SMTP failure', async () => {
    sender.send.mockRejectedValueOnce(new Error('SMTP unavailable'));
    await invite('employee@example.com').expect(503);
    expect(invitations.size).toBe(1);
    const invitation = [...invitations.values()][0];
    const oldHash = invitation.tokenHash;
    invitation.lastSentAt = new Date(
      Date.now() - INVITATION_RESEND_COOLDOWN_MS - 1,
    );
    await request(app.getHttpServer())
      .post(`/invitations/${invitation._id.toString()}/resend`)
      .set(authorization(ownerToken))
      .expect(202)
      .expect(RESEND_INVITATION_RESPONSE);
    const newToken = rawToken();
    expect(invitation.tokenHash).not.toBe(oldHash);
    await request(app.getHttpServer())
      .post(`/invitations/${new Types.ObjectId().toString()}/resend`)
      .set(authorization(ownerToken))
      .expect(202)
      .expect(RESEND_INVITATION_RESPONSE);
    expect(sender.send).toHaveBeenCalledTimes(2);
    await request(app.getHttpServer())
      .post('/invitations/accept')
      .send({
        token: newToken,
        fullName: 'Employee',
        password: 'TenantPassword42!',
      })
      .expect(200);
  });
});
