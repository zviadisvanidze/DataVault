import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
import { Types } from 'mongoose';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Role } from '../enums/roles.enum';
import { CompanyPlatformStatus } from '../companies/platform-status';
import {
  InvitationStatus,
  EmployeeInvitation,
} from './entities/employee-invitation.entity';
import {
  INVITATION_RESEND_COOLDOWN_MS,
  INVITATION_TOKEN_TTL_MS,
  InvitationsService,
  RESEND_INVITATION_RESPONSE,
} from './invitations.service';

const queryResult = <T>(value: T) => ({
  session: jest.fn().mockResolvedValue(value),
});

const paginatedResult = <T>(value: T) => ({
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue(value),
});

describe('InvitationsService', () => {
  const companyId = new Types.ObjectId();
  const otherCompanyId = new Types.ObjectId();
  const owner: AuthenticatedUser = {
    id: new Types.ObjectId().toString(),
    companyId: companyId.toString(),
    role: Role.COMPANY_OWNER,
  };
  const member = { ...owner, role: Role.COMPANY_MEMBER };
  const now = new Date('2026-04-01T10:00:00.000Z');
  const invitation = {
    _id: new Types.ObjectId(),
    companyId,
    invitedBy: new Types.ObjectId(owner.id),
    email: 'employee@example.com',
    status: InvitationStatus.PENDING,
    expiresAt: new Date(now.getTime() + INVITATION_TOKEN_TTL_MS),
    lastSentAt: now,
  } as EmployeeInvitation & { _id: Types.ObjectId };
  const invitationModel = {
    create: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateMany: jest.fn(),
    countDocuments: jest.fn(),
  };
  const companyModel = { findOne: jest.fn() };
  const userModel = { exists: jest.fn(), create: jest.fn() };
  const entitlements = { assertEmployeeCapacity: jest.fn() };
  const email = { sendEmployeeInvitation: jest.fn() };
  const session = {};
  const connection = {
    transaction: jest.fn((work: (session: object) => unknown) => work(session)),
  };
  const service = new InvitationsService(
    invitationModel as never,
    companyModel as never,
    userModel as never,
    entitlements as never,
    email as never,
    connection as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    invitationModel.create.mockResolvedValue([invitation]);
    invitationModel.updateMany.mockResolvedValue({ modifiedCount: 0 });
    companyModel.findOne.mockResolvedValue({ name: 'Acme' });
    userModel.exists.mockReturnValue(queryResult(false));
    userModel.create.mockResolvedValue([{}]);
    entitlements.assertEmployeeCapacity.mockResolvedValue(undefined);
    email.sendEmployeeInvitation.mockResolvedValue(undefined);
  });

  it('creates a company-bound member invitation and stores only a token hash', async () => {
    const response = await service.invite(
      owner,
      { email: 'employee@example.com' },
      now,
    );
    const createCalls = invitationModel.create.mock.calls as unknown as [
      [
        [
          {
            companyId: string;
            invitedBy: string;
            tokenHash: string;
            expiresAt: Date;
          },
        ],
      ],
    ];
    const input = createCalls[0][0][0];
    expect(input).toMatchObject({
      companyId: owner.companyId,
      invitedBy: owner.id,
    });
    expect(input.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(input.expiresAt).toEqual(
      new Date(now.getTime() + INVITATION_TOKEN_TTL_MS),
    );
    expect(entitlements.assertEmployeeCapacity).toHaveBeenCalledWith(
      owner.companyId,
      session,
      1,
      now,
    );
    const emailCalls = email.sendEmployeeInvitation.mock.calls as unknown as [
      [string, string, string],
    ];
    const deliveredToken = emailCalls[0][2];
    expect(deliveredToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(input.tokenHash).toBe(
      createHash('sha256').update(deliveredToken).digest('hex'),
    );
    expect(JSON.stringify(response)).not.toContain(input.tokenHash);
  });

  it('rejects members and duplicate account emails', async () => {
    await expect(
      service.invite(member, { email: invitation.email }, now),
    ).rejects.toBeInstanceOf(ForbiddenException);
    userModel.exists.mockReturnValue(queryResult(true));
    await expect(
      service.invite(owner, { email: invitation.email }, now),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(invitationModel.create).not.toHaveBeenCalled();
  });

  it('keeps a committed invitation recoverable after an email failure', async () => {
    email.sendEmployeeInvitation.mockRejectedValue(new Error('SMTP failed'));
    await expect(
      service.invite(owner, { email: invitation.email }, now),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(invitationModel.create).toHaveBeenCalled();
  });

  it('accepts a valid invitation with fixed company and member role', async () => {
    const rawToken = 'a'.repeat(43);
    invitationModel.findOne.mockResolvedValue(invitation);
    invitationModel.findOneAndUpdate.mockResolvedValue({
      ...invitation,
      status: InvitationStatus.ACCEPTED,
    });
    await service.accept(
      { token: rawToken, fullName: 'Employee', password: 'password' },
      now,
    );
    expect(invitationModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: createHash('sha256').update(rawToken).digest('hex'),
        status: InvitationStatus.PENDING,
      }),
      null,
      { session },
    );
    expect(entitlements.assertEmployeeCapacity).toHaveBeenCalledWith(
      companyId.toString(),
      session,
      0,
      now,
    );
    const userCreateCalls = userModel.create.mock.calls as unknown as [
      [
        [
          {
            email: string;
            fullName: string;
            password: string;
            companyId: Types.ObjectId;
            role: Role;
          },
        ],
      ],
    ];
    const created = userCreateCalls[0][0][0];
    expect(created).toMatchObject({
      email: invitation.email,
      fullName: 'Employee',
      companyId,
      role: Role.COMPANY_MEMBER,
    });
    expect(await bcrypt.compare('password', created.password)).toBe(true);
  });

  it('rejects invalid, expired, replayed, or concurrently claimed tokens', async () => {
    invitationModel.findOne.mockResolvedValueOnce(null);
    await expect(
      service.accept(
        { token: 'a'.repeat(43), fullName: 'Employee', password: 'password' },
        now,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    invitationModel.findOne.mockResolvedValue(invitation);
    invitationModel.findOneAndUpdate.mockResolvedValue(null);
    await expect(
      service.accept(
        { token: 'a'.repeat(43), fullName: 'Employee', password: 'password' },
        now,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userModel.create).not.toHaveBeenCalled();
  });

  it('maps acceptance email races to a generic conflict', async () => {
    invitationModel.findOne.mockResolvedValue(invitation);
    invitationModel.findOneAndUpdate.mockResolvedValue(invitation);
    userModel.create.mockRejectedValue({ code: 11000 });
    await expect(
      service.accept(
        { token: 'a'.repeat(43), fullName: 'Employee', password: 'password' },
        now,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects public acceptance for a suspended company without consuming the invitation or capacity', async () => {
    invitationModel.findOne.mockResolvedValue(invitation);
    companyModel.findOne.mockResolvedValue({
      platformStatus: CompanyPlatformStatus.SUSPENDED,
    });
    await expect(
      service.accept(
        { token: 'a'.repeat(43), fullName: 'Employee', password: 'password' },
        now,
      ),
    ).rejects.toThrow('Invitation is unavailable');
    expect(entitlements.assertEmployeeCapacity).not.toHaveBeenCalled();
    expect(invitationModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(userModel.create).not.toHaveBeenCalled();
  });

  it('lists only live pending invitations scoped to the owner company', async () => {
    const query = paginatedResult([invitation]);
    invitationModel.find.mockReturnValue(query);
    invitationModel.countDocuments.mockResolvedValue(1);
    await expect(
      service.findPending(owner, { page: 1, take: 50 }, now),
    ).resolves.toMatchObject({ total: 1, take: 30 });
    expect(invitationModel.find).toHaveBeenCalledWith({
      companyId: owner.companyId,
      status: InvitationStatus.PENDING,
      expiresAt: { $gt: now },
    });
  });

  it('revokes only a pending invitation in the owner company', async () => {
    invitationModel.findOneAndUpdate.mockResolvedValue(invitation);
    await service.revoke(owner, invitation._id.toString(), now);
    expect(invitationModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: invitation._id.toString(),
        companyId: owner.companyId,
        status: InvitationStatus.PENDING,
      }),
      expect.objectContaining({ $unset: { tokenHash: 1 } }),
      expect.any(Object),
    );
    invitationModel.findOneAndUpdate.mockResolvedValue(null);
    await expect(
      service.revoke(
        { ...owner, companyId: otherCompanyId.toString() },
        invitation._id.toString(),
        now,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resends generically while rotating the token after the cooldown', async () => {
    invitationModel.findOneAndUpdate.mockResolvedValue(invitation);
    await expect(
      service.resend(
        owner,
        invitation._id.toString(),
        new Date(now.getTime() + INVITATION_RESEND_COOLDOWN_MS),
      ),
    ).resolves.toEqual(RESEND_INVITATION_RESPONSE);
    const updateCalls = invitationModel.findOneAndUpdate.mock
      .calls as unknown as [[unknown, { $set: { tokenHash: string } }]];
    const update = updateCalls[0][1];
    const emailCalls = email.sendEmployeeInvitation.mock.calls as unknown as [
      [string, string, string],
    ];
    const deliveredToken = emailCalls[0][2];
    expect(update.$set.tokenHash).toBe(
      createHash('sha256').update(deliveredToken).digest('hex'),
    );

    jest.clearAllMocks();
    invitationModel.findOneAndUpdate.mockResolvedValue(null);
    await expect(
      service.resend(owner, invitation._id.toString(), now),
    ).resolves.toEqual(RESEND_INVITATION_RESPONSE);
    expect(email.sendEmployeeInvitation).not.toHaveBeenCalled();
  });
});
