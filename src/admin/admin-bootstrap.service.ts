import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { isEmail } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { isDuplicateKeyError } from '../users/database-errors';
import {
  PLATFORM_ADMIN_BCRYPT_ROUNDS,
  validBootstrapPassword,
} from './admin-security';
import { CliFailure, CliFailureCategory } from '../maintenance/cli-errors';
import { AdminAudit, AdminAuditAction } from './entities/admin-audit.entity';
import { PlatformAdmin } from './entities/platform-admin.entity';

export function bootstrapCredentials(config: ConfigService) {
  const email = config
    .get<string>('PLATFORM_ADMIN_BOOTSTRAP_EMAIL')
    ?.trim()
    .toLowerCase();
  const password = config.get<string>('PLATFORM_ADMIN_BOOTSTRAP_PASSWORD');
  const fullName = config
    .get<string>('PLATFORM_ADMIN_BOOTSTRAP_FULL_NAME')
    ?.trim();
  if (
    !email ||
    email.length > 254 ||
    !isEmail(email) ||
    !fullName ||
    fullName.length < 2 ||
    fullName.length > 100 ||
    !validBootstrapPassword(password)
  )
    throw new CliFailure(CliFailureCategory.INVALID_BOOTSTRAP_CONFIGURATION);
  return { email, password, fullName };
}

@Injectable()
export class AdminBootstrapService {
  constructor(
    private readonly config: ConfigService,
    @InjectModel('platformAdmin') private readonly admins: Model<PlatformAdmin>,
    @InjectModel('adminAudit') private readonly audits: Model<AdminAudit>,
    @InjectConnection() private readonly connection: Connection,
  ) {}
  async run() {
    const { email, password, fullName } = bootstrapCredentials(this.config);
    try {
      await Promise.all([this.admins.init(), this.audits.init()]);
    } catch {
      throw new CliFailure(CliFailureCategory.MONGO_INDEX);
    }
    try {
      if (await this.admins.exists({ email })) return { created: false };
    } catch {
      throw new CliFailure(CliFailureCategory.MONGO_QUERY);
    }
    const hash = await bcrypt.hash(password, PLATFORM_ADMIN_BCRYPT_ROUNDS);
    try {
      await this.connection.transaction(
        async (session) => {
          const [admin] = await this.admins.create(
            [{ email, fullName, password: hash, isActive: true }],
            { session },
          );
          await this.audits.create(
            [
              {
                action: AdminAuditAction.BOOTSTRAP_CREATED,
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
      if (isDuplicateKeyError(error)) {
        try {
          if (await this.admins.exists({ email })) return { created: false };
        } catch {
          throw new CliFailure(CliFailureCategory.MONGO_QUERY);
        }
      }
      throw new CliFailure(CliFailureCategory.MONGO_TRANSACTION);
    }
    return { created: true };
  }
}
