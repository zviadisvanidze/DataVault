import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CompanyFile,
  CompanyFileVisibility,
} from '../files/entities/company-file.entity';
import {
  EmployeeInvitation,
  InvitationStatus,
} from '../invitations/entities/employee-invitation.entity';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

@Injectable()
export class StatisticsService {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    @InjectModel('employeeInvitation')
    private readonly invitationModel: Model<EmployeeInvitation>,
    @InjectModel('companyFile')
    private readonly fileModel: Model<CompanyFile>,
  ) {}

  async getCurrent(companyId: string, now = new Date()) {
    const companyFilter = { companyId };
    const [
      subscription,
      pendingInvitations,
      storedFiles,
      companyWide,
      restricted,
    ] = await Promise.all([
      this.subscriptionsService.getCurrent(companyId, now),
      this.invitationModel.countDocuments({
        ...companyFilter,
        status: InvitationStatus.PENDING,
        expiresAt: { $gt: now },
      }),
      this.fileModel.countDocuments(companyFilter),
      this.fileModel.countDocuments({
        ...companyFilter,
        $or: [
          { visibility: CompanyFileVisibility.COMPANY_WIDE },
          { visibility: { $exists: false } },
        ],
      }),
      this.fileModel.countDocuments({
        ...companyFilter,
        visibility: CompanyFileVisibility.RESTRICTED,
      }),
    ]);

    const { plan, billingSummary } = subscription;
    const employeesUnlimited = plan.maxEmployees === null;
    const uploadsUnlimited = plan.extraFilePriceCents !== null;
    const remainingIncludedUploads = Math.max(
      0,
      billingSummary.includedUploadAllowance - storedFiles,
    );

    return {
      companyId: subscription.companyId,
      subscription: {
        planCode: plan.code,
        planName: plan.name,
        activatedAt: subscription.activatedAt,
        planChangedAt: subscription.planChangedAt,
      },
      employees: {
        accepted: subscription.employeeCount,
        pendingInvitations,
        limit: plan.maxEmployees,
        unlimited: employeesUnlimited,
        remainingSlots: employeesUnlimited
          ? null
          : Math.max(
              0,
              plan.maxEmployees -
                subscription.employeeCount -
                pendingInvitations,
            ),
      },
      files: {
        currentlyStored: {
          total: storedFiles,
          companyWide,
          restricted,
        },
        currentBillingPeriod: {
          startsAt: billingSummary.billingPeriod.startsAt,
          endsAt: billingSummary.billingPeriod.endsAt,
          successfulUploads: billingSummary.successfulUploads,
          includedAllowance: billingSummary.includedUploadAllowance,
          unlimited: uploadsUnlimited,
          remainingIncludedUploads,
          remainingUploads: uploadsUnlimited ? null : remainingIncludedUploads,
          premiumOverageUploads: billingSummary.billableOverageUploads,
        },
      },
      billing: {
        calculationBasis: billingSummary.calculationBasis,
        currency: billingSummary.currency,
        baseAmountCents: billingSummary.baseAmountCents,
        employeeChargeCents: billingSummary.employeeChargeCents,
        overageChargeCents: billingSummary.overageChargeCents,
        totalAmountCents: billingSummary.totalAmountCents,
      },
    };
  }
}
