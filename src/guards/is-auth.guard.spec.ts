import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import { Role } from '../enums/roles.enum';
import { IsAuthGuard } from './is-auth.guard';

describe('tenant JWT version after password recovery', () => {
  it('rejects an old token and accepts a freshly issued one', async () => {
    const userId = new Types.ObjectId();
    const companyId = new Types.ObjectId();
    const user = {
      _id: userId,
      companyId,
      role: Role.COMPANY_OWNER,
      authVersion: 1,
    };
    const jwt = {
      verifyAsync: jest
        .fn()
        .mockResolvedValue({ id: userId.toString(), version: 0 }),
    };
    const users = { findById: jest.fn().mockResolvedValue(user) };
    const companies = {
      findOne: jest
        .fn()
        .mockResolvedValue({ _id: companyId, activatedAt: new Date() }),
    };
    const guard = new IsAuthGuard(
      jwt as unknown as JwtService,
      users as never,
      companies as never,
    );
    const request: { headers: { authorization: string }; auth?: unknown } = {
      headers: { authorization: 'Bearer synthetic-jwt' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
    jwt.verifyAsync.mockResolvedValue({ id: userId.toString(), version: 1 });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.auth).toEqual({
      id: userId.toString(),
      companyId: companyId.toString(),
      role: Role.COMPANY_OWNER,
    });
  });
});
