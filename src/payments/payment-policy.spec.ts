import { PlanCode } from '../plans/plan.constants';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { assertPaymentAccess } from './payment-policy';
import { PaymentAccess } from './payment.constants';

describe('payment entitlement policy', () => {
  const sub = (fields: Partial<Subscription>) =>
    ({
      planCode: PlanCode.FREE,
      stripeManaged: false,
      ...fields,
    }) as Subscription;
  it('preserves Free and disabled assignment mode', () => {
    expect(() => assertPaymentAccess(sub({}), true)).not.toThrow();
    expect(() =>
      assertPaymentAccess(sub({ planCode: PlanCode.PREMIUM }), false),
    ).not.toThrow();
  });
  it('does not grandfather unmanaged paid entitlements when Stripe is enabled', () => {
    expect(() =>
      assertPaymentAccess(sub({ planCode: PlanCode.PREMIUM }), true),
    ).toThrow();
  });
  it.each([PaymentAccess.ACTIVE, PaymentAccess.DEFERRED])(
    'permits freshly confirmed %s access',
    (paymentAccess) => {
      expect(() =>
        assertPaymentAccess(
          sub({
            planCode: PlanCode.PREMIUM,
            stripeManaged: true,
            stripeSyncedAt: new Date(),
            paymentAccess,
          }),
          true,
        ),
      ).not.toThrow();
    },
  );
  it('fails closed for disabled integration, stale state, or suspended companies', () => {
    const s = sub({
      planCode: PlanCode.BASIC,
      stripeManaged: true,
      stripeSyncedAt: new Date(),
      paymentAccess: PaymentAccess.ACTIVE,
    });
    expect(() => assertPaymentAccess(s, false)).toThrow();
    expect(() =>
      assertPaymentAccess(
        { ...s, stripeSyncedAt: new Date(Date.now() - 25 * 3600000) },
        true,
      ),
    ).toThrow();
    expect(() =>
      assertPaymentAccess(
        { ...s, paymentAccess: PaymentAccess.SUSPENDED },
        true,
      ),
    ).toThrow();
  });
});
