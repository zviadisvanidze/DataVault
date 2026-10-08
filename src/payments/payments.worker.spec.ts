import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { PaymentsService } from './payments.service';
import { PaymentsWorker } from './payments.worker';
import { PaymentSyncIssue } from './payment.constants';

describe('durable Stripe reconciliation worker', () => {
  const tenant = {
    _id: new Types.ObjectId(),
    companyId: new Types.ObjectId(),
    stripeSyncedAt: new Date(0),
  };
  const payments = { enabled: true, reconcileCompany: jest.fn() };
  const model = { find: jest.fn(), updateOne: jest.fn() };
  const config = new ConfigService({
    NODE_ENV: 'test',
    STRIPE_SYNC_INTERVAL_MS: 30000,
  });
  const worker = new PaymentsWorker(
    payments as unknown as PaymentsService,
    config,
    model as never,
  );
  beforeEach(() => {
    jest.clearAllMocks();
    payments.enabled = true;
    model.find.mockReturnValue({
      sort: () => ({ limit: () => Promise.resolve([tenant]) }),
    });
    model.updateOne.mockResolvedValue({ matchedCount: 1 });
    payments.reconcileCompany.mockResolvedValue(undefined);
  });
  it('claims due tenants and reconciles using their stored tenant IDs', async () => {
    worker.onModuleInit(); // Tests never start background timers.
    await worker.tick();
    expect(payments.reconcileCompany).toHaveBeenCalledWith(
      tenant.companyId.toString(),
    );
    expect(model.updateOne).toHaveBeenNthCalledWith(1, expect.any(Object), {
      $set: { stripeNextSyncAt: expect.any(Date) as unknown },
    });
    await worker.onModuleDestroy();
  });
  it('preserves last successful sync and manual-review issues on retry failure', async () => {
    payments.reconcileCompany.mockRejectedValue(new Error('omitted'));
    await worker.tick();
    expect(model.updateOne).toHaveBeenLastCalledWith(
      {
        _id: tenant._id,
        paymentSyncIssue: { $ne: PaymentSyncIssue.RECONCILIATION_REQUIRED },
      },
      { $set: { paymentSyncIssue: PaymentSyncIssue.RETRY_REQUIRED } },
    );
  });
  it('skips another replica’s claim and disabled integration', async () => {
    model.updateOne.mockResolvedValue({ matchedCount: 0 });
    await worker.tick();
    expect(payments.reconcileCompany).not.toHaveBeenCalled();
    payments.enabled = false;
    await worker.tick();
    expect(model.find).toHaveBeenCalledTimes(1);
  });
  it('does not overlap ticks and waits for work during shutdown', async () => {
    let release!: () => void;
    payments.reconcileCompany.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = worker.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await worker.tick();
    expect(payments.reconcileCompany).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stop = worker.onModuleDestroy().then(() => {
      stopped = true;
    });
    expect(stopped).toBe(false);
    release();
    await first;
    await stop;
    expect(stopped).toBe(true);
  });
});
