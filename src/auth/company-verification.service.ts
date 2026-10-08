import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'node:crypto';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { Company } from '../companies/entities/company.entity';
import { EmailService } from '../email/email.service';
import { Role } from '../enums/roles.enum';
import { User } from '../users/entities/user.entity';
import { isDuplicateKeyError } from '../users/database-errors';
import { CompanyVerification } from './entities/company-verification.entity';

export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;
export const RESEND_VERIFICATION_RESPONSE = {
  message:
    'If an inactive company account exists for that email, a verification message will be sent.',
};

export interface ActivationDelivery {
  email: string;
  companyName: string;
  token: string;
}

@Injectable()
export class CompanyVerificationService {
  private readonly logger = new Logger(CompanyVerificationService.name);

  constructor(
    @InjectModel('companyVerification')
    private readonly verificationModel: Model<CompanyVerification>,
    @InjectModel('company') private readonly companyModel: Model<Company>,
    @InjectModel('user') private readonly userModel: Model<User>,
    @InjectConnection() private readonly connection: Connection,
    private readonly emailService: EmailService,
  ) {}

  async createForRegistration(
    companyId: Types.ObjectId,
    ownerId: Types.ObjectId,
    email: string,
    companyName: string,
    session: ClientSession,
    now = new Date(),
  ): Promise<ActivationDelivery> {
    const token = this.generateToken();
    await this.verificationModel.create(
      [
        {
          companyId,
          ownerId,
          tokenHash: this.hashToken(token),
          expiresAt: new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS),
          lastSentAt: now,
        },
      ],
      { session },
    );
    return { email, companyName, token };
  }

  sendActivationEmail(delivery: ActivationDelivery) {
    return this.emailService.sendCompanyActivation(
      delivery.email,
      delivery.companyName,
      delivery.token,
    );
  }

  async verify(token: string, now = new Date()) {
    await this.connection.transaction(async (session) => {
      const verification = await this.verificationModel.findOneAndDelete(
        {
          tokenHash: this.hashToken(token),
          expiresAt: { $gt: now },
        },
        { session },
      );
      if (!verification) throw this.invalidToken();

      const owner = await this.userModel.findOne(
        {
          _id: verification.ownerId,
          companyId: verification.companyId,
          role: Role.COMPANY_OWNER,
        },
        null,
        { session },
      );
      if (!owner) throw this.invalidToken();

      const company = await this.companyModel.findOneAndUpdate(
        { _id: verification.companyId, activatedAt: null },
        { $set: { activatedAt: now } },
        { new: true, runValidators: true, session },
      );
      if (!company) throw this.invalidToken();
    });
    return { message: 'Account activated. You can now sign in.' };
  }

  async resend(email: string, now = new Date()) {
    let delivery: ActivationDelivery | null = null;
    try {
      delivery = await this.connection.transaction(async (session) => {
        const owner = await this.userModel.findOne(
          { email, role: Role.COMPANY_OWNER },
          null,
          { session },
        );
        if (!owner) return null;
        const company = await this.companyModel.findOne(
          { _id: owner.companyId, activatedAt: null },
          null,
          { session },
        );
        if (!company) return null;

        const token = this.generateToken();
        const verification = await this.verificationModel.findOneAndUpdate(
          {
            companyId: owner.companyId,
            $or: [
              {
                lastSentAt: {
                  $lte: new Date(
                    now.getTime() - VERIFICATION_RESEND_COOLDOWN_MS,
                  ),
                },
              },
              { lastSentAt: { $exists: false } },
            ],
          },
          {
            $set: {
              tokenHash: this.hashToken(token),
              expiresAt: new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS),
              lastSentAt: now,
            },
            $setOnInsert: {
              companyId: owner.companyId,
              ownerId: owner._id,
            },
          },
          { upsert: true, new: true, runValidators: true, session },
        );
        if (!verification) return null;
        return { email: owner.email, companyName: company.name, token };
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }

    if (delivery) {
      try {
        await this.sendActivationEmail(delivery);
      } catch {
        this.logger.warn('Activation email delivery failed');
      }
    }
    return RESEND_VERIFICATION_RESPONSE;
  }

  private generateToken() {
    return randomBytes(32).toString('base64url');
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private invalidToken() {
    return new BadRequestException('Verification token is invalid or expired');
  }
}
