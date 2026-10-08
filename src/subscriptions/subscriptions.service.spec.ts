import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Role } from '../enums/roles.enum';
import { PLAN_CATALOG, PlanCode } from '../plans/plan.constants';
import { BillingService } from './billing.service';
import { SubscriptionsService } from './subscriptions.service';

describe('SubscriptionsService', () => {
  const companyId = new Types.ObjectId();
  const activatedAt = new Date('2026-01-15T12:00:00.000Z');
  const subscription = {
    _id: new Types.ObjectId(),
    companyId,
    planCode: PlanCode.BASIC,
    activatedAt,
    planChangedAt: activatedAt,
  };
  const subscriptionModel = {
    create: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  };
  const periodModel = { findOne: jest.fn() };
  const userModel = { countDocuments: jest.fn() };
  const fileModel = { countDocuments: jest.fn() };
  const invitationModel = { countDocuments: jest.fn() };
  const plansService = {
    findOne: jest.fn((code: PlanCode) => PLAN_CATALOG[code]),
  };
  const billingService = new BillingService(plansService as never);
  const session = {};
  const connection = {
    transaction: jest.fn((work: (value: object) => unknown) => work(session)),
  };
  const service = new SubscriptionsService(
    subscriptionModel as never,
    periodModel as never,
    userModel as never,
    invitationModel as never,
    plansService as never,
    billingService,
    connection as never,
    fileModel as never,
  );
  const owner: AuthenticatedUser = {
    id: new Types.ObjectId().toString(),
    companyId: companyId.toString(),
    role: Role.COMPANY_OWNER,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    fileModel.countDocuments.mockResolvedValue(8);
    subscriptionModel.findOne.mockResolvedValue(subscription);
    subscriptionModel.findOneAndUpdate.mockResolvedValue(subscription);
    periodModel.findOne.mockResolvedValue(null);
    userModel.countDocuments.mockResolvedValue(2);
    invitationModel.countDocuments.mockResolvedValue(0);
  });

  it('initializes every newly registered company on Free', async () => {
    subscriptionModel.create.mockResolvedValue([subscription]);
    await service.initializeFree(companyId, session as never, activatedAt);
    expect(subscriptionModel.create).toHaveBeenCalledWith(
      [
        {
          companyId,
          planCode: PlanCode.FREE,
          activatedAt,
          planChangedAt: activatedAt,
        },
      ],
      { session },
    );
  });

  it('routes legacy plan changes through Stripe in enabled mode instead of granting paid access', async () => {
    const payments = {
      enabled: true,
      changePlan: jest
        .fn()
        .mockResolvedValue({ pendingPlanCode: PlanCode.PREMIUM }),
    };
    const managed = new SubscriptionsService(
      subscriptionModel as never,
      periodModel as never,
      userModel as never,
      invitationModel as never,
      plansService as never,
      billingService,
      connection as never,
      fileModel as never,
      payments as never,
    );
    await managed.changePlan(owner, PlanCode.PREMIUM);
    expect(payments.changePlan).toHaveBeenCalledWith(owner, PlanCode.PREMIUM);
    expect(subscriptionModel.findOneAndUpdate).not.toHaveBeenCalled();
    await expect(
      managed.changePlan(
        { ...owner, role: Role.COMPANY_MEMBER },
        PlanCode.PREMIUM,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns only the requested company state and its monthly estimate', async () => {
    await expect(
      service.getCurrent(
        companyId.toString(),
        new Date('2026-02-16T00:00:00.000Z'),
      ),
    ).resolves.toMatchObject({
      companyId,
      plan: { code: PlanCode.BASIC },
      employeeCount: 2,
      storedFiles: 8,
      monthlyPriceEstimateCents: 1000,
      billingSummary: {
        calculationBasis: 'current_plan_estimate_with_recorded_overage',
        employeeChargeCents: 1000,
        totalAmountCents: 1000,
      },
      billingPeriod: {
        startsAt: new Date('2026-02-15T12:00:00.000Z'),
        uploadedFiles: 0,
        fileOverageCents: 0,
      },
    });
    expect(subscriptionModel.findOne).toHaveBeenCalledWith(
      { companyId: companyId.toString() },
      null,
      { session },
    );
    expect(periodModel.findOne).toHaveBeenCalledWith(
      {
        companyId: companyId.toString(),
        startsAt: new Date('2026-02-15T12:00:00.000Z'),
      },
      null,
      { session },
    );
    expect(connection.transaction).toHaveBeenCalledWith(expect.any(Function), {
      readConcern: { level: 'snapshot' },
    });
  });

  it.each([PlanCode.FREE, PlanCode.BASIC])(
    'requires manual file cleanup before changing to %s',
    async (code) => {
      userModel.countDocuments.mockResolvedValue(0);
      const limit = PLAN_CATALOG[code].includedFilesPerMonth;
      fileModel.countDocuments.mockResolvedValue(limit + 1);
      await expect(service.changePlan(owner, code)).rejects.toThrow(
        'Stored files',
      );
      fileModel.countDocuments.mockResolvedValue(limit);
      await expect(service.changePlan(owner, code)).resolves.toBeDefined();
    },
  );

  it('fails closed when a company has no subscription', async () => {
    subscriptionModel.findOne.mockResolvedValue(null);
    await expect(
      service.getCurrent(companyId.toString()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows only owners to change a plan at the service boundary', async () => {
    await expect(
      service.changePlan(
        { ...owner, role: Role.COMPANY_MEMBER },
        PlanCode.PREMIUM,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(connection.transaction).not.toHaveBeenCalled();
  });

  it('rejects a downgrade that cannot hold the existing employees', async () => {
    userModel.countDocuments.mockResolvedValue(11);
    await expect(service.changePlan(owner, PlanCode.BASIC)).rejects.toThrow(
      'at most 10 employees',
    );
    expect(subscriptionModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('rejects a downgrade when pending invitations exceed its capacity', async () => {
    userModel.countDocuments.mockResolvedValue(9);
    invitationModel.countDocuments.mockResolvedValue(2);
    await expect(service.changePlan(owner, PlanCode.BASIC)).rejects.toThrow(
      'employees and pending invitations',
    );
  });

  it('changes plans without resetting activation or usage anchors', async () => {
    subscriptionModel.findOneAndUpdate
      .mockResolvedValueOnce(subscription)
      .mockResolvedValueOnce({ ...subscription, planCode: PlanCode.PREMIUM });
    subscriptionModel.findOne.mockResolvedValue({
      ...subscription,
      planCode: PlanCode.PREMIUM,
    });
    await service.changePlan(owner, PlanCode.PREMIUM);
    const updateCall = subscriptionModel.findOneAndUpdate.mock
      .calls[1] as unknown as [
      Record<string, unknown>,
      { $set: { planCode: PlanCode; planChangedAt: Date } },
      Record<string, unknown>,
    ];
    expect(updateCall[0]).toEqual({
      _id: subscription._id,
      companyId: owner.companyId,
    });
    expect(updateCall[1].$set.planCode).toBe(PlanCode.PREMIUM);
    expect(updateCall[1].$set.planChangedAt).toBeInstanceOf(Date);
    expect(updateCall[2]).toEqual({
      new: true,
      runValidators: true,
      session,
    });
  });

  it('retains recorded Premium overage in a post-downgrade estimate', async () => {
    subscriptionModel.findOne.mockResolvedValue({
      ...subscription,
      planCode: PlanCode.BASIC,
      planChangedAt: new Date('2026-02-16T00:00:00.000Z'),
    });
    periodModel.findOne.mockResolvedValue({
      uploadedFiles: 1001,
      fileOverageCents: 50,
    });

    await expect(
      service.getCurrentBilling(companyId.toString()),
    ).resolves.toMatchObject({
      plan: { code: PlanCode.BASIC },
      successfulUploads: 1001,
      billableOverageUploads: 1,
      overageChargeCents: 50,
      totalAmountCents: 1050,
    });
  });
});
