import { ConfigService } from '@nestjs/config';
import {
  AdminBootstrapService,
  bootstrapCredentials,
} from '../admin/admin-bootstrap.service';
import { CliFailureCategory } from './cli-errors';

describe('sanitized platform bootstrap diagnostics', () => {
  const config = new ConfigService({
    PLATFORM_ADMIN_BOOTSTRAP_EMAIL: 'operator@fixture.test',
    PLATFORM_ADMIN_BOOTSTRAP_FULL_NAME: 'Test Operator',
    PLATFORM_ADMIN_BOOTSTRAP_PASSWORD: 'Strong-Password42!',
  });
  const admins = { init: jest.fn(), exists: jest.fn(), create: jest.fn() };
  const audits = { init: jest.fn(), create: jest.fn() };
  const connection = { transaction: jest.fn() };
  const service = new AdminBootstrapService(
    config,
    admins as never,
    audits as never,
    connection as never,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    admins.init.mockResolvedValue(undefined);
    audits.init.mockResolvedValue(undefined);
    admins.exists.mockResolvedValue(null);
  });
  it('validates configuration before any database dependency', () => {
    expect(() =>
      bootstrapCredentials(
        new ConfigService({
          PLATFORM_ADMIN_BOOTSTRAP_EMAIL: '',
          PLATFORM_ADMIN_BOOTSTRAP_PASSWORD: '',
        }),
      ),
    ).toThrow(CliFailureCategory.INVALID_BOOTSTRAP_CONFIGURATION);
  });
  it('classifies index failures without preserving the raw exception', async () => {
    admins.init.mockRejectedValueOnce(
      new Error(
        'mongodb+srv://private:password@host index email=private@example.test',
      ),
    );
    await expect(service.run()).rejects.toThrow(CliFailureCategory.MONGO_INDEX);
    expect(connection.transaction).not.toHaveBeenCalled();
  });
  it('classifies database query failures separately', async () => {
    admins.exists.mockRejectedValueOnce(
      new Error('raw connection credentials'),
    );
    await expect(service.run()).rejects.toThrow(CliFailureCategory.MONGO_QUERY);
  });
  it('classifies transaction failures separately', async () => {
    connection.transaction.mockRejectedValueOnce(
      new Error(
        'Transaction numbers are only allowed on a replica set; raw sensitive details',
      ),
    );
    await expect(service.run()).rejects.toThrow(
      CliFailureCategory.MONGO_TRANSACTION,
    );
  });
  it('retains duplicate bootstrap idempotency after a concurrent unique constraint', async () => {
    connection.transaction.mockRejectedValueOnce({
      code: 11000,
      message: 'private duplicate email',
    });
    admins.exists
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'already-existing' });
    await expect(service.run()).resolves.toEqual({ created: false });
  });
});
