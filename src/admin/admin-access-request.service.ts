import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { EmailSender } from '../email/email-sender';
import { PLATFORM_ADMIN_BCRYPT_ROUNDS } from './admin-security';
import { AdminAudit, AdminAuditAction } from './entities/admin-audit.entity';
import {
  AdminAccessRequest,
  AdminAccessRequestStatus as Status,
} from './entities/admin-access-request.entity';
import { PlatformAdmin } from './entities/platform-admin.entity';
import {
  AccessDecisionDto,
  RequestPlatformAccessDto,
  SetupPlatformAccessDto,
} from './dto/admin-access-request.dto';

const LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REQUEST_MESSAGE =
  'If the email can receive a request, a verification link will arrive shortly.';

function newToken() {
  const value = randomBytes(32).toString('base64url');
  return { value, hash: createHash('sha256').update(value).digest('hex') };
}

function hashToken(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class AdminAccessRequestService {
  private readonly logger = new Logger(AdminAccessRequestService.name);

  constructor(
    @InjectModel('adminAccessRequest')
    private readonly requests: Model<AdminAccessRequest>,
    @InjectModel('platformAdmin') private readonly admins: Model<PlatformAdmin>,
    @InjectModel('adminAudit') private readonly audits: Model<AdminAudit>,
    @InjectConnection() private readonly connection: Connection,
    private readonly config: ConfigService,
    private readonly email: EmailSender,
  ) {}

  private link(fragment: string, token: string) {
    const url = new URL(
      '/admin',
      this.config.getOrThrow<string>('ACCOUNT_ACTIVATION_URL'),
    );
    url.hash = `${fragment}=${token}`;
    return url.toString();
  }

  async request(dto: RequestPlatformAccessDto) {
    const now = new Date();
    // An expired unverified application cannot permanently prevent a retry.
    await this.requests.updateMany(
      {
        email: dto.email,
        status: Status.AWAITING_VERIFICATION,
        verificationExpiresAt: { $lte: now },
      },
      {
        $set: { status: Status.EXPIRED },
        $unset: { verificationTokenHash: '', verificationExpiresAt: '' },
      },
    );
    if (await this.admins.exists({ email: dto.email }))
      return { message: REQUEST_MESSAGE };
    if (
      await this.requests.exists({
        email: dto.email,
        status: {
          $in: [
            Status.AWAITING_VERIFICATION,
            Status.PENDING_REVIEW,
            Status.APPROVED,
          ],
        },
      })
    )
      return { message: REQUEST_MESSAGE };

    const token = newToken();
    let request: AdminAccessRequest & { _id: Types.ObjectId };
    try {
      await this.connection.transaction(async (session) => {
        [request] = await this.requests.create(
          [
            {
              email: dto.email,
              fullName: dto.fullName.trim(),
              reason: dto.reason?.trim(),
              status: Status.AWAITING_VERIFICATION,
              verificationTokenHash: token.hash,
              verificationExpiresAt: new Date(now.getTime() + LINK_LIFETIME_MS),
            },
          ],
          { session },
        );
        await this.audits.create(
          [
            {
              action: AdminAuditAction.ACCESS_REQUESTED,
              targetId: request._id,
              targetType: 'admin_access_request',
            },
          ],
          { session },
        );
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        return { message: REQUEST_MESSAGE };
      throw new ServiceUnavailableException(
        'Access request temporarily unavailable',
      );
    }
    try {
      await this.email.send({
        to: dto.email,
        subject: 'Verify your DataVault platform admin access request',
        text: `Verify your email to submit your platform admin access request:\n\n${this.link('verify_admin_request', token.value)}\n\nThis link expires in 24 hours and works once. If you did not request access, ignore this email.`,
      });
    } catch {
      this.logger.warn('Platform admin request verification email failed');
      try {
        await this.requests.updateOne(
          { _id: request!._id, status: Status.AWAITING_VERIFICATION },
          {
            $set: { status: Status.EXPIRED },
            $unset: { verificationTokenHash: '', verificationExpiresAt: '' },
          },
        );
      } catch {
        this.logger.warn('Platform admin request token cleanup failed');
      }
    }
    return { message: REQUEST_MESSAGE };
  }

  async verify(token: string) {
    let request: (AdminAccessRequest & { _id: Types.ObjectId }) | null = null;
    try {
      await this.connection.transaction(async (session) => {
        request = await this.requests.findOneAndUpdate(
          {
            status: Status.AWAITING_VERIFICATION,
            verificationTokenHash: hashToken(token),
            verificationExpiresAt: { $gt: new Date() },
          },
          {
            $set: { status: Status.PENDING_REVIEW, verifiedAt: new Date() },
            $unset: { verificationTokenHash: '', verificationExpiresAt: '' },
          },
          { new: true, session },
        );
        if (!request)
          throw new BadRequestException(
            'This verification link is invalid or expired.',
          );
        await this.audits.create(
          [
            {
              action: AdminAuditAction.ACCESS_VERIFIED,
              targetId: request._id,
              targetType: 'admin_access_request',
            },
          ],
          { session },
        );
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException(
        'Verification temporarily unavailable',
      );
    }
    try {
      const admins = await this.admins
        .find({ isActive: true })
        .select('email')
        .lean();
      const adminPage = new URL(
        '/admin',
        this.config.getOrThrow<string>('ACCOUNT_ACTIVATION_URL'),
      ).toString();
      const notifications = await Promise.allSettled(
        admins.map((admin) =>
          this.email.send({
            to: admin.email,
            subject: 'Platform admin access request awaiting review',
            text: `A verified request for platform admin access is ready for review. Sign in to the DataVault platform admin panel to review it:\n\n${adminPage}`,
          }),
        ),
      );
      if (notifications.some((result) => result.status === 'rejected'))
        this.logger.warn('One or more platform admin review emails failed');
    } catch {
      // The verified request remains visible in the review panel.
      this.logger.warn(
        'Platform admin review notification could not be prepared',
      );
    }
    return {
      verified: true,
      message: 'Request sent. Please wait for a decision.',
    };
  }

  async list(page: number, limit: number) {
    const filter = {
      status: {
        $in: [
          Status.PENDING_REVIEW,
          Status.APPROVED,
          Status.REJECTED,
          Status.ACTIVATED,
        ],
      },
    };
    const [items, total] = await Promise.all([
      this.requests
        .find(filter)
        .select(
          'fullName email reason status createdAt verifiedAt reviewedAt activatedAt',
        )
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.requests.countDocuments(filter),
    ]);
    return {
      items: items.map((item) => ({
        id: item._id.toString(),
        fullName: item.fullName,
        email: item.email,
        reason: item.reason,
        status: item.status,
        createdAt: item.createdAt,
        verifiedAt: item.verifiedAt,
        reviewedAt: item.reviewedAt,
        activatedAt: item.activatedAt,
      })),
      total,
      page,
      limit,
    };
  }

  async decide(actorId: string, id: string, dto: AccessDecisionDto) {
    const approving = dto.decision === 'approve';
    const token = approving ? newToken() : null;
    let request: (AdminAccessRequest & { _id: Types.ObjectId }) | null = null;
    try {
      await this.connection.transaction(async (session) => {
        request = await this.requests.findOneAndUpdate(
          { _id: id, status: Status.PENDING_REVIEW },
          {
            $set: {
              status: approving ? Status.APPROVED : Status.REJECTED,
              reviewedBy: new Types.ObjectId(actorId),
              reviewedAt: new Date(),
              ...(token
                ? {
                    setupTokenHash: token.hash,
                    setupExpiresAt: new Date(Date.now() + LINK_LIFETIME_MS),
                  }
                : {}),
            },
          },
          { new: true, session },
        );
        if (!request)
          throw new ConflictException(
            'This request has already been reviewed.',
          );
        await this.audits.create(
          [
            {
              action: approving
                ? AdminAuditAction.ACCESS_APPROVED
                : AdminAuditAction.ACCESS_REJECTED,
              actorId: new Types.ObjectId(actorId),
              targetId: request._id,
              targetType: 'admin_access_request',
            },
          ],
          { session },
        );
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException('Decision temporarily unavailable');
    }
    let notificationDelivered = true;
    try {
      await this.email.send({
        to: request!.email,
        subject: approving
          ? 'Your DataVault platform admin access was approved'
          : 'Your DataVault platform admin access request',
        text: approving
          ? `Your request was approved. Set your password using this one-time link:\n\n${this.link('setup_admin', token!.value)}\n\nThe link expires in 24 hours. Then sign in from the platform admin page.`
          : 'Your request for DataVault platform admin access was not approved. No platform admin account was created.',
      });
    } catch {
      notificationDelivered = false;
      this.logger.warn('Platform admin access decision email failed');
    }
    return { status: request!.status, notificationDelivered };
  }

  async resendSetup(id: string) {
    const token = newToken();
    const request = await this.requests.findOneAndUpdate(
      { _id: id, status: Status.APPROVED },
      {
        $set: {
          setupTokenHash: token.hash,
          setupExpiresAt: new Date(Date.now() + LINK_LIFETIME_MS),
        },
      },
      { new: true },
    );
    if (!request)
      throw new ConflictException(
        'This request is not awaiting account setup.',
      );
    try {
      await this.email.send({
        to: request.email,
        subject: 'Set your DataVault platform admin password',
        text: `Use this new one-time link to set your platform admin password:\n\n${this.link('setup_admin', token.value)}\n\nThe link expires in 24 hours.`,
      });
      return { sent: true };
    } catch {
      this.logger.warn('Platform admin setup email failed');
      throw new ServiceUnavailableException(
        'Setup email could not be sent. Please try again.',
      );
    }
  }

  async resendRejection(id: string) {
    const request = await this.requests.findOne({
      _id: id,
      status: Status.REJECTED,
    });
    if (!request)
      throw new ConflictException('This request has not been rejected.');
    try {
      await this.email.send({
        to: request.email,
        subject: 'Your DataVault platform admin access request',
        text: 'Your request for DataVault platform admin access was not approved. No platform admin account was created.',
      });
      return { sent: true };
    } catch {
      this.logger.warn('Platform admin rejection email failed');
      throw new ServiceUnavailableException(
        'Decision email could not be sent. Please try again.',
      );
    }
  }

  async setup(dto: SetupPlatformAccessDto) {
    const password = await bcrypt.hash(
      dto.newPassword,
      PLATFORM_ADMIN_BCRYPT_ROUNDS,
    );
    try {
      await this.connection.transaction(async (session) => {
        const request = await this.requests.findOneAndUpdate(
          {
            status: Status.APPROVED,
            setupTokenHash: hashToken(dto.token),
            setupExpiresAt: { $gt: new Date() },
          },
          {
            $set: { status: Status.ACTIVATED, activatedAt: new Date() },
            $unset: { setupTokenHash: '', setupExpiresAt: '' },
          },
          { session, new: true },
        );
        if (!request)
          throw new BadRequestException(
            'This setup link is invalid or expired.',
          );
        const [admin] = await this.admins.create(
          [
            {
              email: request.email,
              fullName: request.fullName,
              password,
              isActive: true,
            },
          ],
          { session },
        );
        await this.audits.create(
          [
            {
              action: AdminAuditAction.ACCESS_ACTIVATED,
              actorId: admin._id,
              targetId: request._id,
              targetType: 'admin_access_request',
            },
          ],
          { session },
        );
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if ((error as { code?: number }).code === 11000)
        throw new BadRequestException('This setup link can no longer be used.');
      throw new ServiceUnavailableException(
        'Account setup temporarily unavailable',
      );
    }
    return { activated: true };
  }
}
