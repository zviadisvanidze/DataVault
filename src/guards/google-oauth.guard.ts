import {
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import {
  GOOGLE_BROWSER_COOKIE,
  GOOGLE_STATE_TTL_MS,
  GoogleOAuthFlowService,
  LOCAL_GOOGLE_BROWSER_COOKIE,
} from '../auth/google-oauth-flow.service';

type GoogleRequest = Request & { oauthState?: string };

@Injectable()
export class GoogleOauthGuard extends AuthGuard('google') {
  constructor(
    private readonly config: ConfigService,
    private readonly flow: GoogleOAuthFlowService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext) {
    if (!this.config.get<string>('GOOGLE_CLIENT_ID'))
      throw new ServiceUnavailableException(
        'Google authentication is not configured',
      );
    const request = context.switchToHttp().getRequest<GoogleRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    if (this.config.get<string>('NODE_ENV') === 'production' && !request.secure)
      throw new ForbiddenException('HTTPS is required for Google sign-in');
    response.setHeader('Cache-Control', 'private, no-store');
    const secure =
      new URL(this.config.getOrThrow<string>('GOOGLE_CALLBACK_URL'))
        .protocol === 'https:';
    const cookieName = secure
      ? GOOGLE_BROWSER_COOKIE
      : LOCAL_GOOGLE_BROWSER_COOKIE;
    const cookieOptions = {
      httpOnly: true,
      secure,
      sameSite: 'lax' as const,
      // __Host- cookies must use Path=/ and cannot be set by sibling subdomains.
      path: secure ? '/' : '/auth/google/callback',
    };
    if (request.path === '/auth/google') {
      const { state, browser } = await this.flow.begin();
      request.oauthState = state;
      response.cookie(cookieName, browser, {
        ...cookieOptions,
        maxAge: GOOGLE_STATE_TTL_MS,
      });
      return super.canActivate(context) as Promise<boolean>;
    }
    if (request.path !== '/auth/google/callback')
      throw new UnauthorizedException('Invalid Google sign-in request');
    const browser = request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    response.clearCookie(cookieName, cookieOptions);
    await this.flow.consumeState(request.query.state, browser);
    if (request.query.error) return true;
    if (typeof request.query.code !== 'string')
      throw new UnauthorizedException('Google authentication failed');
    return super.canActivate(context) as Promise<boolean>;
  }

  getAuthenticateOptions(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<GoogleRequest>();
    return request.oauthState ? { state: request.oauthState } : undefined;
  }

  handleRequest<TUser = unknown>(
    error: unknown,
    user: TUser | undefined,
  ): TUser {
    if (error || !user)
      throw new UnauthorizedException('Google authentication failed');
    return user;
  }
}
