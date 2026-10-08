import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/config/configure-app';
import { PLATFORM_ADMIN_JWT } from '../src/admin/admin-security';
import { CompanyPlatformStatus } from '../src/companies/platform-status';
import { ObjectStorage } from '../src/aws-s3/object-storage';
import { EmailSender } from '../src/email/email-sender';
import { StripeClientService } from '../src/payments/stripe-client.service';
import { PaymentAccess } from '../src/payments/payment.constants';
import { adminFixture } from './admin.fixture';

describe('platform-admin / tenant security boundary (e2e, mocked infrastructure)', () => {
  let app: INestApplication<App>;
  let f: Awaited<ReturnType<typeof adminFixture>>;
  let platformToken: string;
  let ownerToken: string;
  let memberToken: string;
  let otherOwnerToken: string;
  const storage = {
    putObject: jest.fn(),
    getObject: jest.fn(),
    deleteObject: jest.fn(),
  };
  beforeEach(async () => {
    jest.clearAllMocks();
    f = await adminFixture();
    f.config.set('NODE_ENV', 'test');
    f.config.set('FILE_MAX_SIZE_BYTES', 10485760);
    // Deliberate identity collision proves isolation is not just collection IDs.
    f.users[0]._id = f.adminId;
    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(f.config)
      .overrideProvider(getConnectionToken())
      .useValue({
        ...f.connection,
        close: jest.fn(),
        readyState: 1,
        db: { admin: () => ({ ping: jest.fn().mockResolvedValue({ ok: 1 }) }) },
      })
      .overrideProvider(getModelToken('companyVerification'))
      .useValue({})
      .overrideProvider(getModelToken('adminAccessRequest'))
      .useValue({})
      .overrideProvider(getModelToken('googleOAuthState'))
      .useValue({})
      .overrideProvider(getModelToken('googleOAuthExchange'))
      .useValue({})
      .overrideProvider(getModelToken('plan'))
      .useValue({ bulkWrite: jest.fn() })
      .overrideProvider(getModelToken('stripeEvent'))
      .useValue({})
      .overrideProvider(getModelToken('stripeUsage'))
      .useValue({})
      .overrideProvider(StripeClientService)
      .useValue({ enabled: true, api: {} })
      .overrideProvider(ObjectStorage)
      .useValue(storage)
      .overrideProvider(EmailSender)
      .useValue(f.emailSender);
    for (const [name, model] of Object.entries(f.models))
      builder.overrideProvider(getModelToken(name)).useValue(model);
    const module = await builder.compile();
    app = module.createNestApplication<INestApplication<App>>({
      logger: false,
    });
    configureApp(app);
    await app.init();
    expect(app.get(PLATFORM_ADMIN_JWT)).toBeDefined();
    platformToken = f.jwt.sign({
      sub: f.adminId.toString(),
      type: 'platform_admin',
    });
    ownerToken = f.tenantJwt.sign({
      id: (f.users[1]._id as Types.ObjectId).toString(),
    });
    memberToken = f.tenantJwt.sign({
      id: (f.users[3]._id as Types.ObjectId).toString(),
    });
    otherOwnerToken = f.tenantJwt.sign({ id: f.adminId.toString() });
  });
  afterEach(async () => {
    await app?.close();
  });
  const auth = (token = platformToken) => ({
    Authorization: `Bearer ${token}`,
  });
  const betaId = () => (f.companies[1]._id as Types.ObjectId).toString();

  it('logs in securely without a public administrator registration endpoint', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: '  PLATFORM@fixture.test ', password: f.password })
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    const body = response.body as { accessToken: string };
    expect(await f.jwt.verifyAsync(body.accessToken)).toMatchObject({
      type: 'platform_admin',
      sub: f.adminId.toString(),
    });
    expect(f.adminaudits[0].action).toBe('login_succeeded');
    expect(JSON.stringify(response.body)).not.toContain(f.password);
    await request(app.getHttpServer())
      .post('/admin/auth/register')
      .send({ email: 'new@fixture.test', password: f.password })
      .expect(404);
    await request(app.getHttpServer())
      .post('/admin/auth/sign-up')
      .send({})
      .expect(404);
    expect(f.platformadmins).toHaveLength(1);
  });

  it('recovers an admin by email with a one-use link and revokes old sessions', async () => {
    const generic = {
      message:
        'If this is an active platform admin email, a reset link will arrive shortly.',
    };
    const unknown = await request(app.getHttpServer())
      .post('/admin/auth/forgot-password')
      .send({ email: 'unknown@fixture.test' })
      .expect(200);
    expect(unknown.body).toEqual(generic);
    expect(f.emailSender.send).not.toHaveBeenCalled();

    const requested = await request(app.getHttpServer())
      .post('/admin/auth/forgot-password')
      .send({ email: ' PLATFORM@fixture.test ' })
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    expect(requested.body).toEqual(generic);
    expect(f.emailSender.send).toHaveBeenCalledTimes(1);
    const message = f.emailSender.send.mock.calls[0][0];
    expect(message.to).toBe('platform@fixture.test');
    expect(message.text).toContain('https://client.fixture.test/admin#reset=');
    const resetToken = message.text.match(/#reset=([A-Za-z0-9_-]{43})/)?.[1];
    expect(resetToken).toBeDefined();
    expect(JSON.stringify(f.platformadmins)).not.toContain(resetToken);

    await request(app.getHttpServer())
      .post('/admin/auth/forgot-password')
      .send({ email: 'platform@fixture.test' })
      .expect(200);
    expect(f.emailSender.send).toHaveBeenCalledTimes(1);

    const newPassword = 'New-Platform-Password42!';
    await request(app.getHttpServer())
      .post('/admin/auth/reset-password')
      .send({ token: resetToken, newPassword })
      .expect(200)
      .expect({ reset: true });
    await request(app.getHttpServer())
      .get('/admin/dashboard')
      .set(auth())
      .expect(401);
    await request(app.getHttpServer())
      .post('/admin/auth/reset-password')
      .send({ token: resetToken, newPassword })
      .expect(401);
    await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'platform@fixture.test', password: f.password })
      .expect(401);
    const fresh = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'platform@fixture.test', password: newPassword })
      .expect(200);
    await request(app.getHttpServer())
      .get('/admin/dashboard')
      .set(auth((fresh.body as { accessToken: string }).accessToken))
      .expect(200);
    expect(f.adminaudits.some((row) => row.action === 'password_reset')).toBe(
      true,
    );
  });

  it('rejects expired links and keeps the password unchanged if reset auditing fails', async () => {
    await request(app.getHttpServer())
      .post('/admin/auth/forgot-password')
      .send({ email: 'platform@fixture.test' })
      .expect(200);
    const message = f.emailSender.send.mock.calls[0][0];
    const resetToken = message.text.match(/#reset=([A-Za-z0-9_-]{43})/)?.[1];
    const admin = f.platformadmins[0];
    admin.passwordResetExpiresAt = new Date(Date.now() - 1000);
    await request(app.getHttpServer())
      .post('/admin/auth/reset-password')
      .send({ token: resetToken, newPassword: 'Another-Platform-Password42!' })
      .expect(401);
    f.platformadmins[0].passwordResetExpiresAt = new Date(Date.now() + 60000);
    f.models.adminAudit.create.mockRejectedValueOnce(
      new Error('audit unavailable'),
    );
    await request(app.getHttpServer())
      .post('/admin/auth/reset-password')
      .send({ token: resetToken, newPassword: 'Another-Platform-Password42!' })
      .expect(503);
    await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'platform@fixture.test', password: f.password })
      .expect(200);
    expect(f.platformadmins[0].passwordResetTokenHash).toBeDefined();
  });

  it('rate-limits generic failed admin login attempts and audits only safe information', async () => {
    for (let index = 0; index < 5; index++)
      await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: 'unknown@fixture.test', password: 'incorrect' })
        .expect(401);
    await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'unknown@fixture.test', password: 'incorrect' })
      .expect(429);
    expect(f.adminaudits).toHaveLength(5);
    expect(f.adminaudits.every((row) => row.action === 'login_failed')).toBe(
      true,
    );
    expect(JSON.stringify(f.adminaudits)).not.toMatch(
      /unknown@|incorrect|password|jwt/,
    );
  });

  it.each([
    '/admin/dashboard',
    '/admin/companies',
    '/admin/users',
    '/admin/files',
    '/admin/audit-logs',
  ])(
    'denies ordinary owners/members and anonymous access to %s',
    async (endpoint) => {
      for (const token of [ownerToken, memberToken, otherOwnerToken])
        await request(app.getHttpServer())
          .get(endpoint)
          .set(auth(token))
          .expect(401);
      await request(app.getHttpServer()).get(endpoint).expect(401);
    },
  );

  it('denies tenant mutation access through platform JWTs, including colliding IDs and forged scope', async () => {
    for (const endpoint of [
      '/auth/current-user',
      '/companies/current',
      '/users',
      '/subscriptions/current',
      '/statistics/current',
      '/files',
      `/files/${(f.companyfiles[0]._id as Types.ObjectId).toString()}/download`,
    ])
      await request(app.getHttpServer()).get(endpoint).set(auth()).expect(401);
    await request(app.getHttpServer())
      .post('/payments/plan')
      .set(auth())
      .send({ planCode: 'premium' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/invitations')
      .set(auth())
      .send({ email: 'new@fixture.test' })
      .expect(401);
    const wrongPurpose = f.tenantJwt.sign({
      id: (f.users[1]._id as Types.ObjectId).toString(),
      type: 'platform_admin',
    });
    await request(app.getHttpServer())
      .get('/auth/current-user')
      .set(auth(wrongPurpose))
      .expect(401);
    expect(storage.getObject).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('returns globally authoritative dashboard metrics with private no-store caching', async () => {
    const response = await request(app.getHttpServer())
      .get('/admin/dashboard')
      .set(auth())
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    expect(response.body).toMatchObject({
      companies: {
        total: 3,
        activated: 2,
        byPlan: { free: 1, basic: 1, premium: 1 },
      },
      tenantUsers: { total: 4, members: 1 },
      pendingInvitations: 1,
      currentlyStoredFiles: { total: 3, restricted: 1 },
      currentCompanyBillingPeriods: {
        successfulUploads: 1011,
        recordedOverageCents: 100,
        isCollectedRevenue: false,
      },
      stripe: { managedCompanies: 2, paymentAttentionCompanies: 0 },
    });
  });

  it('safely lists/filter/sorts companies and exposes sanitized detail with billing estimates', async () => {
    const list = await request(app.getHttpServer())
      .get(
        '/admin/companies?plan=basic&activation=activated&status=active&stripeManaged=true&sortBy=name&order=asc&limit=1',
      )
      .set(auth())
      .expect(200);
    expect(list.body).toMatchObject({
      items: [{ name: 'Beta' }],
      pagination: { total: 1, limit: 1, page: 1 },
    });
    const detail = await request(app.getHttpServer())
      .get(`/admin/companies/${betaId()}`)
      .set(auth())
      .expect(200);
    expect(detail.body).toMatchObject({
      owner: { email: 'owner1@fixture.test' },
      employees: { accepted: 1, pendingInvitations: 1 },
      currentlyStoredFiles: { total: 2, companyWide: 1, restricted: 1 },
      billingEstimate: { totalAmountCents: 500, successfulUploads: 7 },
    });
    expect(JSON.stringify([list.body, detail.body])).not.toMatch(
      /password|tokenHash|hidden-|stripeCheckoutOperation|stripeLeaseToken|storageKey/,
    );
  });

  it('permits metadata-only file/user operations and preserves tenant file isolation', async () => {
    const files = await request(app.getHttpServer())
      .get(`/admin/files?companyId=${betaId()}&visibility=restricted`)
      .set(auth())
      .expect(200);
    const users = await request(app.getHttpServer())
      .get(`/admin/users?companyId=${betaId()}&role=company_member`)
      .set(auth())
      .expect(200);
    expect(files.body).toMatchObject({
      pagination: { total: 1 },
      items: [{ visibility: 'restricted', originalFilename: 'sheet2.csv' }],
    });
    expect(users.body).toMatchObject({
      pagination: { total: 1 },
      items: [{ email: 'employee@fixture.test' }],
    });
    expect(JSON.stringify([files.body, users.body])).not.toMatch(
      /storageKey|hidden-|password|tokenHash/,
    );
    await request(app.getHttpServer())
      .get(
        `/admin/files/${(f.companyfiles[2]._id as Types.ObjectId).toString()}/download`,
      )
      .set(auth())
      .expect(404);
    const ownFiles = await request(app.getHttpServer())
      .get('/files')
      .set(auth(otherOwnerToken))
      .expect(200);
    expect(ownFiles.body).toMatchObject({ total: 1 });
    await request(app.getHttpServer())
      .get(`/files/${(f.companyfiles[2]._id as Types.ObjectId).toString()}`)
      .set(auth(otherOwnerToken))
      .expect(404);
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it('suspension blocks fresh owner/member/Google login and existing JWTs without changing billing or data', async () => {
    const preserved = JSON.stringify([
      f.users,
      f.subscriptions,
      f.companyfiles,
      f.subscriptionperiods,
      f.employeeinvitations,
    ]);
    await request(app.getHttpServer())
      .get('/auth/current-user')
      .set(auth(ownerToken))
      .expect(200);
    for (const email of ['owner1@fixture.test', 'employee@fixture.test'])
      await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email, password: f.tenantPassword })
        .expect(201);
    await request(app.getHttpServer())
      .post(`/admin/companies/${betaId()}/suspend`)
      .set(auth())
      .send({ reason: 'security_review' })
      .expect(200);
    for (const token of [ownerToken, memberToken])
      for (const endpoint of [
        '/auth/current-user',
        '/files',
        '/statistics/current',
        '/subscriptions/current',
        '/users',
        '/companies/current',
      ])
        await request(app.getHttpServer())
          .get(endpoint)
          .set(auth(token))
          .expect(401);
    for (const email of ['owner1@fixture.test', 'employee@fixture.test'])
      await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email, password: f.tenantPassword })
        .expect(401);
    // Directly exercise the same Google service path (no provider network calls).
    await expect(
      f.tenantAuth.signInWithGoogle({
        email: 'employee@fixture.test',
        fullName: 'Employee',
      }),
    ).rejects.toThrow('Account is unavailable');
    await request(app.getHttpServer())
      .get('/files')
      .set(auth(otherOwnerToken))
      .expect(200);
    expect(
      JSON.stringify([
        f.users,
        f.subscriptions,
        f.companyfiles,
        f.subscriptionperiods,
        f.employeeinvitations,
      ]),
    ).toBe(preserved);
    expect(f.adminaudits).toHaveLength(1);
    expect(f.adminaudits[0]).toMatchObject({
      action: 'company_suspended',
      targetType: 'company',
      nextStatus: 'suspended',
    });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('reactivation restores issued JWT access but preserves inactive and failed-payment restrictions', async () => {
    await request(app.getHttpServer())
      .post(`/admin/companies/${betaId()}/suspend`)
      .set(auth())
      .send({ reason: 'operational_hold' })
      .expect(200);
    f.subscriptions[1].paymentAccess = PaymentAccess.SUSPENDED;
    const preserved = JSON.stringify(f.subscriptions[1]);
    await request(app.getHttpServer())
      .post(`/admin/companies/${betaId()}/reactivate`)
      .set(auth())
      .send({})
      .expect(200);
    for (const token of [ownerToken, memberToken])
      await request(app.getHttpServer())
        .get('/files')
        .set(auth(token))
        .expect(200);
    for (const email of ['owner1@fixture.test', 'employee@fixture.test'])
      await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email, password: f.tenantPassword })
        .expect(201);
    await request(app.getHttpServer())
      .post('/files')
      .set(auth(ownerToken))
      .attach('file', Buffer.from('name,value\nitem,1\n'), {
        filename: 'example.csv',
        contentType: 'text/csv',
      })
      .expect(403);
    expect(JSON.stringify(f.subscriptions[1])).toBe(preserved);
    expect(storage.putObject).not.toHaveBeenCalled();
    const inactiveId = (f.companies[2]._id as Types.ObjectId).toString();
    await request(app.getHttpServer())
      .post(`/admin/companies/${inactiveId}/suspend`)
      .set(auth())
      .send({ reason: 'policy_review' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/companies/${inactiveId}/reactivate`)
      .set(auth())
      .send({})
      .expect(200);
    const inactiveToken = f.tenantJwt.sign({
      id: (f.users[2]._id as Types.ObjectId).toString(),
    });
    await request(app.getHttpServer())
      .get('/auth/current-user')
      .set(auth(inactiveToken))
      .expect(401);
    expect(
      f.adminaudits
        .filter((row) => row.targetType === 'company')
        .map((row) => row.action),
    ).toEqual([
      'company_suspended',
      'company_reactivated',
      'company_suspended',
      'company_reactivated',
    ]);
  });

  it('public invitation acceptance cannot onboard an employee into a suspended company', async () => {
    const token = 'a'.repeat(43);
    f.employeeinvitations[0].tokenHash = createHash('sha256')
      .update(token)
      .digest('hex');
    const preserved = JSON.stringify([
      f.users,
      f.employeeinvitations,
      f.subscriptions,
    ]);
    await request(app.getHttpServer())
      .post(`/admin/companies/${betaId()}/suspend`)
      .set(auth())
      .send({ reason: 'policy_review' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/invitations/accept')
      .send({ token, fullName: 'New Employee', password: f.tenantPassword })
      .expect(400);
    expect(
      JSON.stringify([f.users, f.employeeinvitations, f.subscriptions]),
    ).toBe(preserved);
  });

  it('blocks tenant owners from status management and prevents status/identity injection', async () => {
    for (const token of [ownerToken, memberToken])
      await request(app.getHttpServer())
        .post(`/admin/companies/${betaId()}/suspend`)
        .set(auth(token))
        .send({ reason: 'security_review' })
        .expect(401);
    await request(app.getHttpServer())
      .post(`/admin/companies/${betaId()}/suspend`)
      .set(auth())
      .send({
        reason: 'security_review',
        companyId: (f.companies[0]._id as Types.ObjectId).toString(),
        actorId: 'injected',
      })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/admin/companies/${betaId()}/suspend`)
      .set(auth())
      .send({ reason: 'sensitive arbitrary text' })
      .expect(400);
    await request(app.getHttpServer())
      .patch('/companies/current')
      .set(auth(ownerToken))
      .send({ platformStatus: 'suspended', platformStatusChangedBy: f.adminId })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/admin/companies/${betaId()}/reactivate`)
      .set(auth())
      .send({ stripeStatus: 'active' })
      .expect(400);
    expect(f.companies[1].platformStatus).toBe(CompanyPlatformStatus.ACTIVE);
    expect(f.adminaudits).toHaveLength(0);
  });

  it('exposes bounded read-only audit logs with safe filters and no modification routes', async () => {
    await request(app.getHttpServer())
      .post(`/admin/companies/${betaId()}/suspend`)
      .set(auth())
      .send({ reason: 'policy_review' })
      .expect(200);
    const logs = await request(app.getHttpServer())
      .get(
        `/admin/audit-logs?action=company_suspended&targetId=${betaId()}&limit=1`,
      )
      .set(auth())
      .expect(200);
    expect(logs.body).toMatchObject({
      pagination: { total: 1 },
      items: [
        {
          action: 'company_suspended',
          reason: 'policy_review',
          actorId: f.adminId.toString(),
          targetId: betaId(),
        },
      ],
    });
    expect(JSON.stringify(logs.body)).not.toMatch(
      /password|token|signature|email/,
    );
    const id = (f.adminaudits[0]._id as Types.ObjectId).toString();
    await request(app.getHttpServer())
      .patch(`/admin/audit-logs/${id}`)
      .set(auth())
      .send({ action: 'login_succeeded' })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/admin/audit-logs/${id}`)
      .set(auth())
      .expect(404);
    expect(f.adminaudits).toHaveLength(1);
  });

  it.each([
    'limit=101',
    'page=0',
    'page=1001',
    'sortBy=password',
    'order=arbitrary',
    'plan=admin',
    'status=deleted',
    'paymentAccess=paid',
    'stripeManaged=yes',
    'search[$ne]=anything',
    'search=' + 'a'.repeat(81),
    'companyId=invalid',
  ])('rejects unsafe admin query: %s', async (query) => {
    await request(app.getHttpServer())
      .get(`/admin/companies?${query}`)
      .set(auth())
      .expect(400);
  });

  it('returns validated 400/404/409 states and rechecks disabled admin accounts', async () => {
    await request(app.getHttpServer())
      .get('/admin/companies/not-an-id')
      .set(auth())
      .expect(400);
    await request(app.getHttpServer())
      .get(`/admin/companies/${new Types.ObjectId().toString()}`)
      .set(auth())
      .expect(404);
    await request(app.getHttpServer())
      .post(`/admin/companies/${betaId()}/reactivate`)
      .set(auth())
      .send({})
      .expect(409);
    f.platformadmins[0].isActive = false;
    await request(app.getHttpServer())
      .get('/admin/dashboard')
      .set(auth())
      .expect(401);
  });
});
