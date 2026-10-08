import { ConfigService } from '@nestjs/config';
import { StripeClientService } from './stripe-client.service';
import { stripeEventSchema } from './entities/stripe-event.entity';
import { stripeUsageSchema } from './entities/stripe-usage.entity';
import { subscriptionSchema } from '../subscriptions/entities/subscription.entity';

describe('Stripe configuration and schema safeguards', () => {
  it('never instantiates a usable client when disabled', () => {
    const client = new StripeClientService(
      new ConfigService({ STRIPE_ENABLED: false }),
    );
    expect(client.enabled).toBe(false);
    expect(() => client.api).toThrow('not configured');
  });
  it('constructs the pinned test client without network access', () => {
    const client = new StripeClientService(
      new ConfigService({
        STRIPE_ENABLED: true,
        STRIPE_SECRET_KEY: 'sk_test_fixture',
      }),
    );
    expect(client.enabled).toBe(true);
    expect(client.api.webhooks).toBeDefined();
  });
  it('defines durable unique event/usage identifiers and true ObjectId tenant paths', () => {
    expect(stripeEventSchema.path('eventId').options.unique).toBe(true);
    expect(stripeUsageSchema.path('identifier').options.unique).toBe(true);
    expect(stripeEventSchema.path('companyId').instance).toBe('ObjectId');
    expect(stripeUsageSchema.path('companyId').instance).toBe('ObjectId');
    expect(
      stripeEventSchema
        .indexes()
        .some(([, options]) => options.expireAfterSeconds !== undefined),
    ).toBe(false);
    expect(subscriptionSchema.path('stripeLeaseToken').options.select).toBe(
      false,
    );
    expect(subscriptionSchema.indexes()).toContainEqual([
      { stripeSubscriptionId: 1 },
      expect.objectContaining({
        unique: true,
        partialFilterExpression: { stripeSubscriptionId: { $type: 'string' } },
      }),
    ]);
  });
});
