interface DuplicateKeyError {
  code: number;
  keyPattern?: Record<string, number>;
}

export function isDuplicateKeyError(
  error: unknown,
): error is DuplicateKeyError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11000
  );
}

export function duplicateKeyField(
  error: DuplicateKeyError,
): string | undefined {
  return error.keyPattern ? Object.keys(error.keyPattern)[0] : undefined;
}
