import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import { EmailMessage } from '../email/email-sender';
import {
  PasswordRecoveryService,
  RECOVERY_RESPONSE,
} from './password-recovery.service';

interface RecoveryUser {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  email: string;
  password: string;
  authVersion: number;
  passwordResetTokenHash?: string;
  passwordResetExpiresAt?: Date;
  passwordResetRequestedAt?: Date;
}
interface RecoveryFilter {
  email?: string;
  _id?: Types.ObjectId;
  passwordResetTokenHash?: string;
  passwordResetExpiresAt?: { $gt: Date };
  $or?: [
    { passwordResetRequestedAt: { $exists: boolean } },
    { passwordResetRequestedAt: { $lte: Date } },
  ];
}
interface RecoveryUpdate {
  $set?: Partial<RecoveryUser>;
  $inc?: { authVersion: number };
  $unset?: Record<string, string>;
}

describe('workspace password recovery', () => {
  const companyId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  let user: RecoveryUser;
  let active: boolean;
  let sent: EmailMessage[];
  let service: PasswordRecoveryService;
  let sender: { send: jest.Mock<Promise<void>, [EmailMessage]> };

  beforeEach(() => {
    active = true;
    sent = [];
    user = {
      _id: userId,
      companyId,
      email: 'owner@example.com',
      password: 'old-hash',
      authVersion: 0,
    };
    const users = {
      findOne: jest.fn((filter: RecoveryFilter) => {
        if (filter.email) return filter.email === user.email ? user : null;
        return user.passwordResetTokenHash === filter.passwordResetTokenHash &&
          user.passwordResetExpiresAt &&
          filter.passwordResetExpiresAt &&
          user.passwordResetExpiresAt > filter.passwordResetExpiresAt.$gt
          ? user
          : null;
      }),
      findOneAndUpdate: jest.fn(
        (filter: RecoveryFilter, update: RecoveryUpdate) => {
          if (filter._id !== userId) return null;
          if (
            filter.passwordResetTokenHash &&
            (user.passwordResetTokenHash !== filter.passwordResetTokenHash ||
              !user.passwordResetExpiresAt ||
              !filter.passwordResetExpiresAt ||
              user.passwordResetExpiresAt <= filter.passwordResetExpiresAt.$gt)
          )
            return null;
          if (
            filter.$or &&
            user.passwordResetRequestedAt &&
            user.passwordResetRequestedAt >
              filter.$or[1].passwordResetRequestedAt.$lte
          )
            return null;
          if (update.$set) Object.assign(user, update.$set);
          if (update.$inc) user.authVersion += update.$inc.authVersion;
          if (update.$unset) {
            delete user.passwordResetTokenHash;
            delete user.passwordResetExpiresAt;
            delete user.passwordResetRequestedAt;
          }
          return user;
        },
      ),
      updateOne: jest.fn(() => {
        delete user.passwordResetTokenHash;
        delete user.passwordResetExpiresAt;
        delete user.passwordResetRequestedAt;
        return { modifiedCount: 1 };
      }),
    };
    const companies = {
      findOne: jest.fn(() => (active ? { _id: companyId } : null)),
    };
    sender = {
      send: jest.fn<Promise<void>, [EmailMessage]>((message) => {
        sent.push(message);
        return Promise.resolve();
      }),
    };
    const config = {
      getOrThrow: jest.fn(() => 'https://datavault.example/activate'),
    };
    service = new PasswordRecoveryService(
      users as never,
      companies as never,
      config as unknown as ConfigService,
      sender,
    );
  });

  it('sends a short-lived single-use link without exposing the account or token in the response', async () => {
    expect(await service.forgotPassword('owner@example.com')).toEqual(
      RECOVERY_RESPONSE,
    );
    expect(sent).toHaveLength(1);
    const link = sent[0].text.match(/https:\/\/[^\s]+/)?.[0];
    expect(link).toBeDefined();
    const url = new URL(link!);
    expect(url.pathname).toBe('/reset-password');
    expect(url.search).toBe('');
    const token = new URLSearchParams(url.hash.slice(1)).get('token')!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(user.passwordResetTokenHash).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
    expect(user.passwordResetExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(await service.forgotPassword('owner@example.com')).toEqual(
      RECOVERY_RESPONSE,
    );
    expect(sent).toHaveLength(1);
    expect(await service.resetPassword(token, 'newPassword123')).toEqual({
      reset: true,
    });
    expect(await bcrypt.compare('newPassword123', user.password)).toBe(true);
    expect(user.authVersion).toBe(1);
    await expect(
      service.resetPassword(token, 'anotherPassword123'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('returns the same result for unknown and inactive accounts', async () => {
    expect(await service.forgotPassword('missing@example.com')).toEqual(
      RECOVERY_RESPONSE,
    );
    active = false;
    expect(await service.forgotPassword('owner@example.com')).toEqual(
      RECOVERY_RESPONSE,
    );
    expect(sent).toHaveLength(0);
  });

  it('rejects expired links and clears a token when email delivery fails', async () => {
    sender.send.mockRejectedValueOnce(new Error('mail unavailable'));
    expect(await service.forgotPassword('owner@example.com')).toEqual(
      RECOVERY_RESPONSE,
    );
    expect(user.passwordResetTokenHash).toBeUndefined();
    expect(user.passwordResetRequestedAt).toBeUndefined();
    await service.forgotPassword('owner@example.com');
    const token = new URLSearchParams(
      new URL(sent[0].text.match(/https:\/\/[^\s]+/)![0]).hash.slice(1),
    ).get('token')!;
    user.passwordResetExpiresAt = new Date(Date.now() - 1);
    await expect(
      service.resetPassword(token, 'newPassword123'),
    ).rejects.toThrow(UnauthorizedException);
  });
});
