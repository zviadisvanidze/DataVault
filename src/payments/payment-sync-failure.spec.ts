import { BadRequestException, ConflictException } from '@nestjs/common';
import { mongo } from 'mongoose';
import Stripe from 'stripe';
import {
  CheckoutMappingPendingException,
  CompanyLeaseBusyException,
  PaymentSyncValidationException,
  classifyPaymentSyncFailure,
  safePaymentSyncIdentifiers,
} from './payment-sync-failure';

describe('safe payment synchronization failure classification', () => {
  it.each([
    [new CheckoutMappingPendingException(), 'checkout_mapping_pending'],
    [new CompanyLeaseBusyException('lease busy'), 'company_lease_busy'],
    [
      new mongo.MongoServerError({ message: 'write conflict', code: 112 }),
      'database_retry',
    ],
    [new mongo.MongoNetworkError('connection failed'), 'database_retry'],
    [
      new mongo.MongoServerError({
        message: 'transaction',
        errorLabels: ['TransientTransactionError'],
      }),
      'database_retry',
    ],
    [
      new mongo.MongoServerError({
        message: 'commit',
        errorLabels: ['UnknownTransactionCommitResult'],
      }),
      'database_retry',
    ],
    [
      new mongo.MongoServerError({
        message: 'write',
        errorLabels: ['RetryableWriteError'],
      }),
      'database_retry',
    ],
    [
      new Stripe.errors.StripeConnectionError({ message: 'connection failed' }),
      'stripe_sync_retry',
    ],
    [
      new Stripe.errors.StripeRateLimitError({ message: 'rate limit' }),
      'stripe_sync_retry',
    ],
    [
      new Stripe.errors.StripeAPIError({
        message: 'provider failed',
        statusCode: 503,
      }),
      'stripe_sync_retry',
    ],
  ])(
    'classifies a typed transient error without using its message',
    (error, reason) => {
      expect(classifyPaymentSyncFailure(error)).toEqual({
        reason,
        failureKind: 'expected_retry',
        retryable: true,
      });
    },
  );

  it.each([
    new BadRequestException('invalid setup'),
    new ConflictException('plan conflict'),
    new PaymentSyncValidationException('invalid tenant mapping'),
    new Stripe.errors.StripeInvalidRequestError({ message: 'invalid request' }),
    new Stripe.errors.StripeAuthenticationError({
      message: 'invalid credentials',
    }),
  ])('does not call a permanent rejection transient', (error) => {
    expect(classifyPaymentSyncFailure(error)).toEqual({
      reason: 'stripe_sync_validation',
      failureKind: 'validation_failure',
      retryable: false,
    });
  });

  it.each([
    new Error('Billing synchronization is in progress; retry shortly'),
    { code: 112, message: 'not a driver error' },
    new mongo.MongoServerError({ message: 'duplicate', code: 11000 }),
    undefined,
  ])(
    'does not infer retryability from unknown errors or unrelated database codes',
    (error) => {
      expect(classifyPaymentSyncFailure(error)).toEqual({
        reason: 'stripe_sync_retry',
        failureKind: 'unexpected_failure',
        retryable: null,
      });
    },
  );

  it('keeps only complete safe identifier shapes and rejects log injection', () => {
    expect(
      safePaymentSyncIdentifiers({
        eventId: 'evt_fixture',
        companyId: 'a'.repeat(24),
        subscriptionId: 'b'.repeat(24),
        stripeSubscriptionId: 'sub_fixture',
      }),
    ).toEqual({
      eventId: 'evt_fixture',
      companyId: 'a'.repeat(24),
      subscriptionId: 'b'.repeat(24),
      stripeSubscriptionId: 'sub_fixture',
    });
    expect(
      safePaymentSyncIdentifiers({
        eventId: 'evt_fixture\n',
        companyId: 'user@example.test',
        subscriptionId: 'mongodb://user:password@host',
        stripeSubscriptionId: 'sub_fixture\nsecret',
      }),
    ).toEqual({});
  });
});
