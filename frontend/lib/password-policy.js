export const NEW_PASSWORD_MIN_LENGTH = 12;
export const NEW_PASSWORD_MAX_LENGTH = 72;
export const NEW_PASSWORD_HINT =
  "12–72 characters with uppercase and lowercase letters, a number, and a symbol (72 UTF-8 bytes maximum).";

export function validNewPassword(value) {
  return (
    typeof value === "string" &&
    value.length >= NEW_PASSWORD_MIN_LENGTH &&
    value.length <= NEW_PASSWORD_MAX_LENGTH &&
    new TextEncoder().encode(value).length <= NEW_PASSWORD_MAX_LENGTH &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9\s]/.test(value)
  );
}
