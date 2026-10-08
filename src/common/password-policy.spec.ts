import { validateSync } from 'class-validator';
import { validNewPassword } from './password-policy';
import { SignInDto } from '../auth/dto/sign-in.dto';
import { SignUpDto } from '../auth/dto/sign-up.dto';
import { AcceptInvitationDto } from '../invitations/dto/accept-invitation.dto';
import { ResetPasswordDto } from '../auth/dto/reset-password.dto';
import { ChangePasswordDto } from '../users/dto/change-password.dto';
import { AdminResetPasswordDto } from '../admin/dto/admin.dto';
import { SetupPlatformAccessDto } from '../admin/dto/admin-access-request.dto';

const validPassword = 'SecurePassword42!';
const longPassword = 'A'.repeat(60) + 'a1!';
const tooManyBytes = 'A'.repeat(60) + 'a1!é'.repeat(5);

describe('shared new-password policy', () => {
  it('accepts strong passwords up to 72 UTF-8 bytes', () => {
    expect(validNewPassword(validPassword)).toBe(true);
    expect(validNewPassword(longPassword)).toBe(true);
    expect(validNewPassword('A'.repeat(69) + 'a1!')).toBe(true);
  });

  it.each([
    'Short1!',
    'alllowercase42!',
    'ALLUPPERCASE42!',
    'NoNumberHere!',
    'NoSymbolHere42',
    tooManyBytes,
    'A'.repeat(70) + 'a1!',
  ])('rejects a password outside the rule: %s', (password) => {
    expect(validNewPassword(password)).toBe(false);
  });

  it.each([
    [SignUpDto, 'password'],
    [AcceptInvitationDto, 'password'],
    [ResetPasswordDto, 'newPassword'],
    [ChangePasswordDto, 'newPassword'],
    [AdminResetPasswordDto, 'newPassword'],
    [SetupPlatformAccessDto, 'newPassword'],
  ])('%s enforces the policy on %s', (Dto, property) => {
    const value = new Dto();
    Object.assign(value, { [property]: validPassword });
    expect(
      validateSync(value).some((error) => error.property === property),
    ).toBe(false);
    Object.assign(value, { [property]: 'weakpassword' });
    expect(
      validateSync(value).some((error) => error.property === property),
    ).toBe(true);
    Object.assign(value, { [property]: tooManyBytes });
    expect(
      validateSync(value).some((error) => error.property === property),
    ).toBe(true);
  });

  it('allows legacy and long new passwords at sign-in', () => {
    const signIn = new SignInDto();
    signIn.email = 'owner@example.com';
    signIn.password = 'legacy';
    expect(validateSync(signIn)).toEqual([]);
    signIn.password = longPassword;
    expect(validateSync(signIn)).toEqual([]);
    signIn.password = 'A'.repeat(73);
    expect(
      validateSync(signIn).some((error) => error.property === 'password'),
    ).toBe(true);
  });
});
