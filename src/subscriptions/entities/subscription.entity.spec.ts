import { subscriptionPeriodSchema } from './subscription-period.entity';
import { subscriptionSchema } from './subscription.entity';

describe('subscription schema constraints', () => {
  it('allows only one subscription per company', () => {
    expect(subscriptionSchema.path('companyId').options).toMatchObject({
      required: true,
      unique: true,
      immutable: true,
    });
  });

  it('keeps activation dates immutable', () => {
    expect(subscriptionSchema.path('activatedAt').options).toMatchObject({
      required: true,
      immutable: true,
    });
  });

  it('uniquely indexes each company billing period', () => {
    expect(subscriptionPeriodSchema.indexes()).toContainEqual([
      { companyId: 1, startsAt: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });
});
