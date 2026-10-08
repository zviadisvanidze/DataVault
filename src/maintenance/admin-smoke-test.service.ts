import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { isEmail } from 'class-validator';
import { CliFailure, CliFailureCategory } from './cli-errors';
import { PlanCode } from '../plans/plan.constants';
import { Role } from '../enums/roles.enum';
import {
  CompanyPlatformReason,
  CompanyPlatformStatus,
} from '../companies/platform-status';
import { AdminAuditAction } from '../admin/entities/admin-audit.entity';
import { validNewPassword } from '../common/password-policy';

export interface SmokeResponse {
  status: number;
  body: unknown;
}
export interface SmokeTransport {
  request(
    method: 'GET' | 'POST',
    path: string,
    token?: string,
    body?: unknown,
  ): Promise<SmokeResponse>;
}
export interface SmokeOperator {
  email: string;
  password: string;
  fullName: string;
  country: string;
  industry: string;
  adminToken: string;
}
export type SmokeTenantCredentials = Pick<
  SmokeOperator,
  'email' | 'password' | 'adminToken'
>;
export type SmokeAdminAuthentication =
  | { kind: 'supplied_token'; token: string }
  | { kind: 'credentials'; email: string; password: string };
export type SmokeStage =
  | 'admin_authentication'
  | 'supplied_admin_jwt_rejected'
  | 'admin_credentials_rejected'
  | 'admin_login_request_rejected'
  | 'admin_issued_jwt_rejected'
  | 'admin_endpoint_unreachable'
  | 'admin_endpoint_misconfigured'
  | 'admin_endpoint_unavailable'
  | 'activation'
  | 'activation_already_complete'
  | 'resume_fixture_lookup'
  | 'resume_fixture_safety'
  | 'registration'
  | 'tenant_login'
  | 'tenant_endpoint'
  | 'tenant_admin_denied'
  | 'fixture_safety'
  | 'suspend'
  | 'issued_jwt_rejected'
  | 'fresh_login_rejected'
  | 'state_preserved'
  | 'platform_admin_remains_functional'
  | 'reactivate'
  | 'original_jwt_restored'
  | 'audit_events'
  | 'recovery';
export class SmokeFailure extends CliFailure {
  constructor(
    public readonly stage: SmokeStage,
    public readonly status?: number,
    recovery = false,
  ) {
    super(
      recovery
        ? CliFailureCategory.SMOKE_RECOVERY
        : CliFailureCategory.SMOKE_ASSERTION,
    );
  }
}

export type SmokeCommand =
  | { mode: 'register'; origin: string }
  | { mode: 'resume'; origin: string; fixtureName: string };

export function smokeCommand(args: string[]): SmokeCommand {
  if (
    args.length === 3 &&
    args[0] === '--base-url' &&
    args[2] === '--confirm-test-tenant'
  )
    return { mode: 'register', origin: smokeBaseUrl(args[1]) };
  if (
    args.length === 5 &&
    args[0] === '--base-url' &&
    args[2] === '--resume-fixture' &&
    /^DataVault admin smoke [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      args[3],
    ) &&
    args[4] === '--confirm-test-tenant'
  )
    return {
      mode: 'resume',
      origin: smokeBaseUrl(args[1]),
      fixtureName: args[3],
    };
  throw new CliFailure(CliFailureCategory.INVALID_SMOKE_CONFIGURATION);
}

export function smokeActivationToken(value: string) {
  const candidate = value.trim();
  const validToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);
  if (validToken(candidate)) return candidate;
  if (!candidate || candidate.length > 2048)
    throw new CliFailure(CliFailureCategory.INVALID_SMOKE_CONFIGURATION);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new CliFailure(CliFailureCategory.INVALID_SMOKE_CONFIGURATION);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const entries = [...url.searchParams.entries()];
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (url.protocol !== 'https:' && !local) ||
    url.username ||
    url.password ||
    url.hash ||
    entries.length !== 1 ||
    entries[0][0] !== 'token' ||
    !validToken(entries[0][1])
  )
    throw new CliFailure(CliFailureCategory.INVALID_SMOKE_CONFIGURATION);
  return entries[0][1];
}

export async function activateSmokeCompany(
  api: SmokeTransport,
  activationUrlOrToken: string,
) {
  const token = smokeActivationToken(activationUrlOrToken);
  let response: SmokeResponse;
  try {
    response = await api.request('POST', '/auth/verify-account', undefined, {
      token,
    });
  } catch {
    throw new SmokeFailure('activation');
  }
  if (response.status !== 200)
    throw new SmokeFailure('activation', response.status);
}

function authenticationFailure(
  status: number,
  rejected: SmokeStage,
): SmokeFailure {
  if (status === 401 || status === 403)
    return new SmokeFailure(rejected, status);
  if (status === 404 || status === 405)
    return new SmokeFailure('admin_endpoint_misconfigured', status);
  if (status >= 500)
    return new SmokeFailure('admin_endpoint_unavailable', status);
  return new SmokeFailure('admin_login_request_rejected', status);
}

/** Authenticates and verifies the token without exposing response bodies. */
export async function authenticateSmokeAdmin(
  api: SmokeTransport,
  authentication: SmokeAdminAuthentication,
): Promise<string> {
  let token: string;
  if (authentication.kind === 'supplied_token') {
    token = authentication.token.trim();
    if (!token)
      throw new CliFailure(CliFailureCategory.INVALID_SMOKE_CONFIGURATION);
  } else {
    let response: SmokeResponse;
    try {
      response = await api.request('POST', '/admin/auth/login', undefined, {
        email: authentication.email,
        password: authentication.password,
      });
    } catch {
      throw new SmokeFailure('admin_endpoint_unreachable');
    }
    if (response.status !== 200)
      throw authenticationFailure(
        response.status,
        'admin_credentials_rejected',
      );
    const body = response.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).accessToken !== 'string' ||
      !(body as Record<string, unknown>).accessToken
    )
      throw new SmokeFailure('admin_endpoint_misconfigured', response.status);
    token = (body as Record<string, unknown>).accessToken as string;
  }

  let verification: SmokeResponse;
  try {
    verification = await api.request('GET', '/admin/dashboard', token);
  } catch {
    throw new SmokeFailure('admin_endpoint_unreachable');
  }
  if (verification.status !== 200) {
    if (verification.status === 401 || verification.status === 403)
      throw new SmokeFailure(
        authentication.kind === 'supplied_token'
          ? 'supplied_admin_jwt_rejected'
          : 'admin_issued_jwt_rejected',
        verification.status,
      );
    if (verification.status >= 500)
      throw new SmokeFailure('admin_endpoint_unavailable', verification.status);
    throw new SmokeFailure('admin_endpoint_misconfigured', verification.status);
  }
  return token;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SmokeFailure('fixture_safety');
  return value as Record<string, unknown>;
}
function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function state(detail: Record<string, unknown>) {
  const company = record(detail.company);
  // Only the four platform fields and company updatedAt are expected to change.
  return {
    company: {
      id: company.id,
      name: company.name,
      country: company.country,
      industry: company.industry,
      activatedAt: company.activatedAt,
      createdAt: company.createdAt,
    },
    owner: detail.owner,
    employees: detail.employees,
    files: detail.currentlyStoredFiles,
    subscription: detail.subscription,
    billingEstimate: detail.billingEstimate,
    stripe: detail.stripe,
    integrityWarnings: detail.integrityWarnings,
  };
}

function pristineFixture(
  detail: Record<string, unknown>,
  fixtureName: string,
  companyId: string,
  ownerEmail: string,
  activated: boolean,
) {
  const company = optionalRecord(detail.company);
  const owner = optionalRecord(detail.owner);
  const subscription = optionalRecord(detail.subscription);
  const employees = optionalRecord(detail.employees);
  const files = optionalRecord(detail.currentlyStoredFiles);
  const billing = optionalRecord(detail.billingEstimate);
  if (!company || !owner || !subscription || !employees || !files || !billing)
    return false;
  return (
    company.id === companyId &&
    company.name === fixtureName &&
    Boolean(company.activatedAt) === activated &&
    company.platformStatus === CompanyPlatformStatus.ACTIVE &&
    company.platformStatusReason == null &&
    company.platformStatusChangedAt == null &&
    owner.email === ownerEmail &&
    subscription.planCode === PlanCode.FREE &&
    subscription.pendingPlanCode == null &&
    subscription.pendingPlanAt == null &&
    subscription.planChangedAt === subscription.activatedAt &&
    employees.accepted === 0 &&
    employees.pendingInvitations === 0 &&
    files.total === 0 &&
    billing.successfulUploads === 0 &&
    billing.overageChargeCents === 0 &&
    billing.totalAmountCents === 0 &&
    detail.stripe === null &&
    Array.isArray(detail.integrityWarnings) &&
    detail.integrityWarnings.length === 0
  );
}

/** Calls only normal HTTP APIs, never direct database/providers or activation overrides. */
export async function platformAdminSmokeTest(
  api: SmokeTransport,
  operator: SmokeOperator,
  activateNormally: () => Promise<void>,
  progress: (stage: SmokeStage) => void = () => undefined,
  fixtureName = `DataVault admin smoke ${randomUUID()}`,
  onRegistrationAttempt: () => void = () => undefined,
) {
  return runPlatformAdminSmokeTest(
    api,
    operator,
    activateNormally,
    progress,
    fixtureName,
    { mode: 'register', operator, onRegistrationAttempt },
  );
}

export async function resumePlatformAdminSmokeTest(
  api: SmokeTransport,
  operator: SmokeTenantCredentials,
  activateNormally: () => Promise<void>,
  fixtureName: string,
  progress: (stage: SmokeStage) => void = () => undefined,
) {
  return runPlatformAdminSmokeTest(
    api,
    operator,
    activateNormally,
    progress,
    fixtureName,
    { mode: 'resume' },
  );
}

async function runPlatformAdminSmokeTest(
  api: SmokeTransport,
  operator: SmokeTenantCredentials,
  activateNormally: () => Promise<void>,
  progress: (stage: SmokeStage) => void,
  fixtureName: string,
  start:
    | {
        mode: 'register';
        operator: SmokeOperator;
        onRegistrationAttempt: () => void;
      }
    | { mode: 'resume' },
) {
  if (
    !isEmail(operator.email) ||
    (start.mode === 'register'
      ? !validNewPassword(operator.password)
      : operator.password.length < 1 || operator.password.length > 72) ||
    !operator.adminToken ||
    !fixtureName.startsWith('DataVault admin smoke ')
  )
    throw new CliFailure(CliFailureCategory.INVALID_SMOKE_CONFIGURATION);
  let companyId: string | undefined;
  let suspensionAttempted = false;
  let restored = false;
  let failure: CliFailure | undefined;
  let success:
    | {
        companyId: string;
        fixtureName: string;
        passed: boolean;
        activatedFixtureRetained: boolean;
      }
    | undefined;
  const call = async (
    stage: SmokeStage,
    method: 'GET' | 'POST',
    path: string,
    status: number,
    token?: string,
    body?: unknown,
  ) => {
    let result: SmokeResponse;
    try {
      result = await api.request(method, path, token, body);
    } catch {
      throw new SmokeFailure(stage);
    }
    if (result.status !== status) throw new SmokeFailure(stage, result.status);
    progress(stage);
    return result.body;
  };
  try {
    await call(
      'admin_authentication',
      'GET',
      '/admin/dashboard',
      200,
      operator.adminToken,
    );
    if (start.mode === 'register') {
      start.onRegistrationAttempt();
      await call('registration', 'POST', '/auth/sign-up', 202, undefined, {
        email: operator.email,
        password: operator.password,
        fullName: start.operator.fullName,
        companyName: fixtureName,
        country: start.operator.country,
        industry: start.operator.industry,
      });
      await activateNormally();
      progress('activation');
    } else {
      const listing = optionalRecord(
        await call(
          'resume_fixture_lookup',
          'GET',
          `/admin/companies?search=${encodeURIComponent(fixtureName)}&limit=100&sortBy=createdAt&order=desc`,
          200,
          operator.adminToken,
        ),
      );
      if (!listing || !Array.isArray(listing.items))
        throw new SmokeFailure('resume_fixture_lookup');
      const exact = listing.items.filter((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
          return false;
        return (item as Record<string, unknown>).name === fixtureName;
      });
      const id =
        exact.length === 1
          ? (exact[0] as Record<string, unknown>).id
          : undefined;
      if (typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id))
        throw new SmokeFailure('resume_fixture_lookup');
      companyId = id;
      const preliminary = optionalRecord(
        await call(
          'resume_fixture_safety',
          'GET',
          `/admin/companies/${companyId}`,
          200,
          operator.adminToken,
        ),
      );
      const preliminaryCompany = optionalRecord(preliminary?.company);
      if (!preliminary || !preliminaryCompany)
        throw new SmokeFailure('resume_fixture_safety');
      const activated = Boolean(preliminaryCompany.activatedAt);
      if (
        !pristineFixture(
          preliminary,
          fixtureName,
          companyId,
          operator.email,
          activated,
        )
      )
        throw new SmokeFailure('resume_fixture_safety');
      if (activated) progress('activation_already_complete');
      else {
        await activateNormally();
        progress('activation');
      }
    }
    const login = record(
      await call('tenant_login', 'POST', '/auth/sign-in', 201, undefined, {
        email: operator.email,
        password: operator.password,
      }),
    );
    if (typeof login.accessToken !== 'string')
      throw new SmokeFailure('tenant_login');
    const tenantToken = login.accessToken;
    const user = record(
      await call(
        'tenant_endpoint',
        'GET',
        '/auth/current-user',
        200,
        tenantToken,
      ),
    );
    if (
      typeof user.companyId !== 'string' ||
      !/^[a-f0-9]{24}$/i.test(user.companyId) ||
      user.role !== Role.COMPANY_OWNER ||
      user.email !== operator.email
    )
      throw new SmokeFailure('fixture_safety');
    if (companyId && user.companyId !== companyId)
      throw new SmokeFailure('fixture_safety');
    companyId = user.companyId;
    await call(
      'tenant_admin_denied',
      'GET',
      '/admin/dashboard',
      401,
      tenantToken,
    );
    const detail = record(
      await call(
        'fixture_safety',
        'GET',
        `/admin/companies/${companyId}`,
        200,
        operator.adminToken,
      ),
    );
    if (!pristineFixture(detail, fixtureName, companyId, operator.email, true))
      throw new SmokeFailure('fixture_safety');
    const baseline = state(detail);
    suspensionAttempted = true; // Covers a committed mutation with a lost response.
    await call(
      'suspend',
      'POST',
      `/admin/companies/${companyId}/suspend`,
      200,
      operator.adminToken,
      { reason: CompanyPlatformReason.OPERATIONAL_HOLD },
    );
    await call(
      'issued_jwt_rejected',
      'GET',
      '/auth/current-user',
      401,
      tenantToken,
    );
    await call(
      'fresh_login_rejected',
      'POST',
      '/auth/sign-in',
      401,
      undefined,
      { email: operator.email, password: operator.password },
    );
    const suspended = record(
      await call(
        'state_preserved',
        'GET',
        `/admin/companies/${companyId}`,
        200,
        operator.adminToken,
      ),
    );
    if (
      record(suspended.company).platformStatus !==
        CompanyPlatformStatus.SUSPENDED ||
      !isDeepStrictEqual(state(suspended), baseline)
    )
      throw new SmokeFailure('state_preserved');
    await call(
      'platform_admin_remains_functional',
      'GET',
      '/admin/dashboard',
      200,
      operator.adminToken,
    );
    await call(
      'reactivate',
      'POST',
      `/admin/companies/${companyId}/reactivate`,
      200,
      operator.adminToken,
      {},
    );
    await call(
      'original_jwt_restored',
      'GET',
      '/auth/current-user',
      200,
      tenantToken,
    );
    const reactivated = record(
      await call(
        'state_preserved',
        'GET',
        `/admin/companies/${companyId}`,
        200,
        operator.adminToken,
      ),
    );
    if (
      record(reactivated.company).platformStatus !==
        CompanyPlatformStatus.ACTIVE ||
      !isDeepStrictEqual(state(reactivated), baseline)
    )
      throw new SmokeFailure('state_preserved');
    const auditPage = optionalRecord(
      await call(
        'audit_events',
        'GET',
        `/admin/audit-logs?targetId=${companyId}&limit=100&order=desc`,
        200,
        operator.adminToken,
      ),
    );
    if (!auditPage || !Array.isArray(auditPage.items))
      throw new SmokeFailure('audit_events');
    const companyEvents = auditPage.items.filter((item) => {
      const event = optionalRecord(item);
      return event?.targetId === companyId && event?.targetType === 'company';
    });
    const expected = (
      action: AdminAuditAction,
      reason: CompanyPlatformReason,
      previousStatus: CompanyPlatformStatus,
      nextStatus: CompanyPlatformStatus,
    ) =>
      companyEvents.filter((item) => {
        const event = record(item);
        return (
          event.action === action &&
          event.reason === reason &&
          event.previousStatus === previousStatus &&
          event.nextStatus === nextStatus
        );
      }).length === 1;
    if (
      !expected(
        AdminAuditAction.COMPANY_SUSPENDED,
        CompanyPlatformReason.OPERATIONAL_HOLD,
        CompanyPlatformStatus.ACTIVE,
        CompanyPlatformStatus.SUSPENDED,
      ) ||
      !expected(
        AdminAuditAction.COMPANY_REACTIVATED,
        CompanyPlatformReason.REVIEW_COMPLETED,
        CompanyPlatformStatus.SUSPENDED,
        CompanyPlatformStatus.ACTIVE,
      )
    )
      throw new SmokeFailure('audit_events');
    restored = true;
    success = {
      companyId,
      fixtureName,
      passed: true,
      activatedFixtureRetained: true,
    };
  } catch (error) {
    failure =
      error instanceof CliFailure
        ? error
        : new CliFailure(CliFailureCategory.UNKNOWN);
  }
  if (suspensionAttempted && !restored && companyId) {
    try {
      const latest = await api.request(
        'GET',
        `/admin/companies/${companyId}`,
        operator.adminToken,
      );
      const company = record(record(latest.body).company);
      if (latest.status !== 200 || company.name !== fixtureName)
        throw new Error();
      if (
        company.platformStatus === CompanyPlatformStatus.SUSPENDED &&
        company.platformStatusReason === CompanyPlatformReason.OPERATIONAL_HOLD
      ) {
        const response = await api.request(
          'POST',
          `/admin/companies/${companyId}/reactivate`,
          operator.adminToken,
          {},
        );
        if (response.status !== 200) throw new Error();
      } else if (company.platformStatus !== CompanyPlatformStatus.ACTIVE)
        throw new Error();
      progress('recovery');
    } catch {
      throw new SmokeFailure('recovery', undefined, true);
    }
  }
  if (failure) throw failure;
  if (!success) throw new SmokeFailure('fixture_safety');
  return success;
}

export function smokeBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliFailure(CliFailureCategory.INVALID_SMOKE_CONFIGURATION);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new CliFailure(CliFailureCategory.INVALID_SMOKE_CONFIGURATION);
  return url.origin;
}
