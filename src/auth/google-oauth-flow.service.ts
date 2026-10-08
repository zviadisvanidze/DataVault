import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'node:crypto';
import { ClientSession, Model, Types } from 'mongoose';
import { GoogleOAuthState } from './entities/google-oauth-state.entity';
import { GoogleOAuthExchange } from './entities/google-oauth-exchange.entity';
import { GoogleUser } from './auth.types';

export const GOOGLE_STATE_TTL_MS = 5 * 60 * 1000;
export const GOOGLE_EXCHANGE_TTL_MS = 60 * 1000;
export const GOOGLE_BROWSER_COOKIE = '__Host-dv_google_oauth';
export const LOCAL_GOOGLE_BROWSER_COOKIE = 'dv_google_oauth';
const opaquePattern = /^[A-Za-z0-9_-]{43}$/;

@Injectable()
export class GoogleOAuthFlowService {
  constructor(
    @InjectModel('googleOAuthState')
    private readonly stateModel: Model<GoogleOAuthState>,
    @InjectModel('googleOAuthExchange')
    private readonly exchangeModel: Model<GoogleOAuthExchange>,
  ) {}

  async begin(now = new Date()) {
    const state = this.randomToken();
    const browser = this.randomToken();
    await this.stateModel.create({
      stateHash: this.hash(state),
      browserHash: this.hash(browser),
      expiresAt: new Date(now.getTime() + GOOGLE_STATE_TTL_MS),
    });
    return { state, browser };
  }

  async consumeState(state: unknown, browser: unknown, now = new Date()) {
    if (!this.isOpaque(state) || !this.isOpaque(browser))
      throw new UnauthorizedException('Invalid Google sign-in state');
    const consumed = await this.stateModel.findOneAndDelete({
      stateHash: this.hash(state),
      browserHash: this.hash(browser),
      expiresAt: { $gt: now },
    });
    if (!consumed)
      throw new UnauthorizedException('Invalid Google sign-in state');
  }

  async createExchange(userId: Types.ObjectId, now = new Date()) {
    const code = this.randomToken();
    await this.exchangeModel.create({
      codeHash: this.hash(code),
      userId,
      purpose: 'google_login_exchange',
      expiresAt: new Date(now.getTime() + GOOGLE_EXCHANGE_TTL_MS),
    });
    return code;
  }

  async consumeExchange(code: string, now = new Date()) {
    if (!this.isOpaque(code))
      throw new UnauthorizedException('Invalid Google sign-in code');
    const exchange = await this.exchangeModel.findOneAndDelete({
      codeHash: this.hash(code),
      purpose: 'google_login_exchange',
      expiresAt: { $gt: now },
    });
    if (!exchange?.userId)
      throw new UnauthorizedException('Invalid Google sign-in code');
    return exchange.userId;
  }

  async createRegistrationExchange(profile: GoogleUser, now = new Date()) {
    const code = this.randomToken();
    await this.exchangeModel.create({
      codeHash: this.hash(code),
      purpose: 'google_registration_exchange',
      email: profile.email,
      fullName: profile.fullName,
      avatar: profile.avatar,
      expiresAt: new Date(now.getTime() + GOOGLE_STATE_TTL_MS),
    });
    return code;
  }

  async consumeRegistrationExchange(
    code: string,
    session: ClientSession,
    now = new Date(),
  ) {
    if (!this.isOpaque(code))
      throw new UnauthorizedException('Invalid Google registration code');
    const exchange = await this.exchangeModel.findOneAndDelete(
      {
        codeHash: this.hash(code),
        purpose: 'google_registration_exchange',
        expiresAt: { $gt: now },
      },
      { session },
    );
    if (!exchange?.email)
      throw new UnauthorizedException('Invalid Google registration code');
    return {
      email: exchange.email,
      fullName: exchange.fullName ?? '',
      avatar: exchange.avatar,
    };
  }

  private randomToken() {
    return randomBytes(32).toString('base64url');
  }

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private isOpaque(value: unknown): value is string {
    return typeof value === 'string' && opaquePattern.test(value);
  }
}
