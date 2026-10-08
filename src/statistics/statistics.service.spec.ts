import { Types } from 'mongoose';
import {
  PLAN_CATALOG,
  BillingCurrency,
  PlanCode,
} from '../plans/plan.constants';
import { BillingCalculationBasis } from '../subscriptions/billing.service';
import { StatisticsService } from './statistics.service';

describe('StatisticsService', () => {
  const companyId = new Types.ObjectId().toString();
  const now = new Date('2026-09-17T12:00:00.000Z');
  const startsAt = new Date('2026-09-10T08:00:00.000Z');
  const endsAt = new Date('2026-10-10T08:00:00.000Z');
  const subscriptionsService = { getCurrent: jest.fn() };
  const invitationModel = { countDocuments: jest.fn() };
  const fileModel = { countDocuments: jest.fn() };
  const service = new StatisticsService(
    subscriptionsService as never,
    invitationModel as never,
    fileModel as never,
  );

  function subscriptionSnapshot(
    planCode: PlanCode,
    employeeCount: number,
    successfulUploads: number,
    premiumOverageUploads: number,
    totalAmountCents: number,
  ) {
    const plan = PLAN_CATALOG[planCode];
    return {
      companyId,
      plan,
      activatedAt: new Date('2026-01-10T08:00:00.000Z'),
      planChangedAt: new Date('2026-01-10T08:00:00.000Z'),
      employeeCount,
      billingSummary: {
        calculationBasis:
          BillingCalculationBasis.CURRENT_PLAN_ESTIMATE_WITH_RECORDED_OVERAGE,
        currency: BillingCurrency.USD,
        billingPeriod: { startsAt, endsAt },
        successfulUploads,
        includedUploadAllowance: plan.includedFilesPerMonth,
        billableOverageUploads: premiumOverageUploads,
        baseAmountCents: plan.basePriceCents,
        employeeChargeCents:
          plan.employeePriceCents > 0
            ? employeeCount * plan.employeePriceCents
            : 0,
        overageChargeCents: premiumOverageUploads * 50,
        totalAmountCents,
      },
    };
  }

  function counts({
    pending,
    total,
    companyWide,
    restricted,
  }: {
    pending: number;
    total: number;
    companyWide: number;
    restricted: number;
  }) {
    invitationModel.countDocuments.mockResolvedValue(pending);
    fileModel.countDocuments.mockImplementation(
      (filter: { visibility?: string; $or?: unknown[] }) => {
        if (filter.visibility === 'restricted')
          return Promise.resolve(restricted);
        if (filter.$or) return Promise.resolve(companyWide);
        return Promise.resolve(total);
      },
    );
  }

  beforeEach(() => jest.resetAllMocks());

  it('returns an empty new Free company with capped employee and upload capacity', async () => {
    subscriptionsService.getCurrent.mockResolvedValue(
      subscriptionSnapshot(PlanCode.FREE, 0, 0, 0, 0),
    );
    counts({ pending: 0, total: 0, companyWide: 0, restricted: 0 });

    await expect(service.getCurrent(companyId, now)).resolves.toMatchObject({
      companyId,
      subscription: { planCode: PlanCode.FREE, planName: 'Free' },
      employees: {
        accepted: 0,
        pendingInvitations: 0,
        limit: 0,
        unlimited: false,
        remainingSlots: 0,
      },
      files: {
        currentlyStored: { total: 0, companyWide: 0, restricted: 0 },
        currentBillingPeriod: {
          successfulUploads: 0,
          includedAllowance: 10,
          unlimited: false,
          remainingIncludedUploads: 10,
          remainingUploads: 10,
          premiumOverageUploads: 0,
        },
      },
      billing: { currency: BillingCurrency.USD, totalAmountCents: 0 },
    });
    expect(subscriptionsService.getCurrent).toHaveBeenCalledWith(
      companyId,
      now,
    );
  });

  it('reports Basic accepted employees, pending seat reservations, stored files and remaining uploads', async () => {
    subscriptionsService.getCurrent.mockResolvedValue(
      subscriptionSnapshot(PlanCode.BASIC, 4, 98, 0, 2000),
    );
    counts({ pending: 2, total: 5, companyWide: 3, restricted: 2 });

    const result = await service.getCurrent(companyId, now);

    expect(result).toMatchObject({
      subscription: { planCode: PlanCode.BASIC },
      employees: {
        accepted: 4,
        pendingInvitations: 2,
        limit: 10,
        unlimited: false,
        remainingSlots: 4,
      },
      files: {
        currentlyStored: { total: 5, companyWide: 3, restricted: 2 },
        currentBillingPeriod: {
          successfulUploads: 98,
          includedAllowance: 100,
          unlimited: false,
          remainingUploads: 95,
        },
      },
      billing: { employeeChargeCents: 2000, totalAmountCents: 2000 },
    });
    expect(invitationModel.countDocuments).toHaveBeenCalledWith({
      companyId,
      status: 'pending',
      expiresAt: { $gt: now },
    });
    expect(fileModel.countDocuments).toHaveBeenCalledWith({ companyId });
  });

  it('reports available Free slots from stored files even after ten historical uploads', async () => {
    subscriptionsService.getCurrent.mockResolvedValue(
      subscriptionSnapshot(PlanCode.FREE, 0, 10, 0, 0),
    );
    counts({ pending: 0, total: 9, companyWide: 9, restricted: 0 });
    await expect(service.getCurrent(companyId, now)).resolves.toMatchObject({
      files: {
        currentlyStored: { total: 9 },
        currentBillingPeriod: { successfulUploads: 10, remainingUploads: 1 },
      },
    });
  });

  it('shows Premium unlimited semantics, overage and historical uploads independently of stored files', async () => {
    subscriptionsService.getCurrent.mockResolvedValue(
      subscriptionSnapshot(PlanCode.PREMIUM, 12, 1004, 4, 30200),
    );
    counts({ pending: 7, total: 2, companyWide: 1, restricted: 1 });

    await expect(service.getCurrent(companyId, now)).resolves.toMatchObject({
      subscription: { planCode: PlanCode.PREMIUM },
      employees: {
        accepted: 12,
        pendingInvitations: 7,
        limit: null,
        unlimited: true,
        remainingSlots: null,
      },
      files: {
        currentlyStored: { total: 2, companyWide: 1, restricted: 1 },
        currentBillingPeriod: {
          successfulUploads: 1004,
          includedAllowance: 1000,
          unlimited: true,
          remainingIncludedUploads: 998,
          remainingUploads: null,
          premiumOverageUploads: 4,
        },
      },
      billing: {
        baseAmountCents: 30000,
        overageChargeCents: 200,
        totalAmountCents: 30200,
      },
    });
  });
});
