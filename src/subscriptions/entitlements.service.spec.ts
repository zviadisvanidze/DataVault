import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PLAN_CATALOG, PlanCode } from '../plans/plan.constants';
import { EntitlementsService } from './entitlements.service';
import { EntitlementDenialReason } from './subscription.constants';
import { BillingService } from './billing.service';
import { PaymentAccess } from '../payments/payment.constants';

describe('EntitlementsService', () => {
  const companyId = 'company-id';
  const activatedAt = new Date('2026-01-20T10:00:00.000Z');
  const session = {};
  const subscriptionsService = {
    getSubscription: jest.fn(),
    acquireLock: jest.fn(),
    paymentsEnabled: false,
    enqueueOverage: jest.fn(),
  };
  const plansService = {
    findOne: jest.fn((code: PlanCode) => PLAN_CATALOG[code]),
  };
  const billingService = new BillingService(plansService as never);
  const userModel = { countDocuments: jest.fn() };
  const invitationModel = { countDocuments: jest.fn() };
  const periodModel = {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  };
  const fileModel = { countDocuments: jest.fn() };
  const connection = {
    transaction: jest.fn((work: (value: object) => unknown) => work(session)),
  };
  const service = new EntitlementsService(
    subscriptionsService as never,
    plansService as never,
    billingService,
    userModel as never,
    invitationModel as never,
    periodModel as never,
    connection as never,
    fileModel as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    fileModel.countDocuments.mockResolvedValue(0);
    subscriptionsService.paymentsEnabled = false;
    subscriptionsService.getSubscription.mockResolvedValue({
      planCode: PlanCode.FREE,
      activatedAt,
    });
    subscriptionsService.acquireLock.mockResolvedValue({
      planCode: PlanCode.FREE,
      activatedAt,
    });
    userModel.countDocuments.mockResolvedValue(0);
    invitationModel.countDocuments.mockResolvedValue(0);
    periodModel.findOne.mockResolvedValue(null);
    periodModel.findOneAndUpdate.mockResolvedValue({ uploadedFiles: 1 });
  });

  it('reserves Free for the owner and permits no employees', async () => {
    try {
      await service.assertEmployeeCapacity(companyId, session as never);
      throw new Error('Expected employee limit rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        reason: EntitlementDenialReason.EMPLOYEE_LIMIT_REACHED,
        limit: 0,
      });
    }
  });

  it('permits ten Basic employees and rejects the eleventh', async () => {
    subscriptionsService.acquireLock.mockResolvedValue({
      planCode: PlanCode.BASIC,
      activatedAt,
    });
    userModel.countDocuments.mockResolvedValueOnce(9);
    await expect(
      service.assertEmployeeCapacity(companyId, session as never),
    ).resolves.toBeUndefined();
    userModel.countDocuments.mockResolvedValueOnce(10);
    await expect(
      service.assertEmployeeCapacity(companyId, session as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not impose an employee limit on Premium', async () => {
    subscriptionsService.acquireLock.mockResolvedValue({
      planCode: PlanCode.PREMIUM,
      activatedAt,
    });
    userModel.countDocuments.mockResolvedValue(10000);
    await expect(
      service.assertEmployeeCapacity(companyId, session as never),
    ).resolves.toBeUndefined();
  });

  it('reserves Basic seats for unexpired pending invitations', async () => {
    subscriptionsService.acquireLock.mockResolvedValue({
      planCode: PlanCode.BASIC,
      activatedAt,
    });
    userModel.countDocuments.mockResolvedValue(8);
    invitationModel.countDocuments.mockResolvedValue(2);
    await expect(
      service.assertEmployeeCapacity(companyId, session as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.assertEmployeeCapacity(companyId, session as never, 0),
    ).resolves.toBeUndefined();
  });

  it('allows the tenth Free file but rejects the eleventh', async () => {
    fileModel.countDocuments.mockResolvedValue(9);
    await expect(
      service.checkFileUpload(
        companyId,
        1,
        new Date('2026-01-21T00:00:00.000Z'),
      ),
    ).resolves.toMatchObject({ allowed: true, remainingIncludedFiles: 1 });
    fileModel.countDocuments.mockResolvedValue(10);
    await expect(
      service.checkFileUpload(
        companyId,
        1,
        new Date('2026-01-21T00:00:00.000Z'),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: EntitlementDenialReason.FILE_LIMIT_REACHED,
    });
  });

  it('enforces the Basic 100-file hard limit', async () => {
    subscriptionsService.getSubscription.mockResolvedValue({
      planCode: PlanCode.BASIC,
      activatedAt,
    });
    fileModel.countDocuments.mockResolvedValueOnce(99);
    await expect(
      service.checkFileUpload(
        companyId,
        1,
        new Date('2026-01-21T00:00:00.000Z'),
      ),
    ).resolves.toMatchObject({ allowed: true });
    fileModel.countDocuments.mockResolvedValueOnce(100);
    await expect(
      service.checkFileUpload(
        companyId,
        1,
        new Date('2026-01-21T00:00:00.000Z'),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      includedFilesPerMonth: 100,
    });
  });

  it.each([PlanCode.FREE, PlanCode.BASIC, PlanCode.PREMIUM])(
    'allows a %s replacement despite historical uploads and rechecks stored capacity in the transaction',
    async (code) => {
      const plan = PLAN_CATALOG[code];
      subscriptionsService.getSubscription.mockResolvedValue({
        planCode: code,
        activatedAt,
      });
      subscriptionsService.acquireLock.mockResolvedValue({
        planCode: code,
        activatedAt,
      });
      periodModel.findOne.mockResolvedValue({ uploadedFiles: 25 });
      fileModel.countDocuments.mockResolvedValue(
        plan.includedFilesPerMonth - 1,
      );
      await expect(service.checkFileUpload(companyId)).resolves.toMatchObject({
        allowed: true,
        uploadedFiles: 25,
        additionalChargeCents: 0,
        remainingIncludedFiles: 1,
        quotaBasis: 'stored_files',
      });
      expect(fileModel.countDocuments).toHaveBeenCalledWith({ companyId });
      await service.recordFileUploads(companyId);
      expect(fileModel.countDocuments).toHaveBeenCalledWith(
        { companyId },
        { session },
      );
      fileModel.countDocuments.mockResolvedValue(plan.includedFilesPerMonth);
      if (code !== PlanCode.PREMIUM)
        await expect(
          service.recordFileUploads(companyId),
        ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('does not reset Basic stored capacity at a billing boundary', async () => {
    subscriptionsService.getSubscription.mockResolvedValue({
      planCode: PlanCode.BASIC,
      activatedAt,
    });
    subscriptionsService.acquireLock.mockResolvedValue({
      planCode: PlanCode.BASIC,
      activatedAt,
    });
    periodModel.findOne.mockResolvedValue(null);
    fileModel.countDocuments.mockResolvedValue(100);
    await expect(
      service.checkFileUpload(companyId, 1, new Date('2026-02-21')),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      service.recordFileUploads(companyId, 1, new Date('2026-02-21')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('quotes Premium overage above stored capacity even at the start of a new billing period', async () => {
    subscriptionsService.getSubscription.mockResolvedValue({
      planCode: PlanCode.PREMIUM,
      activatedAt,
    });
    periodModel.findOne.mockResolvedValue(null);
    fileModel.countDocuments.mockResolvedValue(1000);
    await expect(service.checkFileUpload(companyId)).resolves.toMatchObject({
      allowed: true,
      additionalChargeCents: 50,
      uploadedFiles: 0,
    });
  });

  it('quotes only the incremental Premium overage for a request', async () => {
    subscriptionsService.getSubscription.mockResolvedValue({
      planCode: PlanCode.PREMIUM,
      activatedAt,
    });
    periodModel.findOne.mockResolvedValue({ uploadedFiles: 1001 });
    fileModel.countDocuments.mockResolvedValue(1001);
    await expect(
      service.checkFileUpload(
        companyId,
        2,
        new Date('2026-01-21T00:00:00.000Z'),
      ),
    ).resolves.toMatchObject({
      allowed: true,
      additionalChargeCents: 100,
    });
  });

  it('atomically records Premium usage and overage', async () => {
    subscriptionsService.acquireLock.mockResolvedValue({
      planCode: PlanCode.PREMIUM,
      activatedAt,
    });
    periodModel.findOne.mockResolvedValue({ uploadedFiles: 999 });
    fileModel.countDocuments.mockResolvedValue(999);
    await service.recordFileUploads(
      companyId,
      3,
      new Date('2026-01-21T00:00:00.000Z'),
    );
    expect(periodModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        companyId,
        startsAt: new Date('2026-01-20T10:00:00.000Z'),
      },
      expect.objectContaining({
        $inc: { uploadedFiles: 3, fileOverageCents: 100 },
      }),
      expect.objectContaining({ upsert: true, session }),
    );
  });

  it('rejects hard-limit usage without updating the counter', async () => {
    fileModel.countDocuments.mockResolvedValue(10);
    await expect(
      service.recordFileUploads(
        companyId,
        1,
        new Date('2026-01-21T00:00:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(periodModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects invalid file quantities', async () => {
    await expect(service.checkFileUpload(companyId, 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.recordFileUploads(companyId, 1.5),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks uploads and onboarding for suspended managed payment state', async () => {
    subscriptionsService.paymentsEnabled = true;
    const managed = {
      planCode: PlanCode.PREMIUM,
      activatedAt,
      stripeManaged: true,
      paymentAccess: PaymentAccess.SUSPENDED,
      stripeSyncedAt: new Date(),
    };
    subscriptionsService.getSubscription.mockResolvedValue(managed);
    subscriptionsService.acquireLock.mockResolvedValue(managed);
    await expect(service.checkFileUpload(companyId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.assertEmployeeCapacity(companyId, session as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.recordFileUploads(companyId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(periodModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('reserves the stricter queued downgrade limits for both seats and files', async () => {
    const queued = {
      planCode: PlanCode.PREMIUM,
      pendingPlanCode: PlanCode.BASIC,
      activatedAt,
    };
    subscriptionsService.getSubscription.mockResolvedValue(queued);
    subscriptionsService.acquireLock.mockResolvedValue(queued);
    userModel.countDocuments.mockResolvedValue(9);
    invitationModel.countDocuments.mockResolvedValue(1);
    await expect(
      service.assertEmployeeCapacity(companyId, session as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    periodModel.findOne.mockResolvedValue({ uploadedFiles: 100 });
    fileModel.countDocuments.mockResolvedValue(100);
    await expect(service.checkFileUpload(companyId)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(service.recordFileUploads(companyId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(periodModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('enqueues only incremental overage inside the same successful-upload transaction', async () => {
    subscriptionsService.paymentsEnabled = true;
    const at = new Date('2026-01-21T00:00:00.000Z');
    const managed = {
      planCode: PlanCode.PREMIUM,
      activatedAt,
      stripeManaged: true,
      paymentAccess: PaymentAccess.ACTIVE,
      stripeSyncedAt: at,
    };
    subscriptionsService.acquireLock.mockResolvedValue(managed);
    periodModel.findOne.mockResolvedValue({ uploadedFiles: 999 });
    fileModel.countDocuments.mockResolvedValue(999);
    await service.recordFileUploads(companyId, 3, at);
    expect(subscriptionsService.enqueueOverage).toHaveBeenCalledWith(
      managed,
      { startsAt: activatedAt, endsAt: new Date('2026-02-20T10:00:00.000Z') },
      1002,
      100,
      at,
      session,
    );
    subscriptionsService.enqueueOverage.mockRejectedValueOnce(
      new Error('outbox persistence failed'),
    );
    periodModel.findOneAndUpdate.mockClear();
    await expect(service.recordFileUploads(companyId, 3, at)).rejects.toThrow(
      'outbox persistence failed',
    );
    expect(periodModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
