import * as bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import {
  ADMIN_PASSWORD_RESET_CONFIRMATION,
  AdminPasswordResetService,
  passwordResetArguments,
  passwordResetInput,
} from '../admin/admin-password-reset.service';
import { AdminAuditAction } from '../admin/entities/admin-audit.entity';
import { PLATFORM_ADMIN_BCRYPT_ROUNDS } from '../admin/admin-security';
import { CliFailureCategory } from './cli-errors';

const email = 'platform@fixture.test';
const password = 'New-Strong-Password42!';
const adminId = new Types.ObjectId();

function query(value: unknown) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

function sessionQuery(value: unknown) {
  const lean = jest.fn().mockResolvedValue(value);
  return {
    session: jest.fn().mockReturnValue({ lean }),
  };
}

function fixture() {
  const admins = {
    init: jest.fn().mockResolvedValue(undefined),
    findOne: jest
      .fn()
      .mockReturnValueOnce(query({ isActive: true }))
      .mockReturnValueOnce(sessionQuery({ _id: adminId, isActive: true })),
    updateOne: jest
      .fn()
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
  };
  const audits = {
    init: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue([]),
  };
  const session = { id: 'unit-session' };
  const connection = {
    transaction: jest.fn(
      async (work: (value: typeof session) => Promise<void>) => work(session),
    ),
  };
  const service = new AdminPasswordResetService(
    admins as never,
    audits as never,
    connection as never,
  );
  return { admins, audits, connection, session, service };
}

describe('platform-admin password-reset maintenance command', () => {
  it('requires the exact confirmation flag and matching hidden credentials', () => {
    expect(() => passwordResetArguments([])).toThrow(
      CliFailureCategory.INVALID_ADMIN_PASSWORD_RESET_CONFIGURATION,
    );
    expect(() =>
      passwordResetArguments([ADMIN_PASSWORD_RESET_CONFIRMATION, '--force']),
    ).toThrow(CliFailureCategory.INVALID_ADMIN_PASSWORD_RESET_CONFIGURATION);
    expect(() =>
      passwordResetArguments([ADMIN_PASSWORD_RESET_CONFIRMATION]),
    ).not.toThrow();
    expect(
      passwordResetInput(' PLATFORM@fixture.test ', password, password, email),
    ).toEqual({ email, password });
  });

  it.each([
    ['weak', 'weak', email],
    [password, 'different-password', email],
    [password, password, 'another@fixture.test'],
  ])(
    'rejects weak, mismatched, or incorrectly confirmed input',
    (first, repeated, confirmation) => {
      expect(() =>
        passwordResetInput(email, first, repeated, confirmation),
      ).toThrow(CliFailureCategory.INVALID_ADMIN_PASSWORD_RESET_CONFIGURATION);
    },
  );

  it.each([
    [null, CliFailureCategory.PLATFORM_ADMIN_NOT_FOUND],
    [{ isActive: false }, CliFailureCategory.PLATFORM_ADMIN_INACTIVE],
  ])(
    'refuses an unknown or inactive administrator before hashing or writing',
    async (existing, category) => {
      const f = fixture();
      f.admins.findOne.mockReset().mockReturnValue(query(existing));
      await expect(f.service.run({ email, password })).rejects.toThrow(
        category,
      );
      expect(f.connection.transaction).not.toHaveBeenCalled();
      expect(f.admins.updateOne).not.toHaveBeenCalled();
      expect(f.audits.create).not.toHaveBeenCalled();
    },
  );

  it('changes only the active administrator password and appends a secret-free audit event transactionally', async () => {
    const f = fixture();
    await expect(f.service.run({ email, password })).resolves.toEqual({
      reset: true,
    });
    expect(f.connection.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      },
    );
    const [filter, update, options] = f.admins.updateOne.mock.calls[0] as [
      Record<string, unknown>,
      { $set: { password: string } },
      Record<string, unknown>,
    ];
    expect(filter).toEqual({ _id: adminId, email, isActive: true });
    expect(Object.keys(update.$set)).toEqual(['password']);
    expect(update.$set.password).not.toBe(password);
    await expect(bcrypt.compare(password, update.$set.password)).resolves.toBe(
      true,
    );
    expect(options).toEqual({ session: f.session, timestamps: false });
    expect(f.audits.create).toHaveBeenCalledWith(
      [
        {
          action: AdminAuditAction.PASSWORD_RESET,
          actorId: adminId,
          targetId: adminId,
          targetType: 'platform_admin',
        },
      ],
      { session: f.session },
    );
    expect(JSON.stringify(f.audits.create.mock.calls)).not.toContain(password);
    expect(JSON.stringify(f.audits.create.mock.calls)).not.toContain(
      update.$set.password,
    );
    expect(PLATFORM_ADMIN_BCRYPT_ROUNDS).toBe(12);
  });

  it('fails closed and sanitizes index, query, race, and transaction failures', async () => {
    const index = fixture();
    index.admins.init.mockRejectedValue(new Error('private database details'));
    await expect(index.service.run({ email, password })).rejects.toThrow(
      CliFailureCategory.MONGO_INDEX,
    );

    const queryFailure = fixture();
    queryFailure.admins.findOne.mockReset().mockReturnValue({
      lean: jest.fn().mockRejectedValue(new Error('private Mongo URI')),
    });
    await expect(queryFailure.service.run({ email, password })).rejects.toThrow(
      CliFailureCategory.MONGO_QUERY,
    );

    const race = fixture();
    race.admins.updateOne.mockResolvedValue({
      matchedCount: 0,
      modifiedCount: 0,
    });
    await expect(race.service.run({ email, password })).rejects.toThrow(
      CliFailureCategory.PLATFORM_ADMIN_INACTIVE,
    );
    expect(race.audits.create).not.toHaveBeenCalled();

    const auditFailure = fixture();
    auditFailure.audits.create.mockRejectedValue(
      new Error('private password/hash/connection'),
    );
    await expect(auditFailure.service.run({ email, password })).rejects.toThrow(
      CliFailureCategory.MONGO_TRANSACTION,
    );
  });
});
