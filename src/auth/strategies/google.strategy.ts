import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { Strategy } from 'passport-google-oauth2';
import { GoogleUser } from '../auth.types';

interface GoogleProfile {
  email?: string;
  email_verified?: boolean;
  displayName: string;
  picture?: string;
}

export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService) {
    super({
      clientID: config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      clientSecret: config.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      callbackURL: config.getOrThrow<string>('GOOGLE_CALLBACK_URL'),
      scope: ['email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: GoogleProfile,
  ): GoogleUser {
    const email = profile.email_verified === true ? profile.email : undefined;
    if (!email)
      throw new UnauthorizedException('Google did not supply a verified email');
    return {
      email: email.toLowerCase(),
      fullName: profile.displayName.trim().slice(0, 100),
      avatar: profile.picture,
    };
  }
}
