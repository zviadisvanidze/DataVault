import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { ClientSession, Connection, Model } from 'mongoose';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Company } from '../companies/entities/company.entity';
import { CompanyPlatformStatus } from '../companies/platform-status';
import { EmailService } from '../email/email.service';
import { Role } from '../enums/roles.enum';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { isDuplicateKeyError } from '../users/database-errors';
import { QueryParams } from '../users/dto/query-params.dto';
import { User } from '../users/entities/user.entity';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { InviteEmployeeDto } from './dto/invite-employee.dto';
import {
  EmployeeInvitation,
  InvitationStatus,
} from './entities/employee-invitation.entity';

export const INVITATION_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
export const INVITATION_RESEND_COOLDOWN_MS = 60 * 1000;
export const RESEND_INVITATION_RESPONSE = {
  message:
    'If a pending invitation can be resent, a new invitation email will be sent.',
};

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    @InjectModel('employeeInvitation')
    private readonly invitationModel: Model<EmployeeInvitation>,
    @InjectModel('company') private readonly companyModel: Model<Company>,
    @InjectModel('user') private readonly userModel: Model<User>,
    private readonly entitlementsService: EntitlementsService,
    private readonly emailService: EmailService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async invite(
    actor: AuthenticatedUser,
    dto: InviteEmployeeDto,
    now = new Date(),
  ) {
    this.requireOwner(actor);
    const token = this.generateToken();
    const tokenHash = this.hashToken(token);

    try {
      const result = await this.connection.transaction(async (session) => {
        await this.entitlementsService.assertEmployeeCapacity(
          actor.companyId,
          session,
          1,
          now,
        );
        if (await this.userModel.exists({ email: dto.email }).session(session))
          throw new ConflictException('Email is unavailable');

        await this.expireStaleInvitation(dto.email, now, session);
        const company = await this.companyModel.findOne(
          { _id: actor.companyId, activatedAt: { $ne: null } },
          null,
          { session },
        );
        if (
          !company ||
          company.platformStatus === CompanyPlatformStatus.SUSPENDED
        )
          throw new ForbiddenException('An activated company is required');

        const [invitation] = await this.invitationModel.create(
          [
            {
              companyId: actor.companyId,
              invitedBy: actor.id,
              email: dto.email,
              status: InvitationStatus.PENDING,
              tokenHash,
              expiresAt: new Date(now.getTime() + INVITATION_TOKEN_TTL_MS),
              lastSentAt: now,
            },
          ],
          { session },
        );
        return { invitation, companyName: company.name };
      });

      try {
        await this.emailService.sendEmployeeInvitation(
          dto.email,
          result.companyName,
          token,
        );
      } catch {
        throw new ServiceUnavailableException(
          'The invitation was created but its email could not be sent. Resend it later.',
        );
      }

      return {
        message: 'Invitation created. The employee has been emailed.',
        invitation: this.publicInvitation(result.invitation),
      };
    } catch (error) {
      if (isDuplicateKeyError(error))
        throw new ConflictException('Email is unavailable');
      throw error;
    }
  }

  async findPending(
    actor: AuthenticatedUser,
    { page, take }: QueryParams,
    now = new Date(),
  ) {
    this.requireOwner(actor);
    take = Math.min(take, 30);
    const filter = {
      companyId: actor.companyId,
      status: InvitationStatus.PENDING,
      expiresAt: { $gt: now },
    };
    const [invitations, total] = await Promise.all([
      this.invitationModel
        .find(filter)
        .select('-tokenHash')
        .sort({ _id: -1 })
        .skip((page - 1) * take)
        .limit(take),
      this.invitationModel.countDocuments(filter),
    ]);
    return {
      invitations: invitations.map((invitation) =>
        this.publicInvitation(invitation),
      ),
      total,
      page,
      take,
    };
  }

  async revoke(
    actor: AuthenticatedUser,
    invitationId: string,
    now = new Date(),
  ) {
    this.requireOwner(actor);
    const invitation = await this.invitationModel.findOneAndUpdate(
      {
        _id: invitationId,
        companyId: actor.companyId,
        status: InvitationStatus.PENDING,
      },
      {
        $set: { status: InvitationStatus.REVOKED, revokedAt: now },
        $unset: { tokenHash: 1 },
      },
      { new: true, runValidators: true },
    );
    if (!invitation) throw new NotFoundException('Invitation not found');
    return { message: 'Invitation revoked.' };
  }

  async resend(
    actor: AuthenticatedUser,
    invitationId: string,
    now = new Date(),
  ) {
    this.requireOwner(actor);
    const token = this.generateToken();
    const tokenHash = this.hashToken(token);
    const delivery = await this.connection.transaction(async (session) => {
      const invitation = await this.invitationModel.findOneAndUpdate(
        {
          _id: invitationId,
          companyId: actor.companyId,
          status: InvitationStatus.PENDING,
          expiresAt: { $gt: now },
          lastSentAt: {
            $lte: new Date(now.getTime() - INVITATION_RESEND_COOLDOWN_MS),
          },
        },
        {
          $set: {
            tokenHash,
            expiresAt: new Date(now.getTime() + INVITATION_TOKEN_TTL_MS),
            lastSentAt: now,
          },
        },
        { new: true, runValidators: true, session },
      );
      if (!invitation) return null;
      const company = await this.companyModel.findOne(
        { _id: actor.companyId, activatedAt: { $ne: null } },
        null,
        { session },
      );
      if (!company) return null;
      return { email: invitation.email, companyName: company.name };
    });

    if (delivery) {
      try {
        await this.emailService.sendEmployeeInvitation(
          delivery.email,
          delivery.companyName,
          token,
        );
      } catch {
        this.logger.warn('An employee invitation email could not be resent');
      }
    }
    return RESEND_INVITATION_RESPONSE;
  }

  async accept(dto: AcceptInvitationDto, now = new Date()) {
    const password = await bcrypt.hash(dto.password, 10);
    const tokenHash = this.hashToken(dto.token);

    try {
      await this.connection.transaction(async (session) => {
        const invitation = await this.invitationModel.findOne(
          {
            tokenHash,
            status: InvitationStatus.PENDING,
            expiresAt: { $gt: now },
          },
          null,
          { session },
        );
        if (!invitation)
          throw new BadRequestException('Invitation is invalid or expired');

        const company = await this.companyModel.findOne(
          { _id: invitation.companyId, activatedAt: { $ne: null } },
          null,
          { session },
        );
        if (
          !company ||
          company.platformStatus === CompanyPlatformStatus.SUSPENDED
        )
          throw new BadRequestException('Invitation is unavailable');

        await this.entitlementsService.assertEmployeeCapacity(
          invitation.companyId.toString(),
          session,
          0,
          now,
        );
        if (
          await this.userModel
            .exists({ email: invitation.email })
            .session(session)
        )
          throw new ConflictException('Unable to accept invitation');

        const accepted = await this.invitationModel.findOneAndUpdate(
          {
            _id: invitation._id,
            companyId: invitation.companyId,
            tokenHash,
            status: InvitationStatus.PENDING,
            expiresAt: { $gt: now },
          },
          {
            $set: { status: InvitationStatus.ACCEPTED, acceptedAt: now },
            $unset: { tokenHash: 1 },
          },
          { new: true, runValidators: true, session },
        );
        if (!accepted)
          throw new BadRequestException('Invitation is invalid or expired');

        await this.userModel.create(
          [
            {
              email: invitation.email,
              fullName: dto.fullName,
              password,
              companyId: invitation.companyId,
              role: Role.COMPANY_MEMBER,
            },
          ],
          { session },
        );
      });
    } catch (error) {
      if (isDuplicateKeyError(error))
        throw new ConflictException('Unable to accept invitation');
      throw error;
    }

    return { message: 'Invitation accepted. You can now sign in.' };
  }

  private async expireStaleInvitation(
    email: string,
    now: Date,
    session: ClientSession,
  ) {
    await this.invitationModel.updateMany(
      {
        email,
        status: InvitationStatus.PENDING,
        expiresAt: { $lte: now },
      },
      {
        $set: { status: InvitationStatus.EXPIRED },
        $unset: { tokenHash: 1 },
      },
      { session },
    );
  }

  private generateToken() {
    return randomBytes(32).toString('base64url');
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private publicInvitation(invitation: EmployeeInvitation & { _id?: unknown }) {
    return {
      id: invitation._id,
      email: invitation.email,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      lastSentAt: invitation.lastSentAt,
    };
  }

  private requireOwner(actor: AuthenticatedUser) {
    if (actor.role !== Role.COMPANY_OWNER)
      throw new ForbiddenException('Company owner access is required');
  }
}
