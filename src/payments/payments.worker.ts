import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { PaymentSyncIssue } from './payment.constants';
import { PaymentsService } from './payments.service';

@Injectable()
export class PaymentsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly payments: PaymentsService,
    private readonly config: ConfigService,
    @InjectModel('subscription')
    private readonly subscriptions: Model<Subscription>,
  ) {}

  onModuleInit() {
    if (
      !this.payments.enabled ||
      this.config.get<string>('NODE_ENV') === 'test'
    )
      return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.getOrThrow<number>('STRIPE_SYNC_INTERVAL_MS'));
    this.timer.unref();
    void this.tick();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async tick() {
    if (this.running || !this.payments.enabled) return;
    this.running = this.run();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async run() {
    try {
      const now = new Date();
      const tenants = await this.subscriptions
        .find({
          $and: [
            {
              $or: [
                { stripeManaged: true },
                { stripeCheckoutSessionId: { $exists: true } },
              ],
            },
            {
              $or: [
                { stripeNextSyncAt: { $lte: now } },
                { stripeNextSyncAt: { $exists: false } },
              ],
            },
          ],
        })
        .sort({ stripeNextSyncAt: 1 })
        .limit(20);
      for (const tenant of tenants) {
        // Advance even on failure so a broken tenant cannot starve the queue.
        const claimed = await this.subscriptions.updateOne(
          {
            _id: tenant._id,
            $or: [
              { stripeNextSyncAt: { $lte: now } },
              { stripeNextSyncAt: { $exists: false } },
            ],
          },
          {
            $set: {
              stripeNextSyncAt: new Date(
                Date.now() +
                  this.config.getOrThrow<number>('STRIPE_SYNC_INTERVAL_MS'),
              ),
            },
          },
        );
        if (!claimed.matchedCount) continue;
        try {
          await this.payments.reconcileCompany(tenant.companyId.toString());
        } catch {
          await this.subscriptions.updateOne(
            {
              _id: tenant._id,
              paymentSyncIssue: {
                $ne: PaymentSyncIssue.RECONCILIATION_REQUIRED,
              },
            },
            { $set: { paymentSyncIssue: PaymentSyncIssue.RETRY_REQUIRED } },
          );
          this.logger.warn(
            'Stripe company reconciliation failed; retry required',
          );
        }
      }
    } catch {
      this.logger.warn(
        'Stripe reconciliation worker unavailable; retry required',
      );
    }
  }
}
