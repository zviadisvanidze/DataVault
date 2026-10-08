import { hkdfSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtModuleOptions } from '@nestjs/jwt';
import { validNewPassword } from '../common/password-policy';

export const PLATFORM_ADMIN_ISSUER = 'datavault-platform';
export const PLATFORM_ADMIN_AUDIENCE = 'datavault-platform-admin';
export const PLATFORM_ADMIN_TOKEN_TYPE = 'platform_admin';
export const PLATFORM_ADMIN_JWT = Symbol('PLATFORM_ADMIN_JWT');
export const PLATFORM_ADMIN_BCRYPT_ROUNDS = 12;

// Purpose-separated signing key: a platform token cannot verify with the
// ordinary tenant key even if an ObjectId happens to exist in both collections.
export function platformAdminJwtOptions(
  config: ConfigService,
): JwtModuleOptions {
  const root = config.getOrThrow<string>('JWT_SECRET');
  if (root.length < 32)
    throw new Error('JWT_SECRET must contain at least 32 characters');
  return {
    secret: Buffer.from(
      hkdfSync('sha256', root, 'datavault', 'platform-admin-jwt-v1', 32),
    ).toString('hex'),
    signOptions: {
      algorithm: 'HS256',
      expiresIn: '30m',
      issuer: PLATFORM_ADMIN_ISSUER,
      audience: PLATFORM_ADMIN_AUDIENCE,
    },
    verifyOptions: {
      algorithms: ['HS256'],
      issuer: PLATFORM_ADMIN_ISSUER,
      audience: PLATFORM_ADMIN_AUDIENCE,
    },
  };
}

export const validPlatformAdminPassword = validNewPassword;

export const validBootstrapPassword = validPlatformAdminPassword;
