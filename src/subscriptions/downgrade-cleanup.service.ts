import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { ClientSession, Connection, Model } from 'mongoose';
import { ObjectStorage } from '../aws-s3/object-storage';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { isTerminalStripeStatus } from '../payments/payment.constants';
import { Role } from '../enums/roles.enum';
import { CompanyFile } from '../files/entities/company-file.entity';
import {
  EmployeeInvitation,
  InvitationStatus,
} from '../invitations/entities/employee-invitation.entity';
import { PlanCode } from '../plans/plan.constants';
import { PlansService } from '../plans/plans.service';
import { User } from '../users/entities/user.entity';
import { SubscriptionsService } from './subscriptions.service';

@Injectable()
export class DowngradeCleanupService {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly plans: PlansService,
    private readonly storage: ObjectStorage,
    @InjectModel('companyFile') private readonly files: Model<CompanyFile>,
    @InjectModel('user') private readonly users: Model<User>,
    @InjectModel('employeeInvitation')
    private readonly invitations: Model<EmployeeInvitation>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private async snapshot(
    actor: AuthenticatedUser,
    code: PlanCode,
    session?: ClientSession,
  ) {
    if (actor.role !== Role.COMPANY_OWNER)
      throw new ForbiddenException('Company owner access is required');
    const subscription = await this.subscriptions.getSubscription(
      actor.companyId,
      session,
    );
    if (subscription.stripeManaged && !this.subscriptions.paymentsEnabled)
      throw new ForbiddenException(
        'Enable billing before cleaning up a Stripe-managed plan',
      );
    const rank = { free: 0, basic: 1, premium: 2 };
    if (rank[code] >= rank[subscription.planCode])
      throw new ConflictException('Cleanup is available only for a lower plan');
    const plan = this.plans.findOne(code);
    const files = await this.files
      .find({ companyId: actor.companyId })
      .session(session ?? null)
      .select('_id createdAt')
      .sort({ createdAt: -1, _id: -1 })
      .lean();
    const employees = await this.users
      .find({ companyId: actor.companyId, role: Role.COMPANY_MEMBER })
      .session(session ?? null)
      .select('_id createdAt')
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    const invitations = await this.invitations
      .find({
        companyId: actor.companyId,
        status: InvitationStatus.PENDING,
        expiresAt: { $gt: new Date() },
      })
      .session(session ?? null)
      .select('_id createdAt')
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    const keepEmployees =
      plan.maxEmployees === null
        ? employees.length
        : Math.min(plan.maxEmployees, employees.length);
    const keepInvitations =
      plan.maxEmployees === null
        ? invitations.length
        : Math.max(0, plan.maxEmployees - keepEmployees);
    const fileIds = files
      .slice(plan.includedFilesPerMonth)
      .map((file) => file._id);
    const employeeIds = employees.slice(keepEmployees).map((user) => user._id);
    const invitationIds = invitations
      .slice(keepInvitations)
      .map((invitation) => invitation._id);
    const previewToken = createHash('sha256')
      .update(
        JSON.stringify({
          companyId: actor.companyId,
          code,
          currentPlan: subscription.planCode,
          files: files.map((file) => file._id),
          employees: employees.map((user) => user._id),
          invitations: invitations.map((invitation) => invitation._id),
        }),
      )
      .digest('hex');
    return {
      fileIds,
      employeeIds,
      invitationIds,
      preview: {
        planCode: code,
        previewToken,
        fileLimit: plan.includedFilesPerMonth,
        storedFiles: files.length,
        filesToRemove: fileIds.length,
        filesToKeep: Math.min(files.length, plan.includedFilesPerMonth),
        employeeLimit: plan.maxEmployees,
        employees: employees.length,
        employeesToRemove: employeeIds.length,
        pendingInvitations: invitations.length,
        invitationsToRevoke: invitationIds.length,
      },
    };
  }

  async preview(actor: AuthenticatedUser, code: PlanCode) {
    return (await this.snapshot(actor, code)).preview;
  }

  async cleanup(actor: AuthenticatedUser, code: PlanCode, token: string) {
    const snapshot = await this.snapshot(actor, code);
    if (snapshot.preview.previewToken !== token)
      throw new ConflictException({
        code: 'cleanup_preview_changed',
        message: 'Workspace changed; review a fresh cleanup preview',
      });
    const subscription = await this.subscriptions.getSubscription(
      actor.companyId,
    );
    if (
      this.subscriptions.paymentsEnabled &&
      code !== PlanCode.FREE &&
      (!subscription.stripeSubscriptionId ||
        isTerminalStripeStatus(subscription.stripeStatus))
    )
      throw new ConflictException({
        code: 'cleanup_payment_setup',
        message: 'Connect paid billing before automatic cleanup',
      });
    // Storage and Stripe cannot share a MongoDB transaction. The confirmation
    // explicitly authorizes cleanup now, even if a subsequent plan request fails.
    try {
      for (const id of [...snapshot.fileIds].reverse()) {
        const file = await this.files
          .findOne({ _id: id, companyId: actor.companyId })
          .select('+storageKey');
        if (!file) continue;
        await this.storage.deleteObject(file.storageKey);
        await this.files.findOneAndDelete({
          _id: id,
          companyId: actor.companyId,
          storageKey: file.storageKey,
        });
      }
      await this.connection.transaction(async (session) => {
        await this.subscriptions.acquireLock(actor.companyId, session);
        // Recheck membership before removing accounts: invitation acceptance
        // shares this lock and must never change which accounts were confirmed.
        const current = await this.snapshot(actor, code, session);
        if (
          JSON.stringify(current.employeeIds) !==
            JSON.stringify(snapshot.employeeIds) ||
          JSON.stringify(current.invitationIds) !==
            JSON.stringify(snapshot.invitationIds)
        )
          throw new ConflictException({
            code: 'cleanup_preview_changed',
            message: 'Workspace membership changed; review cleanup again',
          });
        await this.users.deleteMany(
          {
            companyId: actor.companyId,
            role: Role.COMPANY_MEMBER,
            _id: { $in: snapshot.employeeIds },
          },
          { session },
        );
        await this.invitations.updateMany(
          {
            companyId: actor.companyId,
            status: InvitationStatus.PENDING,
            _id: { $in: snapshot.invitationIds },
          },
          {
            $set: { status: InvitationStatus.REVOKED, revokedAt: new Date() },
            $unset: { tokenHash: 1 },
          },
          { session },
        );
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException({
        code: 'cleanup_incomplete',
        message:
          'Cleanup did not finish; review the remaining items before retrying',
      });
    }
    return this.subscriptions.changePlan(actor, code);
  }
}
