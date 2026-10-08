import { Types } from 'mongoose';
import { adminFixture } from '../../test/admin.fixture';
import {
  CompanyPlatformReason,
  CompanyPlatformStatus,
} from '../companies/platform-status';
import { PaymentAccess, PaymentSyncIssue } from '../payments/payment.constants';
import {
  AdminAuditQueryDto,
  AdminCompanyQueryDto,
  AdminFileQueryDto,
  AdminUserQueryDto,
} from './dto/admin.dto';

describe('platform operational administration', () => {
  let f: Awaited<ReturnType<typeof adminFixture>>;
  beforeEach(async () => {
    f = await adminFixture();
  });

  it('counts global tenant state without labeling estimates or recorded overage as revenue', async () => {
    f.companies[1].platformStatus = CompanyPlatformStatus.SUSPENDED;
    f.subscriptions[1].paymentAccess = PaymentAccess.SUSPENDED;
    const result = await f.service.dashboard(f.now);
    expect(result.companies).toEqual({
      total: 3,
      activated: 2,
      pendingActivation: 1,
      suspended: 1,
      byPlan: { free: 1, basic: 1, premium: 1 },
      missingSubscriptions: 0,
    });
    expect(result.tenantUsers).toEqual({ total: 4, owners: 3, members: 1 });
    expect(result.currentlyStoredFiles).toEqual({
      total: 3,
      companyWide: 2,
      restricted: 1,
    });
    expect(result.currentCompanyBillingPeriods).toMatchObject({
      successfulUploads: 1011,
      recordedOverageCents: 100,
      trackedCompanyPeriods: 3,
      isCollectedRevenue: false,
    });
    expect(result.pendingInvitations).toBe(1);
    expect(result.stripe).toEqual({
      managedCompanies: 2,
      paymentAttentionCompanies: 1,
    });
  });

  it('handles new/empty state, missing subscriptions, inactive companies and disabled Stripe', async () => {
    f.subscriptions.splice(0);
    f.users.splice(0);
    f.companyfiles.splice(0);
    f.subscriptionperiods.splice(0);
    f.employeeinvitations.splice(0);
    f.config.set('STRIPE_ENABLED', false);
    const result = await f.service.dashboard(f.now);
    expect(result.companies.missingSubscriptions).toBe(3);
    expect(result.companies.byPlan).toEqual({ free: 0, basic: 0, premium: 0 });
    expect(result.currentCompanyBillingPeriods.successfulUploads).toBe(0);
    expect(result.tenantUsers.total).toBe(0);
    expect(result.stripe).toBeNull();
    const detail = await f.service.companyDetail(
      (f.companies[0]._id as Types.ObjectId).toString(),
      f.now,
    );
    expect(detail.subscription).toBeNull();
    expect(detail.integrityWarnings).toEqual([
      'missing_owner',
      'missing_subscription',
    ]);
  });

  it('counts stale/attention payment state using local data only', async () => {
    f.subscriptions[1].stripeSyncedAt = new Date(0);
    f.subscriptions[2].paymentSyncIssue =
      PaymentSyncIssue.RECONCILIATION_REQUIRED;
    expect(
      (await f.service.dashboard(f.now)).stripe?.paymentAttentionCompanies,
    ).toBe(2);
  });

  it('provides sanitized details and reuses the current anchored billing calculation', async () => {
    const result = await f.service.companyDetail(
      (f.companies[1]._id as Types.ObjectId).toString(),
      f.now,
    );
    expect(result.owner?.email).toBe('owner1@fixture.test');
    expect(result.employees).toEqual({ accepted: 1, pendingInvitations: 1 });
    expect(result.currentlyStoredFiles).toEqual({
      total: 2,
      companyWide: 1,
      restricted: 1,
    });
    expect(result.billingEstimate).toMatchObject({
      successfulUploads: 7,
      employeeCount: 1,
      totalAmountCents: 500,
      calculationBasis: 'current_plan_estimate_with_recorded_overage',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /password|tokenHash|storageKey|hidden-|stripeCheckoutOperation|stripeLeaseToken/,
    );
    f.companyfiles.splice(1, 1);
    const afterDeletion = await f.service.companyDetail(
      (f.companies[1]._id as Types.ObjectId).toString(),
      f.now,
    );
    expect(afterDeletion.currentlyStoredFiles.total).toBe(1);
    expect(afterDeletion.billingEstimate?.successfulUploads).toBe(7);
  });

  it('bounds and safely filters/sorts company searches without treating search as a regex', async () => {
    const query = Object.assign(new AdminCompanyQueryDto(), {
      plan: 'basic',
      activation: 'activated',
      stripeManaged: 'true',
      sortBy: 'name',
      order: 'asc',
    });
    const result = await f.service.listCompanies(query);
    expect(result.pagination.total).toBe(1);
    expect(JSON.stringify(result.items)).toContain('Beta');
    expect(JSON.stringify(result.items)).not.toMatch(
      /hidden-|password|storageKey/,
    );
    query.search = '.*';
    expect((await f.service.listCompanies(query)).pagination.total).toBe(0);
    query.sortBy = 'password' as never;
    await expect(f.service.listCompanies(query)).rejects.toThrow(
      'Invalid admin pagination or sorting',
    );
  });

  it('treats legacy missing platform status as active and honors bounded pagination', async () => {
    const query = Object.assign(new AdminCompanyQueryDto(), {
      status: CompanyPlatformStatus.ACTIVE,
      limit: 1,
      page: 2,
      sortBy: 'name',
      order: 'asc',
    });
    const result = await f.service.listCompanies(query);
    expect(result.pagination).toEqual({ total: 3, limit: 1, page: 2 });
    expect(JSON.stringify(result.items)).toContain('Beta');
    query.limit = 101;
    await expect(f.service.listCompanies(query)).rejects.toThrow(
      'Invalid admin pagination',
    );
  });

  it('explicitly projects global user/file metadata and scopes optional company filters', async () => {
    const companyId = (f.companies[1]._id as Types.ObjectId).toString();
    const users = await f.service.listUsers(
      Object.assign(new AdminUserQueryDto(), { companyId }),
    );
    const files = await f.service.listFiles(
      Object.assign(new AdminFileQueryDto(), {
        companyId,
        visibility: 'restricted',
      }),
    );
    expect(users.pagination.total).toBe(2);
    expect(files.pagination.total).toBe(1);
    expect(JSON.stringify([users, files])).not.toMatch(
      /password|hidden-|storageKey|tokenHash/,
    );
    expect(
      (
        await f.service.listUsers(
          Object.assign(new AdminUserQueryDto(), { search: 'employee@' }),
        )
      ).pagination.total,
    ).toBe(1);
  });

  it('atomically suspends/reactivates only the Company and append-only audit data', async () => {
    const id = (f.companies[1]._id as Types.ObjectId).toString();
    const preserved = JSON.stringify([
      f.users,
      f.subscriptions,
      f.companyfiles,
      f.subscriptionperiods,
      f.employeeinvitations,
    ]);
    await f.service.changeCompanyStatus(
      { id: f.adminId.toString() },
      id,
      CompanyPlatformStatus.SUSPENDED,
      CompanyPlatformReason.SECURITY_REVIEW,
    );
    expect(f.companies[1]).toMatchObject({
      platformStatus: 'suspended',
      platformStatusReason: 'security_review',
      platformStatusChangedBy: f.adminId,
    });
    expect(f.adminaudits[0]).toMatchObject({
      action: 'company_suspended',
      actorId: f.adminId.toString(),
      targetType: 'company',
      previousStatus: 'active',
      nextStatus: 'suspended',
    });
    await expect(
      f.service.changeCompanyStatus(
        { id: f.adminId.toString() },
        id,
        CompanyPlatformStatus.SUSPENDED,
        CompanyPlatformReason.POLICY_REVIEW,
      ),
    ).rejects.toThrow('already has');
    await f.service.changeCompanyStatus(
      { id: f.adminId.toString() },
      id,
      CompanyPlatformStatus.ACTIVE,
      CompanyPlatformReason.REVIEW_COMPLETED,
    );
    expect(f.adminaudits).toHaveLength(2);
    expect(
      JSON.stringify([
        f.users,
        f.subscriptions,
        f.companyfiles,
        f.subscriptionperiods,
        f.employeeinvitations,
      ]),
    ).toBe(preserved);
    expect(
      (await f.service.listAudit(new AdminAuditQueryDto())).pagination.total,
    ).toBe(2);
  });

  it('rolls back company status if audit persistence fails', async () => {
    f.models.adminAudit.create.mockRejectedValueOnce(
      new Error('audit unavailable'),
    );
    await expect(
      f.service.changeCompanyStatus(
        { id: f.adminId.toString() },
        (f.companies[1]._id as Types.ObjectId).toString(),
        CompanyPlatformStatus.SUSPENDED,
        CompanyPlatformReason.OPERATIONAL_HOLD,
      ),
    ).rejects.toThrow('audit unavailable');
    expect(f.companies[1].platformStatus).toBe(CompanyPlatformStatus.ACTIVE);
    expect(f.adminaudits).toHaveLength(0);
  });

  it('returns 404 for absent companies and 409 for a concurrent status update', async () => {
    await expect(
      f.service.companyDetail(new Types.ObjectId().toString()),
    ).rejects.toThrow('Company not found');
    f.models.company.findOneAndUpdate.mockReturnValueOnce(null as never);
    await expect(
      f.service.changeCompanyStatus(
        { id: f.adminId.toString() },
        (f.companies[1]._id as Types.ObjectId).toString(),
        CompanyPlatformStatus.SUSPENDED,
        CompanyPlatformReason.OPERATIONAL_HOLD,
      ),
    ).rejects.toThrow('changed concurrently');
    expect(f.adminaudits).toHaveLength(0);
  });
});
