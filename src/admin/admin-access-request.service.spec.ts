import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { AdminAccessRequestService } from './admin-access-request.service';
import { AdminAccessRequestStatus } from './entities/admin-access-request.entity';

describe('platform admin access requests', () => {
  type AsyncMock = Mock<(...args: unknown[]) => Promise<unknown>>;
  const asyncMock = () => jest.fn<(...args: unknown[]) => Promise<unknown>>();
  const requestId = new Types.ObjectId();
  const actorId = new Types.ObjectId().toString();
  const token = 'A'.repeat(43);
  let requests: {
    updateMany: AsyncMock;
    exists: AsyncMock;
    create: AsyncMock;
    findOneAndUpdate: AsyncMock;
    findOne: AsyncMock;
  };
  let admins: { exists: AsyncMock; find: Mock; create: AsyncMock };
  let audits: { create: AsyncMock };
  let email: { send: AsyncMock };
  let service: AdminAccessRequestService;

  beforeEach(() => {
    requests = {
      updateMany: asyncMock().mockResolvedValue({}),
      exists: asyncMock().mockResolvedValue(false),
      create: asyncMock().mockResolvedValue([{ _id: requestId }]),
      findOneAndUpdate: asyncMock(),
      findOne: asyncMock(),
    };
    admins = {
      exists: asyncMock().mockResolvedValue(false),
      find: jest.fn().mockReturnValue({
        select: () => ({ lean: () => Promise.resolve([]) }),
      }),
      create: asyncMock().mockResolvedValue([{ _id: new Types.ObjectId() }]),
    };
    audits = { create: asyncMock().mockResolvedValue([]) };
    email = { send: asyncMock().mockResolvedValue(undefined) };
    service = new AdminAccessRequestService(
      requests as never,
      admins as never,
      audits as never,
      {
        transaction: async (work: (session: object) => Promise<void>) =>
          work({}),
      } as never,
      { getOrThrow: () => 'https://datavault-saas.vercel.app' } as never,
      email as never,
    );
  });

  it('does not create an account when requesting access and responds generically for existing admins', async () => {
    const dto = { fullName: 'Alex Morgan', email: 'alex@example.com' };
    const result = await service.request(dto);
    expect(result.message).toMatch(/If the email/);
    expect(requests.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          status: AdminAccessRequestStatus.AWAITING_VERIFICATION,
        }),
      ],
      expect.any(Object),
    );
    expect(admins.create).not.toHaveBeenCalled();
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: dto.email,
        text: expect.stringContaining('#verify_admin_request='),
      }),
    );
    admins.exists.mockResolvedValueOnce({ _id: new Types.ObjectId() });
    expect(await service.request(dto)).toEqual(result);
    expect(requests.create).toHaveBeenCalledTimes(1);
  });

  it('consumes a valid verification token and rejects a replay', async () => {
    requests.findOneAndUpdate
      .mockResolvedValueOnce({ _id: requestId })
      .mockResolvedValueOnce(null);
    expect((await service.verify(token)).verified).toBe(true);
    expect(requests.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: AdminAccessRequestStatus.AWAITING_VERIFICATION,
        verificationExpiresAt: expect.objectContaining({
          $gt: expect.any(Date),
        }),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: AdminAccessRequestStatus.PENDING_REVIEW,
        }),
      }),
      expect.any(Object),
    );
    await expect(service.verify(token)).rejects.toThrow('invalid or expired');
  });

  it('requires a pending request before a decision and records the acting admin', async () => {
    requests.findOneAndUpdate.mockResolvedValueOnce({
      _id: requestId,
      email: 'alex@example.com',
      status: AdminAccessRequestStatus.APPROVED,
    });
    expect(
      (
        await service.decide(actorId, requestId.toString(), {
          decision: 'approve',
        })
      ).status,
    ).toBe(AdminAccessRequestStatus.APPROVED);
    expect(audits.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          action: 'admin_access_approved',
          actorId: new Types.ObjectId(actorId),
        }),
      ],
      expect.any(Object),
    );
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('#setup_admin='),
      }),
    );
    requests.findOneAndUpdate.mockResolvedValueOnce(null);
    await expect(
      service.decide(actorId, requestId.toString(), { decision: 'approve' }),
    ).rejects.toThrow('already been reviewed');
  });

  it('creates an admin only after a valid approved setup token and rejects reuse', async () => {
    requests.findOneAndUpdate
      .mockResolvedValueOnce({
        _id: requestId,
        email: 'alex@example.com',
        fullName: 'Alex Morgan',
      })
      .mockResolvedValueOnce(null);
    expect(
      (await service.setup({ token, newPassword: 'SecurePassword123!' }))
        .activated,
    ).toBe(true);
    expect(admins.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          email: 'alex@example.com',
          isActive: true,
          password: expect.any(String),
        }),
      ],
      expect.any(Object),
    );
    expect(requests.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: AdminAccessRequestStatus.APPROVED,
        setupExpiresAt: expect.objectContaining({ $gt: expect.any(Date) }),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: AdminAccessRequestStatus.ACTIVATED,
        }),
      }),
      expect.any(Object),
    );
    await expect(
      service.setup({ token, newPassword: 'SecurePassword123!' }),
    ).rejects.toThrow('invalid or expired');
  });

  it('keeps a rejected request rejected when email fails and permits a notification retry', async () => {
    requests.findOneAndUpdate.mockResolvedValueOnce({
      _id: requestId,
      email: 'alex@example.com',
      status: AdminAccessRequestStatus.REJECTED,
    });
    email.send.mockRejectedValueOnce(new Error('mail unavailable'));
    expect(
      await service.decide(actorId, requestId.toString(), {
        decision: 'reject',
      }),
    ).toEqual({
      status: AdminAccessRequestStatus.REJECTED,
      notificationDelivered: false,
    });
    requests.findOne.mockResolvedValueOnce({ email: 'alex@example.com' });
    expect(await service.resendRejection(requestId.toString())).toEqual({
      sent: true,
    });
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(admins.create).not.toHaveBeenCalled();
  });
});
