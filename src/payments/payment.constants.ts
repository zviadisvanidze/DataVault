export enum PaymentAccess {
  UNMANAGED = 'unmanaged',
  DEFERRED = 'deferred',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

export enum PaymentSyncIssue {
  NONE = 'none',
  RETRY_REQUIRED = 'retry_required',
  RECONCILIATION_REQUIRED = 'reconciliation_required',
  PLAN_CONFLICT = 'plan_conflict',
}

export enum UsageDeliveryState {
  PENDING = 'pending',
  SUBMITTED = 'submitted',
  RECONCILIATION_REQUIRED = 'reconciliation_required',
}

export const STRIPE_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type StripeSubscriptionStatus =
  (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];
export const isTerminalStripeStatus = (status?: string) =>
  status === 'canceled' || status === 'incomplete_expired';

export const STRIPE_EVENTS = new Set<string>([
  'checkout.session.completed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'invoice.marked_uncollectible',
]);

export const STRIPE_API_VERSION = '2026-08-26.dahlia';
export const STRIPE_LEASE_MS = 5 * 60 * 1000;
export const STRIPE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

// Meter summaries require minute-aligned windows. Keep every event inside its
// authoritative DataVault period, moving boundary events by less than a minute.
export function meterWindow(startsAt: Date, endsAt: Date) {
  return {
    start: Math.ceil(startsAt.getTime() / 60000) * 60,
    end: Math.ceil(endsAt.getTime() / 60000) * 60,
  };
}
