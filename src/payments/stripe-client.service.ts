import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from './payment.constants';

@Injectable()
export class StripeClientService {
  readonly enabled: boolean;
  private readonly client?: Stripe;

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>('STRIPE_ENABLED') === true;
    if (this.enabled) {
      this.client = new Stripe(config.getOrThrow<string>('STRIPE_SECRET_KEY'), {
        apiVersion: STRIPE_API_VERSION,
        maxNetworkRetries: 2,
        timeout: 10000,
        telemetry: false,
      });
    }
  }

  get api(): Stripe {
    if (!this.client)
      throw new ServiceUnavailableException(
        'Test Mode payments are not configured',
      );
    return this.client;
  }
}
