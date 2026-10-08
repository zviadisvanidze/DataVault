import { ServiceUnavailableException } from '@nestjs/common';
import { ConnectionStates } from 'mongoose';
import { HealthService } from './health.service';

describe('HealthService', () => {
  it('reports readiness only after MongoDB responds to a ping', async () => {
    const ping = jest.fn().mockResolvedValue({ ok: 1 });
    const service = new HealthService({
      readyState: ConnectionStates.connected,
      db: { admin: () => ({ ping }) },
    } as never);

    await expect(service.readiness()).resolves.toEqual({
      status: 'ok',
      dependencies: { mongodb: 'up' },
    });
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('returns a sanitized unavailable response for disconnected or failed MongoDB', async () => {
    const disconnected = new HealthService({
      readyState: ConnectionStates.disconnected,
    } as never);
    await expect(disconnected.readiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    const failedPing = new HealthService({
      readyState: ConnectionStates.connected,
      db: {
        admin: () => ({
          ping: jest.fn().mockRejectedValue(new Error('secret')),
        }),
      },
    } as never);
    await expect(failedPing.readiness()).rejects.toMatchObject({
      response: {
        status: 'unavailable',
        dependencies: { mongodb: 'down' },
      },
    });
  });
});
