import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PlansService } from '../plans/plans.service';
import { PlanCode, PlanDefinition } from '../plans/plan.constants';
import { billingPeriod } from './billing-period';
import { Subscription } from './entities/subscription.entity';
import { SubscriptionPeriod } from './entities/subscription-period.entity';

export enum BillingCalculationBasis {
  CURRENT_PLAN_ESTIMATE_WITH_RECORDED_OVERAGE = 'current_plan_estimate_with_recorded_overage',
}

// A computed view of existing tenant accounting, never a payment or invoice record.
@Injectable()
export class BillingService {
  constructor(private readonly plans: PlansService) {}

  calculate(
    subscription: Subscription,
    usage: SubscriptionPeriod | null,
    employeeCount: number,
    at: Date,
  ) {
    const plan = this.plans.findOne(subscription.planCode);
    const period = billingPeriod(subscription.activatedAt, at);
    const successfulUploads = usage?.uploadedFiles ?? 0;
    const overageChargeCents = usage?.fileOverageCents ?? 0;
    const overageUnitPriceCents = this.plans.findOne(
      PlanCode.PREMIUM,
    ).extraFilePriceCents!;
    this.assertInteger(employeeCount);
    this.assertInteger(successfulUploads);
    this.assertInteger(overageChargeCents);
    this.assertInteger(plan.basePriceCents);
    this.assertInteger(plan.employeePriceCents);
    this.assertInteger(overageUnitPriceCents);
    if (
      overageUnitPriceCents === 0 ||
      BigInt(overageChargeCents) % BigInt(overageUnitPriceCents) !== 0n
    )
      throw new InternalServerErrorException('Invalid billing accounting data');

    const billableEmployeeCount =
      plan.employeePriceCents > 0 ? employeeCount : 0;
    const employeeChargeCents = this.safeNumber(
      BigInt(billableEmployeeCount) * BigInt(plan.employeePriceCents),
    );
    const billableOverageUploads = this.safeNumber(
      BigInt(overageChargeCents) / BigInt(overageUnitPriceCents),
    );
    if (billableOverageUploads > successfulUploads)
      throw new InternalServerErrorException('Invalid billing accounting data');

    return {
      companyId: subscription.companyId,
      calculationBasis:
        BillingCalculationBasis.CURRENT_PLAN_ESTIMATE_WITH_RECORDED_OVERAGE,
      currency: plan.currency,
      plan,
      activatedAt: subscription.activatedAt,
      planChangedAt: subscription.planChangedAt,
      planChangedInCurrentPeriod:
        subscription.planChangedAt >= period.startsAt &&
        subscription.planChangedAt <= at &&
        subscription.planChangedAt.getTime() !==
          subscription.activatedAt.getTime(),
      billingPeriod: period,
      baseAmountCents: plan.basePriceCents,
      employeeCount,
      billableEmployeeCount,
      employeeUnitPriceCents: plan.employeePriceCents,
      employeeChargeCents,
      includedUploadAllowance: plan.includedFilesPerMonth,
      successfulUploads,
      billableOverageUploads,
      overageUnitPriceCents,
      overageChargeCents,
      totalAmountCents: this.safeNumber(
        BigInt(plan.basePriceCents) +
          BigInt(employeeChargeCents) +
          BigInt(overageChargeCents),
      ),
    };
  }

  calculateAdditionalOverageCents(
    plan: Readonly<PlanDefinition>,
    uploadedFiles: number,
    resultingFiles: number,
  ) {
    this.assertInteger(uploadedFiles);
    this.assertInteger(resultingFiles);
    if (resultingFiles < uploadedFiles)
      throw new InternalServerErrorException('Invalid billing accounting data');
    if (plan.extraFilePriceCents === null) return 0;
    this.assertInteger(plan.includedFilesPerMonth);
    this.assertInteger(plan.extraFilePriceCents);
    const includedFiles = BigInt(plan.includedFilesPerMonth);
    const priorExcess =
      BigInt(uploadedFiles) > includedFiles
        ? BigInt(uploadedFiles) - includedFiles
        : 0n;
    const resultingExcess =
      BigInt(resultingFiles) > includedFiles
        ? BigInt(resultingFiles) - includedFiles
        : 0n;
    return this.safeNumber(
      (resultingExcess - priorExcess) * BigInt(plan.extraFilePriceCents),
    );
  }

  private assertInteger(value: number) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new InternalServerErrorException('Invalid billing accounting data');
  }

  private safeNumber(value: bigint) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new InternalServerErrorException(
        'Billing amount exceeds safe range',
      );
    return Number(value);
  }
}
