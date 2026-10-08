import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { Role } from '../enums/roles.enum';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { UsersService } from './users.service';

function paginatedQuery<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(value),
  };
}

describe('UsersService tenant boundaries', () => {
  const companyId = new Types.ObjectId().toString();
  const otherCompanyId = new Types.ObjectId().toString();
  const ownerId = new Types.ObjectId().toString();
  const memberId = new Types.ObjectId().toString();
  const otherUserId = new Types.ObjectId().toString();
  const owner: AuthenticatedUser = {
    id: ownerId,
    companyId,
    role: Role.COMPANY_OWNER,
  };
  const member: AuthenticatedUser = {
    id: memberId,
    companyId,
    role: Role.COMPANY_MEMBER,
  };
  const memberDocument = {
    _id: new Types.ObjectId(memberId),
    companyId: new Types.ObjectId(companyId),
    role: Role.COMPANY_MEMBER,
  };
  const model = {
    find: jest.fn(),
    countDocuments: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findOneAndDelete: jest.fn(),
  };
  const service = new UsersService(model as never);

  beforeEach(() => jest.resetAllMocks());

  it('scopes lists and counts to the authenticated company', async () => {
    const query = paginatedQuery([memberDocument]);
    model.find.mockReturnValue(query);
    model.countDocuments.mockResolvedValue(1);
    await expect(
      service.findAll(owner, { page: 2, take: 10 }),
    ).resolves.toMatchObject({
      total: 1,
      page: 2,
      take: 10,
    });
    expect(model.find).toHaveBeenCalledWith({ companyId });
    expect(model.countDocuments).toHaveBeenCalledWith({ companyId });
    expect(query.skip).toHaveBeenCalledWith(10);
    expect(query.limit).toHaveBeenCalledWith(10);
  });

  it('returns not found when an owner targets a user outside the company', async () => {
    model.findOne.mockResolvedValue(null);
    await expect(service.findOne(owner, otherUserId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(model.findOne).toHaveBeenCalledWith({
      _id: otherUserId,
      companyId,
    });
    expect(otherCompanyId).not.toBe(companyId);
  });

  it('cannot update a user outside the owner company', async () => {
    model.findOne.mockResolvedValue(null);
    await expect(
      service.updateUser(owner, otherUserId, { fullName: 'Changed' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('prevents a member from reading another user', async () => {
    await expect(service.findOne(member, otherUserId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(model.findOne).not.toHaveBeenCalled();
  });

  it('limits generic profile updates to the display name', async () => {
    model.findOne.mockResolvedValue(memberDocument);
    model.findOneAndUpdate.mockResolvedValue(memberDocument);
    await service.updateUser(owner, memberId, { fullName: 'Updated Member' });
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: memberId, companyId },
      { fullName: 'Updated Member' },
      { new: true, runValidators: true },
    );
  });

  it.each([
    ['company owner', owner],
    ['company member', member],
  ])(
    'requires the existing password and securely replaces it for a %s',
    async (_label, actor) => {
      const currentHash = await bcrypt.hash('current-password', 10);
      model.findOne.mockReturnValue({
        select: jest.fn().mockResolvedValue({
          ...memberDocument,
          _id: new Types.ObjectId(actor.id),
          password: currentHash,
        }),
      });
      model.findOneAndUpdate.mockResolvedValue(memberDocument);

      await expect(
        service.changePassword(actor, {
          currentPassword: 'current-password',
          newPassword: 'replacement-password',
        }),
      ).resolves.toEqual({ message: 'Password changed successfully' });

      const [filter, update] = model.findOneAndUpdate.mock.calls[0] as [
        Record<string, unknown>,
        { $set: { password: string } },
      ];
      expect(filter).toEqual({
        _id: actor.id,
        companyId: actor.companyId,
        password: currentHash,
      });
      expect(update.$set.password).not.toBe('replacement-password');
      expect(
        await bcrypt.compare('replacement-password', update.$set.password),
      ).toBe(true);
    },
  );

  it('rejects an incorrect current password without changing anything', async () => {
    const currentHash = await bcrypt.hash('current-password', 10);
    model.findOne.mockReturnValue({
      select: jest.fn().mockResolvedValue({ password: currentHash }),
    });

    await expect(
      service.changePassword(member, {
        currentPassword: 'incorrect-password',
        newPassword: 'replacement-password',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects reusing the current password', async () => {
    const currentHash = await bcrypt.hash('current-password', 10);
    model.findOne.mockReturnValue({
      select: jest.fn().mockResolvedValue({ password: currentHash }),
    });

    await expect(
      service.changePassword(member, {
        currentPassword: 'current-password',
        newPassword: 'current-password',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('fails safely when a concurrent password change wins', async () => {
    const currentHash = await bcrypt.hash('current-password', 10);
    model.findOne.mockReturnValue({
      select: jest.fn().mockResolvedValue({ password: currentHash }),
    });
    model.findOneAndUpdate.mockResolvedValue(null);

    await expect(
      service.changePassword(member, {
        currentPassword: 'current-password',
        newPassword: 'replacement-password',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not allow the company owner to be deleted', async () => {
    model.findOne.mockResolvedValue({
      ...memberDocument,
      role: Role.COMPANY_OWNER,
    });
    await expect(service.deleteUser(owner, ownerId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(model.findOneAndDelete).not.toHaveBeenCalled();
  });

  it('allows only an owner to delete a company member', async () => {
    model.findOne.mockResolvedValue(memberDocument);
    model.findOneAndDelete.mockResolvedValue(memberDocument);
    await expect(service.deleteUser(member, memberId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(model.findOneAndDelete).not.toHaveBeenCalled();

    await expect(service.deleteUser(owner, memberId)).resolves.toBe(
      memberDocument,
    );
    expect(model.findOneAndDelete).toHaveBeenCalledWith({
      _id: memberId,
      companyId,
      role: Role.COMPANY_MEMBER,
    });
  });

  it('serializes Stripe-mode employee deletion even while billing is suspended', async () => {
    const session = {};
    const subscriptions = {
      paymentsEnabled: true,
      acquireLock: jest.fn().mockResolvedValue({ paymentAccess: 'suspended' }),
    };
    const connection = {
      transaction: jest.fn((work: (value: object) => Promise<unknown>) =>
        work(session),
      ),
    };
    const managedService = new UsersService(
      model as never,
      subscriptions as never,
      connection as never,
    );
    model.findOne.mockResolvedValue(memberDocument);
    model.findOneAndDelete.mockResolvedValue(memberDocument);
    await managedService.deleteUser(owner, memberId);
    expect(subscriptions.acquireLock).toHaveBeenCalledWith(companyId, session);
    expect(model.findOneAndDelete).toHaveBeenCalledWith(
      { _id: memberId, companyId, role: Role.COMPANY_MEMBER },
      { session },
    );
  });
});
