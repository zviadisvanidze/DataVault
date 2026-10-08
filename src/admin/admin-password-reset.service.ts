import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { isEmail } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import {
  PLATFORM_ADMIN_BCRYPT_ROUNDS,
  validPlatformAdminPassword,
} from './admin-security';
import { PlatformAdmin } from './entities/platform-admin.entity';
import { AdminAudit, AdminAuditAction } from './entities/admin-audit.entity';
import { CliFailure, CliFailureCategory } from '../maintenance/cli-errors';

export const ADMIN_PASSWORD_RESET_CONFIRMATION =
  '--confirm-platform-admin-password-reset';

export interface AdminPasswordResetInput {
  email: string;
  password: string;
}

export function passwordResetArguments(args: string[]) {
  if (args.length !== 1 || args[0] !== ADMIN_PASSWORD_RESET_CONFIRMATION)
    throw new CliFailure(
      CliFailureCategory.INVALID_ADMIN_PASSWORD_RESET_CONFIGURATION,
    );
}

export function passwordResetInput(
  emailValue: string,
  password: string,
  repeatedPassword: string,
  confirmationEmailValue: string,
): AdminPasswordResetInput {
  const email = emailValue.trim().toLowerCase();
  const confirmationEmail = confirmationEmailValue.trim().toLowerCase();
  if (
    !email ||
    email.length > 254 ||
    !isEmail(email) ||
    email !== confirmationEmail ||
    password !== repeatedPassword ||
    !validPlatformAdminPassword(password)
  )
    throw new CliFailure(
      CliFailureCategory.INVALID_ADMIN_PASSWORD_RESET_CONFIGURATION,
    );
  return { email, password };
}

@Injectable()
export class AdminPasswordResetService {
  constructor(
    @InjectModel('platformAdmin') private readonly admins: Model<PlatformAdmin>,
    @InjectModel('adminAudit') private readonly audits: Model<AdminAudit>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async run(input: AdminPasswordResetInput) {
    try {
      await Promise.all([this.admins.init(), this.audits.init()]);
    } catch {
      throw new CliFailure(CliFailureCategory.MONGO_INDEX);
    }

    let existing: Pick<PlatformAdmin, 'isActive'> | null;
    try {
      existing = await this.admins
        .findOne({ email: input.email }, { isActive: 1 })
        .lean();
    } catch {
      throw new CliFailure(CliFailureCategory.MONGO_QUERY);
    }
    if (!existing)
      throw new CliFailure(CliFailureCategory.PLATFORM_ADMIN_NOT_FOUND);
    if (!existing.isActive)
      throw new CliFailure(CliFailureCategory.PLATFORM_ADMIN_INACTIVE);

    let hash: string;
    try {
      hash = await bcrypt.hash(input.password, PLATFORM_ADMIN_BCRYPT_ROUNDS);
    } catch {
      throw new CliFailure(CliFailureCategory.PLATFORM_ADMIN_PASSWORD_HASH);
    }

    try {
      await this.connection.transaction(
        async (session) => {
          const admin = await this.admins
            .findOne({ email: input.email }, { _id: 1, isActive: 1 })
            .session(session)
            .lean();
          if (!admin)
            throw new CliFailure(CliFailureCategory.PLATFORM_ADMIN_NOT_FOUND);
          if (!admin.isActive)
            throw new CliFailure(CliFailureCategory.PLATFORM_ADMIN_INACTIVE);

          const changed = await this.admins.updateOne(
            { _id: admin._id, email: input.email, isActive: true },
            {
              $set: { password: hash },
              $inc: { authVersion: 1 },
              $unset: {
                passwordResetTokenHash: '',
                passwordResetExpiresAt: '',
                passwordResetRequestedAt: '',
              },
            },
            { session, timestamps: false },
          );
          if (changed.matchedCount !== 1 || changed.modifiedCount !== 1)
            throw new CliFailure(CliFailureCategory.PLATFORM_ADMIN_INACTIVE);

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
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      throw new CliFailure(CliFailureCategory.MONGO_TRANSACTION);
    }
    return { reset: true } as const;
  }
}
