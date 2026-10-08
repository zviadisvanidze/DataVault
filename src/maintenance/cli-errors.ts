/** Diagnostics are fixed categories, never database/provider exception text. */
export enum CliFailureCategory {
  INVALID_BOOTSTRAP_CONFIGURATION = 'invalid_bootstrap_configuration',
  INVALID_CLEANUP_ARGUMENTS = 'invalid_cleanup_arguments',
  INVALID_SMOKE_CONFIGURATION = 'invalid_smoke_configuration',
  INVALID_ADMIN_PASSWORD_RESET_CONFIGURATION = 'invalid_admin_password_reset_configuration',
  PLATFORM_ADMIN_NOT_FOUND = 'platform_admin_not_found',
  PLATFORM_ADMIN_INACTIVE = 'platform_admin_inactive',
  PLATFORM_ADMIN_PASSWORD_HASH = 'platform_admin_password_hash_failed',
  MONGO_CONNECTION = 'mongo_connection_failed',
  MONGO_INDEX = 'mongo_index_failed',
  MONGO_QUERY = 'mongo_query_failed',
  MONGO_TRANSACTION = 'mongo_transaction_failed',
  CLEANUP_REFUSED = 'cleanup_refused',
  CLEANUP_COUNTS = 'cleanup_count_mismatch',
  INVALID_STRIPE_RESET_ARGUMENTS = 'invalid_stripe_reset_arguments',
  STRIPE_RESET_REFUSED = 'stripe_test_reset_refused',
  STRIPE_RESET_COUNT_MISMATCH = 'stripe_test_reset_count_mismatch',
  CLOSE = 'mongo_close_failed',
  OPERATOR_CANCELLED = 'operator_cancelled',
  SMOKE_HTTP = 'smoke_http_failed',
  SMOKE_ASSERTION = 'smoke_assertion_failed',
  SMOKE_RECOVERY = 'smoke_reactivation_required',
  UNKNOWN = 'cli_failed',
}

export class CliFailure extends Error {
  constructor(public readonly category: CliFailureCategory) {
    super(category);
    this.name = 'CliFailure';
  }
}

export function safeCliCategory(
  error: unknown,
  fallback = CliFailureCategory.UNKNOWN,
): CliFailureCategory {
  return error instanceof CliFailure &&
    Object.values(CliFailureCategory).includes(error.category)
    ? error.category
    : fallback;
}
