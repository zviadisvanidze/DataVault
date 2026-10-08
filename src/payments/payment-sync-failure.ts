import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { mongo } from 'mongoose';
import Stripe from 'stripe';

export enum PaymentSyncReason {
  CHECKOUT_MAPPING_PENDING = 'checkout_mapping_pending',
  COMPANY_LEASE_BUSY = 'company_lease_busy',
  DATABASE_RETRY = 'database_retry',
  STRIPE_SYNC_RETRY = 'stripe_sync_retry',
  VALIDATION_FAILED = 'stripe_sync_validation',
}

export class CheckoutMappingPendingException extends ServiceUnavailableException {
  constructor() {
    super('Checkout completion is being synchronized');
  }
}

export class CompanyLeaseBusyException extends ConflictException {}

// Preserve the existing HTTP 503 contract for provider mapping/catalog checks,
// without labeling a configuration or validation failure as transient in logs.
export class PaymentSyncValidationException extends ServiceUnavailableException {}

interface PaymentSyncClassification {
  reason: PaymentSyncReason;
  failureKind: 'expected_retry' | 'validation_failure' | 'unexpected_failure';
  retryable: boolean | null;
}

export function classifyPaymentSyncFailure(
  error: unknown,
): PaymentSyncClassification {
  const retry = (reason: PaymentSyncReason): PaymentSyncClassification => ({
    reason,
    failureKind: 'expected_retry',
    retryable: true,
  });
  if (error instanceof CheckoutMappingPendingException)
    return retry(PaymentSyncReason.CHECKOUT_MAPPING_PENDING);
  if (error instanceof CompanyLeaseBusyException)
    return retry(PaymentSyncReason.COMPANY_LEASE_BUSY);
  if (
    error instanceof mongo.MongoNetworkError ||
    (error instanceof mongo.MongoError &&
      [
        'TransientTransactionError',
        'UnknownTransactionCommitResult',
        'RetryableWriteError',
      ].some((label) => error.hasErrorLabel(label))) ||
    (error instanceof mongo.MongoServerError && error.code === 112)
  )
    return retry(PaymentSyncReason.DATABASE_RETRY);
  if (
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeRateLimitError ||
    (error instanceof Stripe.errors.StripeAPIError &&
      error.statusCode !== undefined &&
      error.statusCode >= 500)
  )
    return retry(PaymentSyncReason.STRIPE_SYNC_RETRY);
  if (
    error instanceof PaymentSyncValidationException ||
    error instanceof BadRequestException ||
    error instanceof ForbiddenException ||
    error instanceof NotFoundException ||
    error instanceof ConflictException ||
    error instanceof Stripe.errors.StripeInvalidRequestError ||
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripePermissionError ||
    error instanceof Stripe.errors.StripeCardError ||
    error instanceof Stripe.errors.StripeIdempotencyError
  )
    return {
      reason: PaymentSyncReason.VALIDATION_FAILED,
      failureKind: 'validation_failure',
      retryable: false,
    };
  // Unknown failures retain the existing retry response, but no claim is made
  // that the underlying failure is transient. Never serialize the error itself.
  return {
    reason: PaymentSyncReason.STRIPE_SYNC_RETRY,
    failureKind: 'unexpected_failure',
    retryable: null,
  };
}

export function safePaymentSyncIdentifiers(context: {
  eventId?: string;
  companyId?: string;
  subscriptionId?: string;
  stripeSubscriptionId?: string;
}) {
  const safe: Record<string, string> = {};
  const matches = (value: string, pattern: RegExp) =>
    value.match(pattern)?.[0] === value;
  if (context.eventId && matches(context.eventId, /^evt_[A-Za-z0-9_]{1,128}$/))
    safe.eventId = context.eventId;
  for (const key of ['companyId', 'subscriptionId'] as const)
    if (context[key] && matches(context[key], /^[a-fA-F0-9]{24}$/))
      safe[key] = context[key];
  if (
    context.stripeSubscriptionId &&
    matches(context.stripeSubscriptionId, /^sub_[A-Za-z0-9_]{1,128}$/)
  )
    safe.stripeSubscriptionId = context.stripeSubscriptionId;
  return safe;
}
