import { CliFailure, CliFailureCategory, safeCliCategory } from './cli-errors';
import {
  SmokeOperator,
  SmokeResponse,
  SmokeTransport,
  activateSmokeCompany,
  authenticateSmokeAdmin,
  platformAdminSmokeTest,
  resumePlatformAdminSmokeTest,
  smokeActivationToken,
  smokeBaseUrl,
  smokeCommand,
} from './admin-smoke-test.service';

const id = '1234567890abcdef12345678';
const fixtureName = 'DataVault admin smoke unit-test';
const operator: SmokeOperator = {
  email: 'accessible@fixture.test',
  password: 'TenantPass42!',
  fullName: 'Test Operator',
  country: 'US',
  industry: 'Software',
  adminToken: 'secret-admin-jwt',
};
function fixture() {
  let activated = false,
    suspended = false;
  const auditItems: Array<Record<string, unknown>> = [];
  const detail = {
    company: {
      id,
      name: fixtureName,
      country: 'US',
      industry: 'Software',
      createdAt: '2026-09-18T10:00:00Z',
      activatedAt: '2026-09-18T10:01:00Z',
      platformStatus: 'active',
      updatedAt: '2026-09-18T10:01:00Z',
    },
    owner: { email: operator.email },
    employees: { accepted: 0, pendingInvitations: 0 },
    currentlyStoredFiles: { total: 0 },
    subscription: {
      planCode: 'free',
      activatedAt: '2026-09-18T10:00:00Z',
      planChangedAt: '2026-09-18T10:00:00Z',
    },
    billingEstimate: {
      successfulUploads: 0,
      overageChargeCents: 0,
      totalAmountCents: 0,
      billingPeriod: { startsAt: '2026-09-18', endsAt: '2026-10-18' },
    },
    stripe: null as unknown,
    integrityWarnings: [],
  };
  const implementation: SmokeTransport['request'] = async (
    method,
    path,
    token,
  ) => {
    await Promise.resolve(); // Model the HTTP client's asynchronous boundary.
    if (path === '/admin/dashboard')
      return { status: token === operator.adminToken ? 200 : 401, body: {} };
    if (path.startsWith('/admin/audit-logs?'))
      return {
        status: token === operator.adminToken ? 200 : 401,
        body: {
          items: JSON.parse(JSON.stringify(auditItems)) as unknown,
          pagination: { page: 1, limit: 100, total: auditItems.length },
        },
      };
    if (path.startsWith('/admin/companies?'))
      return {
        status: 200,
        body: {
          items: [{ id, name: fixtureName }],
          pagination: { page: 1, limit: 100, total: 1 },
        },
      };
    if (path === '/auth/sign-up') return { status: 202, body: {} };
    if (path === '/auth/sign-in')
      return {
        status: activated && !suspended ? 201 : 401,
        body:
          activated && !suspended
            ? { accessToken: 'secret-tenant-jwt' }
            : { message: 'private email and token must not be printed' },
      };
    if (path === '/auth/current-user')
      return {
        status: activated && !suspended ? 200 : 401,
        body: { companyId: id, email: operator.email, role: 'company_owner' },
      };
    if (path === `/admin/companies/${id}/suspend` && method === 'POST') {
      suspended = true;
      detail.company.platformStatus = 'suspended';
      Object.assign(detail.company, {
        platformStatusReason: 'operational_hold',
        updatedAt: '2026-09-18T10:02:00Z',
      });
      auditItems.push({
        action: 'company_suspended',
        targetId: id,
        targetType: 'company',
        reason: 'operational_hold',
        previousStatus: 'active',
        nextStatus: 'suspended',
      });
      return { status: 200, body: {} };
    }
    if (path === `/admin/companies/${id}/reactivate` && method === 'POST') {
      suspended = false;
      detail.company.platformStatus = 'active';
      Object.assign(detail.company, {
        platformStatusReason: 'review_completed',
        updatedAt: '2026-09-18T10:03:00Z',
      });
      auditItems.push({
        action: 'company_reactivated',
        targetId: id,
        targetType: 'company',
        reason: 'review_completed',
        previousStatus: 'suspended',
        nextStatus: 'active',
      });
      return { status: 200, body: {} };
    }
    if (path === `/admin/companies/${id}`)
      return {
        status: 200,
        body: JSON.parse(JSON.stringify(detail)) as unknown,
      };
    throw new Error('Unknown smoke route');
  };
  const request = jest.fn(implementation);
  const activateNormally = jest.fn(() => {
    activated = true;
    return Promise.resolve();
  });
  const progress = jest.fn();
  const run = () =>
    platformAdminSmokeTest(
      { request },
      operator,
      activateNormally,
      progress,
      fixtureName,
    );
  return { request, implementation, activateNormally, progress, run, detail };
}

describe('platform-admin interactive HTTP smoke workflow', () => {
  it('extracts a strict activation token from raw input or a frontend activation URL', () => {
    const token = 'a'.repeat(43);
    expect(smokeActivationToken(` ${token} `)).toBe(token);
    expect(
      smokeActivationToken(
        `https://client.example.test/auth/activate?token=${token}`,
      ),
    ).toBe(token);
    expect(
      smokeActivationToken(`http://localhost:3001/activate?token=${token}`),
    ).toBe(token);
  });
  it.each([
    'short',
    `http://public.example.test/activate?token=${'a'.repeat(43)}`,
    `https://user:secret@client.example.test/activate?token=${'a'.repeat(43)}`,
    `https://client.example.test/activate?token=${'a'.repeat(43)}&companyId=${id}`,
    `https://client.example.test/activate?token=${'a'.repeat(43)}#secret`,
  ])(
    'rejects malformed or unsafe activation input without exposing it (%#)',
    (value) => {
      let failure: unknown;
      try {
        smokeActivationToken(value);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        category: CliFailureCategory.INVALID_SMOKE_CONFIGURATION,
      });
      expect(String(failure)).not.toContain(value);
    },
  );
  it('submits the hidden token only to the normal backend verification endpoint', async () => {
    const token = 'b'.repeat(43);
    const request = jest.fn().mockResolvedValue({ status: 200, body: {} });
    await expect(
      activateSmokeCompany(
        { request },
        `https://client.example.test/auth/activate?token=${token}`,
      ),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/auth/verify-account',
      undefined,
      { token },
    );
    request.mockResolvedValueOnce({ status: 400, body: { token } });
    let failure: unknown;
    try {
      await activateSmokeCompany({ request }, token);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ stage: 'activation', status: 400 });
    expect(String(failure)).not.toContain(token);
  });
  it('parses explicit new and resume commands and refuses arbitrary fixture names', () => {
    expect(
      smokeCommand([
        '--base-url',
        'http://127.0.0.1:3000',
        '--confirm-test-tenant',
      ]),
    ).toEqual({ mode: 'register', origin: 'http://127.0.0.1:3000' });
    const name = 'DataVault admin smoke 48bea95a-3f15-47a9-b5e5-c52c3aed3bc5';
    expect(
      smokeCommand([
        '--base-url',
        'http://127.0.0.1:3000',
        '--resume-fixture',
        name,
        '--confirm-test-tenant',
      ]),
    ).toEqual({
      mode: 'resume',
      origin: 'http://127.0.0.1:3000',
      fixtureName: name,
    });
    expect(() =>
      smokeCommand([
        '--base-url',
        'http://127.0.0.1:3000',
        '--resume-fixture',
        'Legitimate company',
        '--confirm-test-tenant',
      ]),
    ).toThrow(CliFailureCategory.INVALID_SMOKE_CONFIGURATION);
  });
  it('distinguishes a rejected supplied token without attempting registration', async () => {
    const request = jest.fn().mockResolvedValue({ status: 401, body: {} });
    await expect(
      authenticateSmokeAdmin(
        { request },
        { kind: 'supplied_token', token: ' expired-token ' },
      ),
    ).rejects.toMatchObject({
      stage: 'supplied_admin_jwt_rejected',
      status: 401,
    });
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/admin/dashboard',
      'expired-token',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('distinguishes rejected credentials from a token rejected after issuance', async () => {
    const rejected = jest.fn().mockResolvedValue({ status: 401, body: {} });
    await expect(
      authenticateSmokeAdmin(
        { request: rejected },
        {
          kind: 'credentials',
          email: 'platform@fixture.test',
          password: 'not-logged',
        },
      ),
    ).rejects.toMatchObject({
      stage: 'admin_credentials_rejected',
      status: 401,
    });
    expect(rejected).toHaveBeenCalledWith(
      'POST',
      '/admin/auth/login',
      undefined,
      {
        email: 'platform@fixture.test',
        password: 'not-logged',
      },
    );
    expect(rejected).toHaveBeenCalledTimes(1);

    const issued = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: { accessToken: 'issued-secret-token' },
      })
      .mockResolvedValueOnce({ status: 401, body: {} });
    await expect(
      authenticateSmokeAdmin(
        { request: issued },
        {
          kind: 'credentials',
          email: 'platform@fixture.test',
          password: 'not-logged',
        },
      ),
    ).rejects.toMatchObject({
      stage: 'admin_issued_jwt_rejected',
      status: 401,
    });
  });
  it.each([
    [new Error('private endpoint failure'), 'admin_endpoint_unreachable'],
    [{ status: 404, body: {} }, 'admin_endpoint_misconfigured'],
    [{ status: 503, body: {} }, 'admin_endpoint_unavailable'],
  ])(
    'classifies safe endpoint diagnostics without emitting response data',
    async (result, stage) => {
      const request = jest.fn();
      if (result instanceof Error) request.mockRejectedValue(result);
      else request.mockResolvedValue(result);
      let failure: unknown;
      try {
        await authenticateSmokeAdmin(
          { request },
          { kind: 'supplied_token', token: 'private-token' },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ stage });
      expect(String(failure)).not.toMatch(/private endpoint|private-token/);
    },
  );
  it('classifies a successful login response without a token as endpoint misconfiguration', async () => {
    const request = jest.fn().mockResolvedValue({
      status: 200,
      body: { password: 'must-not-be-logged' },
    });
    await expect(
      authenticateSmokeAdmin(
        { request },
        {
          kind: 'credentials',
          email: 'platform@fixture.test',
          password: 'private-password',
        },
      ),
    ).rejects.toMatchObject({
      stage: 'admin_endpoint_misconfigured',
      status: 200,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('uses normal signup/activation and the ORIGINAL JWT throughout; never calls activation overrides or providers', async () => {
    const f = fixture();
    expect(await f.run()).toEqual({
      companyId: id,
      fixtureName,
      passed: true,
      activatedFixtureRetained: true,
    });
    expect(f.activateNormally).toHaveBeenCalledTimes(1);
    const calls = f.request.mock.calls;
    expect(
      calls
        .filter(([, path]) => path === '/auth/current-user')
        .map((call) => call[2]),
    ).toEqual(['secret-tenant-jwt', 'secret-tenant-jwt', 'secret-tenant-jwt']);
    expect(calls.find(([, path]) => path.endsWith('/suspend'))).toEqual([
      'POST',
      `/admin/companies/${id}/suspend`,
      operator.adminToken,
      { reason: 'operational_hold' },
    ]);
    expect(
      calls.some(([, path]) => path.startsWith('/admin/audit-logs?targetId=')),
    ).toBe(true);
    expect(f.progress).toHaveBeenCalledWith(
      'platform_admin_remains_functional',
    );
    expect(f.progress).toHaveBeenCalledWith('audit_events');
    expect(
      calls.every(
        ([, path]) => !/verify|payments|download|bootstrap/.test(path),
      ),
    ).toBe(true);
    expect(JSON.stringify(f.progress.mock.calls)).not.toMatch(
      /secret|fixture.test|TenantPass/,
    );
  });
  it('resumes the exact pristine inactive fixture without registering or rotating its token', async () => {
    const f = fixture();
    f.detail.company.activatedAt = null as unknown as string;
    const activate = jest.fn(() => {
      f.detail.company.activatedAt = '2026-09-18T10:01:00Z';
      return f.activateNormally();
    });
    await expect(
      resumePlatformAdminSmokeTest(
        { request: f.request },
        {
          email: operator.email,
          password: operator.password,
          adminToken: operator.adminToken,
        },
        activate,
        fixtureName,
        f.progress,
      ),
    ).resolves.toMatchObject({ passed: true, companyId: id, fixtureName });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(
      f.request.mock.calls.some(([, path]) => path === '/auth/sign-up'),
    ).toBe(false);
    expect(
      f.request.mock.calls.some(
        ([method, path]) =>
          method === 'POST' && path === '/auth/verify-account',
      ),
    ).toBe(false);
    expect(f.progress).toHaveBeenCalledWith('resume_fixture_safety');
    expect(f.progress).toHaveBeenCalledWith('activation');
  });
  it('refuses a mismatched resume fixture before activation, login, or mutation', async () => {
    const f = fixture();
    f.detail.company.activatedAt = null as unknown as string;
    f.detail.owner.email = 'different@fixture.test';
    await expect(
      resumePlatformAdminSmokeTest(
        { request: f.request },
        {
          email: operator.email,
          password: operator.password,
          adminToken: operator.adminToken,
        },
        f.activateNormally,
        fixtureName,
      ),
    ).rejects.toMatchObject({ stage: 'resume_fixture_safety' });
    expect(f.activateNormally).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.some(
        ([method, path]) =>
          method === 'POST' &&
          ['/auth/sign-up', '/auth/sign-in'].includes(path),
      ),
    ).toBe(false);
  });
  it('continues an already activated pristine fixture without asking for the token again', async () => {
    const f = fixture();
    await f.activateNormally();
    f.activateNormally.mockClear();
    await expect(
      resumePlatformAdminSmokeTest(
        { request: f.request },
        {
          email: operator.email,
          password: operator.password,
          adminToken: operator.adminToken,
        },
        f.activateNormally,
        fixtureName,
        f.progress,
      ),
    ).resolves.toMatchObject({ passed: true, companyId: id });
    expect(f.activateNormally).not.toHaveBeenCalled();
    expect(f.progress).toHaveBeenCalledWith('activation_already_complete');
  });
  it('fails safely when the expected append-only company audit events are absent', async () => {
    const f = fixture();
    f.request.mockImplementation(async (...args) => {
      if (args[1].startsWith('/admin/audit-logs?'))
        return {
          status: 200,
          body: { items: [], pagination: { page: 1, limit: 100, total: 0 } },
        };
      return f.implementation(...args);
    });
    await expect(f.run()).rejects.toMatchObject({ stage: 'audit_events' });
    expect(f.detail.company.platformStatus).toBe('active');
  });
  it('does not register if platform authentication fails', async () => {
    const f = fixture();
    const registrationAttempt = jest.fn();
    f.request.mockResolvedValueOnce({
      status: 401,
      body: { token: 'sensitive' },
    });
    await expect(
      platformAdminSmokeTest(
        { request: f.request },
        operator,
        f.activateNormally,
        f.progress,
        fixtureName,
        registrationAttempt,
      ),
    ).rejects.toMatchObject({
      stage: 'admin_authentication',
      status: 401,
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(registrationAttempt).not.toHaveBeenCalled();
  });
  it.each([409, 503])(
    'does not sign into or suspend an existing/uncertain tenant after registration HTTP %s',
    async (status) => {
      const f = fixture();
      const registrationAttempt = jest.fn();
      f.request.mockImplementation(async (...args) =>
        args[1] === '/auth/sign-up'
          ? { status, body: { message: 'private error contents' } }
          : f.implementation(...args),
      );
      await expect(
        platformAdminSmokeTest(
          { request: f.request },
          operator,
          f.activateNormally,
          f.progress,
          fixtureName,
          registrationAttempt,
        ),
      ).rejects.toMatchObject({
        stage: 'registration',
        status,
      });
      expect(registrationAttempt).toHaveBeenCalledTimes(1);
      expect(f.activateNormally).not.toHaveBeenCalled();
      expect(
        f.request.mock.calls.some(
          ([, path]) => path.endsWith('/suspend') || path === '/auth/sign-in',
        ),
      ).toBe(false);
    },
  );
  it('does not bypass email activation when login is still rejected', async () => {
    const f = fixture();
    f.activateNormally.mockImplementation(() => Promise.resolve());
    await expect(f.run()).rejects.toMatchObject({
      stage: 'tenant_login',
      status: 401,
    });
    expect(
      f.request.mock.calls.some(([, path]) => path.endsWith('/suspend')),
    ).toBe(false);
  });
  it.each([
    'different_name',
    'paid_plan',
    'files',
    'usage',
    'employees',
    'invitations',
    'stripe',
    'plan_history',
    'platform_history',
  ])('refuses a fixture with %s before any suspension', async (change) => {
    const f = fixture();
    if (change === 'different_name')
      f.detail.company.name = 'Legitimate company';
    if (change === 'paid_plan') f.detail.subscription.planCode = 'premium';
    if (change === 'files') f.detail.currentlyStoredFiles.total = 1;
    if (change === 'usage') f.detail.billingEstimate.successfulUploads = 1;
    if (change === 'employees') f.detail.employees.accepted = 1;
    if (change === 'invitations') f.detail.employees.pendingInvitations = 1;
    if (change === 'stripe') f.detail.stripe = { subscriptionId: 'sub_other' };
    if (change === 'plan_history')
      f.detail.subscription.planChangedAt = '2026-09-18T10:02:00Z';
    if (change === 'platform_history')
      Object.assign(f.detail.company, {
        platformStatusReason: 'review_completed',
      });
    await expect(f.run()).rejects.toMatchObject({ stage: 'fixture_safety' });
    expect(
      f.request.mock.calls.some(([, path]) => path.endsWith('/suspend')),
    ).toBe(false);
  });
  it('detects unintended usage changes and safely restores only its dedicated suspended fixture', async () => {
    const f = fixture();
    f.request.mockImplementation(async (...args) => {
      const response = await f.implementation(...args);
      if (args[1].endsWith('/suspend'))
        f.detail.billingEstimate.successfulUploads = 1;
      return response;
    });
    await expect(f.run()).rejects.toMatchObject({ stage: 'state_preserved' });
    expect(f.detail.company.platformStatus).toBe('active');
    expect(
      f.request.mock.calls.filter(([, path]) => path.endsWith('/reactivate')),
    ).toHaveLength(1);
    expect(f.progress).toHaveBeenCalledWith('recovery');
  });
  it('handles a committed suspension with a lost HTTP response using scoped recovery', async () => {
    const f = fixture();
    f.request.mockImplementation(async (...args) => {
      const result = await f.implementation(...args);
      if (args[1].endsWith('/suspend'))
        throw new Error('raw JWT credentials hidden');
      return result;
    });
    await expect(f.run()).rejects.toMatchObject({ stage: 'suspend' });
    expect(f.detail.company.platformStatus).toBe('active');
  });
  it('never clears a competing security suspension and reports required operator recovery safely', async () => {
    const f = fixture();
    f.request.mockImplementation(async (...args) => {
      const result = await f.implementation(...args);
      if (args[1].endsWith('/suspend')) {
        Object.assign(f.detail.company, {
          platformStatusReason: 'security_review',
        });
        throw new Error('private response');
      }
      return result;
    });
    await expect(f.run()).rejects.toMatchObject({
      category: CliFailureCategory.SMOKE_RECOVERY,
    });
    expect(
      f.request.mock.calls.some(([, path]) => path.endsWith('/reactivate')),
    ).toBe(false);
  });
  it('reports failed automatic reactivation without emitting full errors, bodies or tokens', async () => {
    const f = fixture();
    f.request.mockImplementation(async (...args): Promise<SmokeResponse> => {
      if (args[1].endsWith('/reactivate'))
        throw new Error('mongodb://user:password private-token');
      const result = await f.implementation(...args);
      if (args[1].endsWith('/suspend')) f.detail.currentlyStoredFiles.total = 1;
      return result;
    });
    let failure: unknown;
    try {
      await f.run();
    } catch (error) {
      failure = error;
    }
    expect(safeCliCategory(failure)).toBe(CliFailureCategory.SMOKE_RECOVERY);
    expect(String(failure)).not.toMatch(
      /mongodb|password|private-token|fixture.test/,
    );
  });
  it.each([
    'https://production.example.com',
    'ftp://localhost',
    'http://user:secret@localhost:3000',
    'http://localhost:3000/?token=secret',
    'http://localhost:3000/admin',
    'http://localhost:3000/#token',
    'invalid',
  ])('rejects unsafe smoke API origins (%s)', (value) => {
    expect(() => smokeBaseUrl(value)).toThrow(
      CliFailureCategory.INVALID_SMOKE_CONFIGURATION,
    );
  });
  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://[::1]:3000',
  ])('allows loopback-only API origins (%s)', (value) => {
    expect(smokeBaseUrl(value)).toBe(value);
  });
  it('safe diagnostic categories never stringify untrusted error data', () => {
    const error = {
      message: 'secret password',
      code: 'private-token',
      toString: () => {
        throw new Error('must not inspect');
      },
    };
    expect(safeCliCategory(error)).toBe(CliFailureCategory.UNKNOWN);
    expect(
      safeCliCategory(new CliFailure(CliFailureCategory.MONGO_INDEX)),
    ).toBe(CliFailureCategory.MONGO_INDEX);
  });
});
