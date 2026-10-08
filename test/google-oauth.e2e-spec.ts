import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { CompanyVerificationService } from '../src/auth/company-verification.service';
import { GoogleOAuthFlowService } from '../src/auth/google-oauth-flow.service';
import { PasswordRecoveryService } from '../src/auth/password-recovery.service';
import { GoogleStrategy } from '../src/auth/strategies/google.strategy';
import { configureApp } from '../src/config/configure-app';
import { GoogleOauthGuard } from '../src/guards/google-oauth.guard';
import { IsAuthGuard } from '../src/guards/is-auth.guard';

describe('Google OAuth browser binding (e2e, no provider call)', () => {
  let app: INestApplication<App>;
  const state = 'S'.repeat(43);
  const browser = 'B'.repeat(43);
  const flow = {
    begin: jest.fn().mockResolvedValue({ state, browser }),
    consumeState: jest.fn().mockResolvedValue(undefined),
    createExchange: jest.fn(),
    consumeExchange: jest.fn(),
  };
  const auth = {
    signUpWithGoogle: jest
      .fn()
      .mockResolvedValue({ accessToken: 'tenant-token' }),
  };
  const config = new ConfigService({
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_CALLBACK_URL: 'https://api.example.test/auth/google/callback',
    FRONT_URI: 'https://client.example.test',
    TRUST_PROXY_HOPS: 0,
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        PassportModule.register({ session: false }),
        ThrottlerModule.forRoot([
          { name: 'publicAuth', ttl: 60_000, limit: 20 },
        ]),
      ],
      controllers: [AuthController],
      providers: [
        GoogleOauthGuard,
        {
          provide: GoogleStrategy,
          useFactory: () => new GoogleStrategy(config),
        },
        { provide: ConfigService, useValue: config },
        { provide: AuthService, useValue: auth },
        { provide: CompanyVerificationService, useValue: {} },
        { provide: GoogleOAuthFlowService, useValue: flow },
        { provide: PasswordRecoveryService, useValue: {} },
      ],
    })
      .overrideGuard(IsAuthGuard)
      .useValue({ canActivate: () => false })
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => app?.close());
  beforeEach(() => jest.clearAllMocks());

  it('redirects to Google with random state and a secure browser cookie', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/google')
      .expect(302);
    const google = new URL(response.headers.location);
    expect(google.hostname).toBe('accounts.google.com');
    expect(google.searchParams.get('state')).toBe(state);
    expect(google.searchParams.get('redirect_uri')).toBe(
      'https://api.example.test/auth/google/callback',
    );
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.join(';')).toContain('__Host-dv_google_oauth=');
    expect(cookies.join(';')).toContain('HttpOnly');
    expect(cookies.join(';')).toContain('Secure');
    expect(cookies.join(';')).toContain('SameSite=Lax');
    expect(cookies.join(';')).toContain('Path=/');
  });

  it('rejects a callback without matching state before contacting Google', async () => {
    flow.consumeState.mockRejectedValueOnce(
      new UnauthorizedException('Invalid Google sign-in state'),
    );
    await request(app.getHttpServer())
      .get('/auth/google/callback')
      .query({ code: 'provider-code' })
      .expect(401);
  });

  it('uses only a generic trusted redirect for a provider denial after state validation', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/google/callback')
      .set('Cookie', `__Host-dv_google_oauth=${browser}`)
      .query({
        state,
        error: 'access_denied',
        error_description: 'private details',
        redirect: 'https://evil.test',
      })
      .expect(302);
    expect(flow.consumeState).toHaveBeenCalledWith(state, browser);
    const redirect = new URL(response.headers.location);
    expect(redirect.origin).toBe('https://client.example.test');
    expect(redirect.searchParams.get('error')).toBe('google_auth_cancelled');
    expect(redirect.toString()).not.toContain('private details');
    expect(redirect.toString()).not.toContain('evil.test');
  });

  it('accepts validated company details for Google registration', async () => {
    await request(app.getHttpServer())
      .post('/auth/google/register')
      .send({
        code: 'C'.repeat(43),
        companyName: 'Acme',
        country: 'GE',
        industry: 'Technology',
      })
      .expect(200)
      .expect({ accessToken: 'tenant-token' });
    expect(auth.signUpWithGoogle).toHaveBeenCalledWith({
      code: 'C'.repeat(43),
      companyName: 'Acme',
      country: 'GE',
      industry: 'Technology',
    });
    await request(app.getHttpServer())
      .post('/auth/google/register')
      .send({
        code: 'invalid',
        companyName: 'A',
        country: 'GE',
        industry: 'Technology',
      })
      .expect(400);
  });
});
