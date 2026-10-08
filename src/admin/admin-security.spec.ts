import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { Mongoose } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { adminFixture } from '../../test/admin.fixture';
import {
  platformAdminJwtOptions,
  validBootstrapPassword,
} from './admin-security';
import { PlatformAdminGuard } from './platform-admin.guard';
import { AdminBootstrapService } from './admin-bootstrap.service';
import { adminAuditSchema } from './entities/admin-audit.entity';
import { platformAdminSchema } from './entities/platform-admin.entity';

describe('isolated platform administration security', () => {
  let f: Awaited<ReturnType<typeof adminFixture>>;
  beforeEach(async () => {
    f = await adminFixture();
  });
  const context = (token: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }),
      }),
    }) as ExecutionContext;

  it('authenticates using a hash, signs a purpose-separated short-lived token, and records safe audit data', async () => {
    const result = await f.auth.login({
      email: 'platform@fixture.test',
      password: f.password,
    });
    const payload = await f.jwt.verifyAsync<{
      sub: string;
      type: string;
      iat: number;
      exp: number;
      iss: string;
      aud: string;
    }>(result.accessToken);
    expect(payload).toMatchObject({
      sub: f.adminId.toString(),
      type: 'platform_admin',
      iss: 'datavault-platform',
      aud: 'datavault-platform-admin',
    });
    expect(payload.exp - payload.iat).toBe(1800);
    await expect(f.tenantJwt.verifyAsync(result.accessToken)).rejects.toThrow();
    expect(f.adminaudits[0]).toMatchObject({
      action: 'login_succeeded',
      actorId: f.adminId,
      targetType: 'platform_admin',
    });
    expect(JSON.stringify(f.adminaudits)).not.toContain(f.password);
    expect(JSON.stringify(f.adminaudits)).not.toContain(
      'platform@fixture.test',
    );
  });

  it('uses generic failures for wrong/unknown/disabled credentials and audits each attempt', async () => {
    await expect(
      f.auth.login({ email: 'platform@fixture.test', password: 'incorrect' }),
    ).rejects.toThrow('Invalid credentials');
    await expect(
      f.auth.login({ email: 'unknown@fixture.test', password: f.password }),
    ).rejects.toThrow('Invalid credentials');
    f.platformadmins[0].isActive = false;
    await expect(
      f.auth.login({ email: 'platform@fixture.test', password: f.password }),
    ).rejects.toThrow('Invalid credentials');
    expect(f.adminaudits.map((row) => row.action)).toEqual([
      'login_failed',
      'login_failed',
      'login_failed',
    ]);
    expect(f.adminaudits[1].actorId).toBeUndefined();
    expect(JSON.stringify(f.adminaudits)).not.toMatch(
      /password|unknown@|incorrect/,
    );
  });

  it('fails closed when admin login cannot be audited', async () => {
    f.models.adminAudit.create.mockRejectedValueOnce(
      new Error('sensitive infrastructure error'),
    );
    await expect(
      f.auth.login({ email: 'platform@fixture.test', password: f.password }),
    ).rejects.toThrow('Platform authentication temporarily unavailable');
  });

  it('rejects tenant JWTs even with an overlapping ObjectId, wrong scope, issuer, audience or expired admin tokens', async () => {
    const guard = new PlatformAdminGuard(
      f.jwt,
      f.models.platformAdmin as never,
    );
    const tokens = [
      f.tenantJwt.sign({ id: f.adminId.toString() }),
      f.jwt.sign({ sub: f.adminId.toString(), type: 'company_owner' }),
      f.jwt.sign(
        { sub: f.adminId.toString(), type: 'platform_admin' },
        { issuer: 'other' },
      ),
      f.jwt.sign(
        { sub: f.adminId.toString(), type: 'platform_admin' },
        { audience: 'tenant' },
      ),
      f.jwt.sign(
        { sub: f.adminId.toString(), type: 'platform_admin' },
        { expiresIn: -1 },
      ),
    ];
    for (const token of tokens)
      await expect(guard.canActivate(context(token))).rejects.toThrow(
        'Invalid or expired platform administrator token',
      );
    expect(f.models.platformAdmin.findById).not.toHaveBeenCalled();
  });

  it('rechecks authoritative administrator availability for each issued token', async () => {
    const { accessToken } = await f.auth.login({
      email: 'platform@fixture.test',
      password: f.password,
    });
    const guard = new PlatformAdminGuard(
      f.jwt,
      f.models.platformAdmin as never,
    );
    await expect(guard.canActivate(context(accessToken))).resolves.toBe(true);
    f.platformadmins[0].isActive = false;
    await expect(guard.canActivate(context(accessToken))).rejects.toThrow(
      'Invalid or expired',
    );
  });

  it('derives a distinct signing key and refuses a weak root configuration', () => {
    expect(platformAdminJwtOptions(f.config).secret).not.toBe(
      f.config.get('JWT_SECRET'),
    );
    expect(platformAdminJwtOptions(f.config)).toEqual(
      platformAdminJwtOptions(f.config),
    );
    expect(() =>
      platformAdminJwtOptions(new ConfigService({ JWT_SECRET: 'short' })),
    ).toThrow('at least 32');
  });

  it.each([
    '',
    'password',
    'onlylowercase123!',
    'NOLOWERCASE123!',
    'NoDigitsHere!',
    'NoSpecialCharacter42',
    'A'.repeat(73) + 'a1!',
  ])('rejects unsafe bootstrap passwords', (password) => {
    expect(validBootstrapPassword(password)).toBe(false);
  });

  it('bootstrap is explicit, hashed, transactional and idempotent without replacing credentials', async () => {
    f.platformadmins.splice(0);
    f.config.set('PLATFORM_ADMIN_BOOTSTRAP_EMAIL', '  Platform@Fixture.Test  ');
    f.config.set('PLATFORM_ADMIN_BOOTSTRAP_FULL_NAME', '  Operator  ');
    f.config.set('PLATFORM_ADMIN_BOOTSTRAP_PASSWORD', f.password);
    const bootstrap = new AdminBootstrapService(
      f.config,
      f.models.platformAdmin as never,
      f.models.adminAudit as never,
      f.connection as never,
    );
    expect(await bootstrap.run()).toEqual({ created: true });
    const admin = f.platformadmins[0];
    expect(admin.email).toBe('platform@fixture.test');
    expect(admin.password).not.toBe(f.password);
    expect(await bcrypt.compare(f.password, admin.password as string)).toBe(
      true,
    );
    expect(f.adminaudits[0].action).toBe('bootstrap_created');
    const savedHash = admin.password;
    f.config.set(
      'PLATFORM_ADMIN_BOOTSTRAP_PASSWORD',
      'Different-Strong-Password42!',
    );
    expect(await bootstrap.run()).toEqual({ created: false });
    expect(admin.password).toBe(savedHash);
    expect(f.adminaudits).toHaveLength(1);
  });

  it('bootstrap rejects absent configuration before attempting writes', async () => {
    const bootstrap = new AdminBootstrapService(
      f.config,
      f.models.platformAdmin as never,
      f.models.adminAudit as never,
      f.connection as never,
    );
    await expect(bootstrap.run()).rejects.toThrow(
      'invalid_bootstrap_configuration',
    );
    expect(f.models.platformAdmin.create).not.toHaveBeenCalled();
    expect(f.models.adminAudit.create).not.toHaveBeenCalled();
    expect(f.models.platformAdmin.init).not.toHaveBeenCalled();
  });

  it('bootstrap rolls back admin creation when append-only audit persistence fails', async () => {
    f.platformadmins.splice(0);
    f.config.set('PLATFORM_ADMIN_BOOTSTRAP_EMAIL', 'platform@fixture.test');
    f.config.set('PLATFORM_ADMIN_BOOTSTRAP_FULL_NAME', 'Operator');
    f.config.set('PLATFORM_ADMIN_BOOTSTRAP_PASSWORD', f.password);
    f.models.adminAudit.create.mockRejectedValueOnce(
      new Error('audit unavailable'),
    );
    const bootstrap = new AdminBootstrapService(
      f.config,
      f.models.platformAdmin as never,
      f.models.adminAudit as never,
      f.connection as never,
    );
    await expect(bootstrap.run()).rejects.toThrow('mongo_transaction_failed');
    expect(f.platformadmins).toHaveLength(0);
  });

  it('models isolate identities, redact password hashes, and prohibit audit query updates/deletions', async () => {
    const mongoose = new Mongoose();
    const Admin = mongoose.model(
      'AdminSecuritySchemaTest',
      platformAdminSchema,
    );
    const Audit = mongoose.model('AuditSecuritySchemaTest', adminAuditSchema);
    const admin = new Admin({
      email: 'platform@fixture.test',
      fullName: 'Operator',
      password: 'not-a-returnable-hash',
    });
    expect(admin.toJSON()).not.toHaveProperty('password');
    expect(platformAdminSchema.path('companyId')).toBeUndefined();
    expect(platformAdminSchema.path('role')).toBeUndefined();
    expect(platformAdminSchema.indexes()).toContainEqual([
      { email: 1 },
      expect.objectContaining({ unique: true }),
    ]);
    expect(adminAuditSchema.path('actorId').instance).toBe('ObjectId');
    await expect(
      Audit.updateOne({}, { $set: { reason: 'invalid_credentials' } }).exec(),
    ).rejects.toThrow('append-only');
    await expect(Audit.deleteMany({}).exec()).rejects.toThrow('append-only');
    await expect(
      new Audit({ action: 'login_failed' }).deleteOne(),
    ).rejects.toThrow('append-only');
    await expect(
      Audit.bulkWrite([{ deleteMany: { filter: {} } }]),
    ).rejects.toThrow('append-only');
    await expect(
      Audit.findOneAndReplace({}, { action: 'login_failed' }).exec(),
    ).rejects.toThrow('append-only');
  });
});
