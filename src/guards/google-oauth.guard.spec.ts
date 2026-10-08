import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { GoogleOauthGuard } from './google-oauth.guard';
import { GOOGLE_BROWSER_COOKIE } from '../auth/google-oauth-flow.service';

describe('GoogleOauthGuard', () => {
  const state = 'S'.repeat(43);
  const browser = 'B'.repeat(43);
  const flow = {
    begin: jest.fn().mockResolvedValue({ state, browser }),
    consumeState: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: jest.fn().mockReturnValue('google-client'),
    getOrThrow: jest
      .fn()
      .mockReturnValue('https://api.example.test/auth/google/callback'),
  };
  const guard = new GoogleOauthGuard(config as never, flow as never);
  const passportCanActivate = jest.spyOn(
    Object.getPrototypeOf(GoogleOauthGuard.prototype) as {
      canActivate: (context: ExecutionContext) => Promise<boolean>;
    },
    'canActivate',
  );

  function context(
    path: string,
    query: Record<string, unknown> = {},
    cookie?: string,
  ) {
    const request = { path, query, headers: { cookie } };
    const response = {
      setHeader: jest.fn(),
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };
    const execution = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
    return { request, response, execution };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReturnValue('google-client');
    passportCanActivate.mockResolvedValue(true);
    flow.consumeState.mockResolvedValue(undefined);
  });

  afterAll(() => passportCanActivate.mockRestore());

  it('sets a secure short-lived HttpOnly browser cookie and supplies state to Passport', async () => {
    const { request, response, execution } = context('/auth/google');
    await expect(guard.canActivate(execution)).resolves.toBe(true);
    expect(guard.getAuthenticateOptions(execution)).toEqual({ state });
    expect(response.cookie).toHaveBeenCalledWith(
      GOOGLE_BROWSER_COOKIE,
      browser,
      {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 300000,
      },
    );
    expect(passportCanActivate).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveProperty('user');
  });

  it('validates state and cookie before Passport can accept a callback', async () => {
    const { execution, response } = context(
      '/auth/google/callback',
      { code: 'provider-code', state },
      `${GOOGLE_BROWSER_COOKIE}=${browser}`,
    );
    await expect(guard.canActivate(execution)).resolves.toBe(true);
    expect(flow.consumeState).toHaveBeenCalledWith(state, browser);
    expect(response.clearCookie).toHaveBeenCalledWith(
      GOOGLE_BROWSER_COOKIE,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      }),
    );
    expect(flow.consumeState.mock.invocationCallOrder[0]).toBeLessThan(
      passportCanActivate.mock.invocationCallOrder[0],
    );
  });

  it('rejects missing or invalid state and never invokes Passport', async () => {
    flow.consumeState.mockRejectedValueOnce(
      new UnauthorizedException('Invalid Google sign-in state'),
    );
    const { execution } = context('/auth/google/callback', {
      code: 'provider-code',
    });
    await expect(guard.canActivate(execution)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(passportCanActivate).not.toHaveBeenCalled();
  });

  it('sanitizes provider denial only after valid browser-bound state', async () => {
    const { execution } = context(
      '/auth/google/callback',
      {
        error: 'access_denied',
        error_description: 'private provider detail',
        state,
      },
      `${GOOGLE_BROWSER_COOKIE}=${browser}`,
    );
    await expect(guard.canActivate(execution)).resolves.toBe(true);
    expect(passportCanActivate).not.toHaveBeenCalled();
    expect(() =>
      guard.handleRequest(new Error('private provider detail'), null),
    ).toThrow('Google authentication failed');
  });

  it('fails closed on insecure production initiation before creating state', async () => {
    config.get.mockImplementation((key: string) =>
      key === 'NODE_ENV' ? 'production' : 'google-client',
    );
    const { execution } = context('/auth/google');
    await expect(guard.canActivate(execution)).rejects.toThrow(
      'HTTPS is required for Google sign-in',
    );
    expect(flow.begin).not.toHaveBeenCalled();
  });
});
