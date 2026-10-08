import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Connection, Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { EmailSender } from '../email/email-sender';
import { PlatformAdmin } from './entities/platform-admin.entity';
import {
  AdminAudit,
  AdminAuditAction,
  AdminAuditReason,
} from './entities/admin-audit.entity';
import {
  AdminForgotPasswordDto,
  AdminLoginDto,
  AdminResetPasswordDto,
} from './dto/admin.dto';
import {
  PLATFORM_ADMIN_BCRYPT_ROUNDS,
  PLATFORM_ADMIN_JWT,
  PLATFORM_ADMIN_TOKEN_TYPE,
} from './admin-security';

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  private dummyHash?: Promise<string>;
  constructor(
    @InjectModel('platformAdmin') private readonly admins: Model<PlatformAdmin>,
    @InjectModel('adminAudit') private readonly audits: Model<AdminAudit>,
    @Inject(PLATFORM_ADMIN_JWT) private readonly jwt: JwtService,
    @InjectConnection() private readonly connection: Connection,
    private readonly config: ConfigService,
    private readonly email: EmailSender,
  ) {}

  async login(dto: AdminLoginDto) {
    const admin = await this.admins
      .findOne({ email: dto.email })
      .select('+password');
    const dummy = await (this.dummyHash ??= bcrypt.hash(
      randomBytes(32).toString('hex'),
      12,
    ));
    const valid = await bcrypt.compare(dto.password, admin?.password ?? dummy);
    try {
      await this.audits.create({
        action:
          valid && admin?.isActive
            ? AdminAuditAction.LOGIN_SUCCEEDED
            : AdminAuditAction.LOGIN_FAILED,
        actorId: admin?._id,
        targetId: admin?._id,
        targetType: admin ? 'platform_admin' : undefined,
        reason:
          valid && admin?.isActive
            ? undefined
            : AdminAuditReason.INVALID_CREDENTIALS,
      });
    } catch {
      // Security-sensitive access fails closed if it cannot be recorded.
      throw new ServiceUnavailableException(
        'Platform authentication temporarily unavailable',
      );
    }
    if (!valid || !admin?.isActive)
      throw new UnauthorizedException('Invalid credentials');
    return {
      accessToken: await this.jwt.signAsync({
        sub: admin._id.toString(),
        type: PLATFORM_ADMIN_TOKEN_TYPE,
        version: admin.authVersion ?? 0,
      }),
    };
  }

  async forgotPassword(dto: AdminForgotPasswordDto) {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date();
    const admin = await this.admins.findOneAndUpdate(
      {
        email: dto.email,
        isActive: true,
        $or: [
          { passwordResetRequestedAt: { $exists: false } },
          {
            passwordResetRequestedAt: { $lte: new Date(now.getTime() - 60000) },
          },
        ],
      },
      {
        $set: {
          passwordResetTokenHash: tokenHash,
          passwordResetExpiresAt: new Date(now.getTime() + 30 * 60000),
          passwordResetRequestedAt: now,
        },
      },
      { new: true },
    );
    if (admin) {
      const link = new URL(
        '/admin',
        this.config.getOrThrow<string>('ACCOUNT_ACTIVATION_URL'),
      );
      link.hash = `reset=${token}`;
      try {
        await this.email.send({
          to: admin.email,
          subject: 'Reset your DataVault platform admin password',
          text: `Use this link to reset your DataVault platform admin password:\n\n${link.toString()}\n\nThe link expires in 30 minutes and works once. If you did not request it, ignore this email.`,
        });
      } catch {
        try {
          await this.admins.updateOne(
            { _id: admin._id, passwordResetTokenHash: tokenHash },
            {
              $unset: {
                passwordResetTokenHash: '',
                passwordResetExpiresAt: '',
                passwordResetRequestedAt: '',
              },
            },
          );
        } catch {
          this.logger.warn('Platform admin recovery token cleanup failed');
        }
        this.logger.warn('Platform admin recovery email could not be sent');
      }
    }
    return {
      message:
        'If this is an active platform admin email, a reset link will arrive shortly.',
    };
  }

  async resetPassword(dto: AdminResetPasswordDto) {
    const tokenHash = createHash('sha256').update(dto.token).digest('hex');
    const password = await bcrypt.hash(
      dto.newPassword,
      PLATFORM_ADMIN_BCRYPT_ROUNDS,
    );
    try {
      await this.connection.transaction(async (session) => {
        const admin = await this.admins.findOneAndUpdate(
          {
            passwordResetTokenHash: tokenHash,
            passwordResetExpiresAt: { $gt: new Date() },
            isActive: true,
          },
          {
            $set: { password },
            $inc: { authVersion: 1 },
            $unset: {
              passwordResetTokenHash: '',
              passwordResetExpiresAt: '',
              passwordResetRequestedAt: '',
            },
          },
          { session, new: true },
        );
        if (!admin)
          throw new UnauthorizedException('Invalid or expired reset link');
        await this.audits.create(
          [
            {
              action: AdminAuditAction.PASSWORD_RESET,
              actorId: admin._id,
              targetId: admin._id,
              targetType: 'platform_admin',
            },
          ],
          { session },
        );
      });
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException(
        'Platform password reset temporarily unavailable',
      );
    }
    return { reset: true };
  }
}
