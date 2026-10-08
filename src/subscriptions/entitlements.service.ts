import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model } from 'mongoose';
import { Role } from '../enums/roles.enum';
import { PlansService } from '../plans/plans.service';
import { CompanyFile } from '../files/entities/company-file.entity';
import { User } from '../users/entities/user.entity';
import {
  EmployeeInvitation,
  InvitationStatus,
} from '../invitations/entities/employee-invitation.entity';
import { billingPeriod } from './billing-period';
import { EntitlementDenialReason } from './subscription.constants';
import { SubscriptionPeriod } from './entities/subscription-period.entity';
import { SubscriptionsService } from './subscriptions.service';
import { BillingService } from './billing.service';
import { assertPaymentAccess } from '../payments/payment-policy';

@Injectable()
export class EntitlementsService {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly plansService: PlansService,
    private readonly billingService: BillingService,
    @InjectModel('user') private readonly userModel: Model<User>,
    @InjectModel('employeeInvitation')
    private readonly invitationModel: Model<EmployeeInvitation>,
    @InjectModel('subscriptionPeriod')
    private readonly periodModel: Model<SubscriptionPeriod>,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('companyFile') private readonly fileModel: Model<CompanyFile>,
  ) {}

  async assertEmployeeCapacity(
    companyId: string,
    session: ClientSession,
    additionalSeats = 1,
    at = new Date(),
  ) {
    if (!Number.isSafeInteger(additionalSeats) || additionalSeats < 0)
      throw new BadRequestException(
        'Additional employee seats must be a non-negative integer',
      );
    const subscription = await this.subscriptionsService.acquireLock(
      companyId,
      session,
    );
    assertPaymentAccess(
      subscription,
      this.subscriptionsService.paymentsEnabled,
      at,
    );
    const plan = this.plansService.findOne(subscription.planCode);
    const target = subscription.pendingPlanCode
      ? this.plansService.findOne(subscription.pendingPlanCode)
      : plan;
    const limit =
      plan.maxEmployees === null
        ? target.maxEmployees
        : target.maxEmployees === null
          ? plan.maxEmployees
          : Math.min(plan.maxEmployees, target.maxEmployees);
    if (limit === null) return;
    const employeeCount = await this.userModel.countDocuments(
      { companyId, role: Role.COMPANY_MEMBER },
      { session },
    );
    const pendingInvitationCount = await this.invitationModel.countDocuments(
      {
        companyId,
        status: InvitationStatus.PENDING,
        expiresAt: { $gt: at },
      },
      { session },
    );
    if (employeeCount + pendingInvitationCount + additionalSeats > limit)
      throw new ForbiddenException({
        message: `The ${plan.name} plan employee limit has been reached`,
        reason: EntitlementDenialReason.EMPLOYEE_LIMIT_REACHED,
        limit,
        employees: employeeCount,
        pendingInvitations: pendingInvitationCount,
      });
  }

  async checkFileUpload(companyId: string, quantity = 1, at = new Date()) {
    this.validateQuantity(quantity);
    const subscription =
      await this.subscriptionsService.getSubscription(companyId);
    assertPaymentAccess(
      subscription,
      this.subscriptionsService.paymentsEnabled,
      at,
    );
    const plan = this.plansService.findOne(subscription.planCode);
    const target = subscription.pendingPlanCode
      ? this.plansService.findOne(subscription.pendingPlanCode)
      : plan;
    const period = billingPeriod(subscription.activatedAt, at);
    const usage = await this.periodModel.findOne({
      companyId,
      startsAt: period.startsAt,
    });
    const uploadedFiles = usage?.uploadedFiles ?? 0;
    const storedFiles = await this.fileModel.countDocuments({ companyId });
    const resultingFiles = storedFiles + quantity;
    const targetFiles = resultingFiles;
    const excessFiles = Math.max(
      0,
      resultingFiles - plan.includedFilesPerMonth,
    );
    const allowed =
      (plan.extraFilePriceCents !== null || excessFiles === 0) &&
      (target.extraFilePriceCents !== null ||
        targetFiles <= target.includedFilesPerMonth);

    return {
      allowed,
      reason: allowed ? null : EntitlementDenialReason.FILE_LIMIT_REACHED,
      planCode: plan.code,
      uploadedFiles,
      quotaBasis: 'stored_files',
      requestedFiles: quantity,
      includedFilesPerMonth: plan.includedFilesPerMonth,
      remainingIncludedFiles: Math.max(
        0,
        plan.includedFilesPerMonth - storedFiles,
      ),
      additionalChargeCents:
        this.billingService.calculateAdditionalOverageCents(
          plan,
          storedFiles,
          resultingFiles,
        ),
      billingPeriod: period,
    };
  }

  async recordFileUploads(
    companyId: string,
    quantity = 1,
    at = new Date(),
    session?: ClientSession,
  ) {
    this.validateQuantity(quantity);
    if (session)
      return this.recordFileUploadsInTransaction(
        companyId,
        quantity,
        at,
        session,
      );
    return this.connection.transaction((transactionSession) =>
      this.recordFileUploadsInTransaction(
        companyId,
        quantity,
        at,
        transactionSession,
      ),
    );
  }

  private async recordFileUploadsInTransaction(
    companyId: string,
    quantity: number,
    at: Date,
    session: ClientSession,
  ) {
    const subscription = await this.subscriptionsService.acquireLock(
      companyId,
      session,
    );
    assertPaymentAccess(
      subscription,
      this.subscriptionsService.paymentsEnabled,
      at,
    );
    const plan = this.plansService.findOne(subscription.planCode);
    const target = subscription.pendingPlanCode
      ? this.plansService.findOne(subscription.pendingPlanCode)
      : plan;
    const period = billingPeriod(subscription.activatedAt, at);
    const usage = await this.periodModel.findOne(
      { companyId, startsAt: period.startsAt },
      null,
      { session },
    );
    const uploadedFiles = usage?.uploadedFiles ?? 0;
    const resultingFiles = uploadedFiles + quantity;
    // Serialize the stored count with metadata creation for every plan.
    const storedFiles = await this.fileModel.countDocuments(
      { companyId },
      { session },
    );
    const planFiles = storedFiles + quantity;
    const targetFiles = planFiles;
    if (
      (plan.extraFilePriceCents === null &&
        planFiles > plan.includedFilesPerMonth) ||
      (target.extraFilePriceCents === null &&
        targetFiles > target.includedFilesPerMonth)
    )
      throw new ForbiddenException({
        message: `The stored file limit has been reached. Delete a file to upload another.`,
        reason: EntitlementDenialReason.FILE_LIMIT_REACHED,
        limit: plan.includedFilesPerMonth,
      });
    const additionalOverageCents =
      this.billingService.calculateAdditionalOverageCents(
        plan,
        storedFiles,
        storedFiles + quantity,
      );

    if (subscription.stripeManaged)
      await this.subscriptionsService.enqueueOverage(
        subscription,
        period,
        resultingFiles,
        additionalOverageCents,
        at,
        session,
      );

    return this.periodModel.findOneAndUpdate(
      { companyId, startsAt: period.startsAt },
      {
        $setOnInsert: { companyId, ...period },
        $inc: {
          uploadedFiles: quantity,
          fileOverageCents: additionalOverageCents,
        },
      },
      { upsert: true, new: true, runValidators: true, session },
    );
  }

  private validateQuantity(quantity: number) {
    if (!Number.isSafeInteger(quantity) || quantity < 1)
      throw new BadRequestException('File quantity must be a positive integer');
  }
}
