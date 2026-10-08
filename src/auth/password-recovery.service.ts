import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'node:crypto';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { Company } from '../companies/entities/company.entity';
import { CompanyPlatformStatus } from '../companies/platform-status';
import { EmailSender } from '../email/email-sender';
import { User } from '../users/entities/user.entity';

const RESET_TTL_MS = 30 * 60_000;
const REQUEST_COOLDOWN_MS = 60_000;
export const RECOVERY_RESPONSE = {
  message:
    'If this email belongs to an active workspace, a reset link will arrive shortly.',
};

@Injectable()
export class PasswordRecoveryService {
  private readonly logger = new Logger(PasswordRecoveryService.name);

  constructor(
    @InjectModel('user') private readonly users: Model<User>,
    @InjectModel('company') private readonly companies: Model<Company>,
    private readonly config: ConfigService,
    private readonly email: EmailSender,
  ) {}

  async forgotPassword(email: string) {
    const user = await this.users.findOne({ email });
    if (!user || !(user.companyId instanceof Types.ObjectId))
      return RECOVERY_RESPONSE;

    const company = await this.companies.findOne({
      _id: user.companyId,
      activatedAt: { $ne: null },
      platformStatus: { $ne: CompanyPlatformStatus.SUSPENDED },
    });
    if (!company) return RECOVERY_RESPONSE;

    const now = new Date();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const updated = await this.users.findOneAndUpdate(
      {
        _id: user._id,
        companyId: user.companyId,
        $or: [
          { passwordResetRequestedAt: { $exists: false } },
          {
            passwordResetRequestedAt: {
              $lte: new Date(now.getTime() - REQUEST_COOLDOWN_MS),
            },
          },
        ],
      },
      {
        $set: {
          passwordResetTokenHash: tokenHash,
          passwordResetExpiresAt: new Date(now.getTime() + RESET_TTL_MS),
          passwordResetRequestedAt: now,
        },
      },
      { new: true },
    );
    if (!updated) return RECOVERY_RESPONSE;

    const link = new URL(
      '/reset-password',
      this.config.getOrThrow<string>('ACCOUNT_ACTIVATION_URL'),
    );
    link.hash = new URLSearchParams({ token }).toString();
    try {
      await this.email.send({
        to: updated.email,
        subject: 'Reset your DataVault password',
        text: [
          'Use this link to reset your DataVault workspace password:',
          '',
          link.toString(),
          '',
          'This link expires in 30 minutes and works once. If you did not request it, ignore this email.',
        ].join('\n'),
      });
    } catch {
      try {
        await this.users.updateOne(
          { _id: updated._id, passwordResetTokenHash: tokenHash },
          {
            $unset: {
              passwordResetTokenHash: '',
              passwordResetExpiresAt: '',
              passwordResetRequestedAt: '',
            },
          },
        );
      } catch {
        this.logger.warn('Workspace recovery token cleanup failed');
      }
      this.logger.warn('Workspace recovery email could not be sent');
    }
    return RECOVERY_RESPONSE;
  }

  async resetPassword(token: string, newPassword: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const user = await this.users.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() },
    });
    if (!user || !(user.companyId instanceof Types.ObjectId))
      throw new UnauthorizedException('Invalid or expired reset link');
    const company = await this.companies.findOne({
      _id: user.companyId,
      activatedAt: { $ne: null },
      platformStatus: { $ne: CompanyPlatformStatus.SUSPENDED },
    });
    if (!company)
      throw new UnauthorizedException('Invalid or expired reset link');

    const password = await bcrypt.hash(newPassword, 10);
    const changed = await this.users.findOneAndUpdate(
      {
        _id: user._id,
        companyId: user.companyId,
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { $gt: new Date() },
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
      { new: true },
    );
    if (!changed)
      throw new UnauthorizedException('Invalid or expired reset link');
    return { reset: true };
  }
}
