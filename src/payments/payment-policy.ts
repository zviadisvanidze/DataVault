import { ForbiddenException } from '@nestjs/common';
import { PlanCode } from '../plans/plan.constants';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { PaymentAccess, PaymentSyncIssue } from './payment.constants';

export function assertPaymentAccess(
  subscription: Subscription,
  enabled: boolean,
  now = new Date(),
) {
  if (subscription.planCode === PlanCode.FREE && !subscription.stripeManaged)
    return;
  if (!enabled && !subscription.stripeManaged) return;
  if (
    !enabled ||
    !subscription.stripeManaged ||
    subscription.paymentSyncIssue ===
      PaymentSyncIssue.RECONCILIATION_REQUIRED ||
    ![PaymentAccess.ACTIVE, PaymentAccess.DEFERRED].includes(
      subscription.paymentAccess,
    ) ||
    !subscription.stripeSyncedAt ||
    now.getTime() - subscription.stripeSyncedAt.getTime() > 24 * 60 * 60 * 1000
  ) {
    throw new ForbiddenException(
      'Company billing requires attention before new uploads or employee onboarding',
    );
  }
}
