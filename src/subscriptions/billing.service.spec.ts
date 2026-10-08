import { InternalServerErrorException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PLAN_CATALOG, PlanCode } from '../plans/plan.constants';
import { BillingCalculationBasis, BillingService } from './billing.service';
import { Subscription } from './entities/subscription.entity';
import { SubscriptionPeriod } from './entities/subscription-period.entity';

describe('BillingService', () => {
  const service = new BillingService({
    findOne: (code: PlanCode) => PLAN_CATALOG[code],
  } as never);
  const companyId = new Types.ObjectId();
  const activatedAt = new Date('2024-01-31T08:00:00.000Z');
  const at = new Date('2024-02-29T08:00:00.000Z');

  const subscription = (planCode: PlanCode, planChangedAt = activatedAt) =>
    ({ companyId, planCode, activatedAt, planChangedAt }) as Subscription;
  const usage = (uploadedFiles: number, fileOverageCents: number) =>
    ({ uploadedFiles, fileOverageCents }) as SubscriptionPeriod;

  it('calculates Free entirely from authoritative plan and tenant usage data', () => {
    expect(
      service.calculate(subscription(PlanCode.FREE), usage(10, 0), 0, at),
    ).toMatchObject({
      companyId,
      calculationBasis:
        BillingCalculationBasis.CURRENT_PLAN_ESTIMATE_WITH_RECORDED_OVERAGE,
      currency: 'USD',
      plan: { code: PlanCode.FREE },
      billingPeriod: {
        startsAt: new Date('2024-02-29T08:00:00.000Z'),
        endsAt: new Date('2024-03-31T08:00:00.000Z'),
      },
      baseAmountCents: 0,
      employeeCount: 0,
      billableEmployeeCount: 0,
      employeeChargeCents: 0,
      includedUploadAllowance: 10,
      successfulUploads: 10,
      billableOverageUploads: 0,
      overageChargeCents: 0,
      totalAmountCents: 0,
    });
  });

  it.each(Array.from({ length: 11 }, (_, employeeCount) => employeeCount))(
    'charges Basic exactly $5 for each of %i employees',
    (employeeCount) => {
      expect(
        service.calculate(
          subscription(PlanCode.BASIC),
          usage(100, 0),
          employeeCount,
          at,
        ),
      ).toMatchObject({
        billableEmployeeCount: employeeCount,
        employeeUnitPriceCents: 500,
        employeeChargeCents: employeeCount * 500,
        totalAmountCents: employeeCount * 500,
      });
    },
  );

  it.each([
    [999, 0, 0, 30000],
    [1000, 0, 0, 30000],
    [1001, 50, 1, 30050],
    [1007, 350, 7, 30350],
  ])(
    'calculates Premium usage %i with exact integer cents',
    (uploadedFiles, overageCents, overageUploads, totalCents) => {
      expect(
        service.calculate(
          subscription(PlanCode.PREMIUM),
          usage(uploadedFiles, overageCents),
          37,
          at,
        ),
      ).toMatchObject({
        baseAmountCents: 30000,
        employeeCount: 37,
        billableEmployeeCount: 0,
        employeeChargeCents: 0,
        successfulUploads: uploadedFiles,
        billableOverageUploads: overageUploads,
        overageUnitPriceCents: 50,
        overageChargeCents: overageCents,
        totalAmountCents: totalCents,
      });
    },
  );

  it('retains recorded Premium overage after an immediate downgrade', () => {
    expect(
      service.calculate(
        subscription(PlanCode.BASIC, new Date('2024-02-29T09:00:00.000Z')),
        usage(1001, 50),
        2,
        new Date('2024-02-29T10:00:00.000Z'),
      ),
    ).toMatchObject({
      plan: { code: PlanCode.BASIC },
      planChangedInCurrentPeriod: true,
      employeeChargeCents: 1000,
      overageChargeCents: 50,
      totalAmountCents: 1050,
    });
  });

  it('distinguishes activation from a plan change exactly on a period boundary', () => {
    expect(
      service.calculate(subscription(PlanCode.FREE), null, 0, activatedAt),
    ).toMatchObject({ planChangedInCurrentPeriod: false });
    expect(
      service.calculate(subscription(PlanCode.PREMIUM, at), null, 0, at),
    ).toMatchObject({ planChangedInCurrentPeriod: true });
  });

  it('calculates incremental overage with integer arithmetic', () => {
    expect(
      service.calculateAdditionalOverageCents(
        PLAN_CATALOG[PlanCode.PREMIUM],
        999,
        1003,
      ),
    ).toBe(150);
    expect(
      service.calculateAdditionalOverageCents(
        PLAN_CATALOG[PlanCode.PREMIUM],
        1003,
        1005,
      ),
    ).toBe(100);
    expect(
      service.calculateAdditionalOverageCents(
        PLAN_CATALOG[PlanCode.BASIC],
        99,
        100,
      ),
    ).toBe(0);
  });

  it('fails closed for corrupt or unsafe accounting values', () => {
    const current = subscription(PlanCode.PREMIUM);
    expect(() => service.calculate(current, usage(1001, 25), 0, at)).toThrow(
      InternalServerErrorException,
    );
    expect(() => service.calculate(current, usage(0, 50), 0, at)).toThrow(
      InternalServerErrorException,
    );
    expect(() =>
      service.calculate(current, usage(0, 0), Number.MAX_SAFE_INTEGER + 1, at),
    ).toThrow(InternalServerErrorException);
  });
});
