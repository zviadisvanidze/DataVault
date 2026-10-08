import { ValidateBy } from 'class-validator';

export const NEW_PASSWORD_MIN_LENGTH = 12;
export const NEW_PASSWORD_MAX_LENGTH = 72;

// bcrypt uses at most 72 UTF-8 bytes. Enforce the same creation rule for
// workspace and platform accounts so no accepted password is silently cut off.
export function validNewPassword(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= NEW_PASSWORD_MIN_LENGTH &&
    value.length <= NEW_PASSWORD_MAX_LENGTH &&
    Buffer.byteLength(value, 'utf8') <= NEW_PASSWORD_MAX_LENGTH &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9\s]/.test(value)
  );
}

export const NewPassword = () =>
  ValidateBy({
    name: 'newPasswordPolicy',
    validator: {
      validate: validNewPassword,
      defaultMessage: () =>
        'Password must be 12–72 characters (at most 72 UTF-8 bytes) and include uppercase and lowercase letters, a number, and a symbol',
    },
  });
