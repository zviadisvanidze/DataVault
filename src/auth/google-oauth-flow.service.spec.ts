import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import {
  GOOGLE_EXCHANGE_TTL_MS,
  GOOGLE_STATE_TTL_MS,
  GoogleOAuthFlowService,
} from './google-oauth-flow.service';
import { googleOAuthExchangeSchema } from './entities/google-oauth-exchange.entity';
import { googleOAuthStateSchema } from './entities/google-oauth-state.entity';

describe('GoogleOAuthFlowService', () => {
  const states = new Map<string, { browserHash: string; expiresAt: Date }>();
  const exchanges = new Map<
    string,
    {
      userId?: Types.ObjectId;
      email?: string;
      fullName?: string;
      purpose: string;
      expiresAt: Date;
    }
  >();
  const stateModel = {
    create: jest.fn(
      (row: { stateHash: string; browserHash: string; expiresAt: Date }) => {
        states.set(row.stateHash, row);
        return Promise.resolve(row);
      },
    ),
    findOneAndDelete: jest.fn(
      (filter: {
        stateHash: string;
        browserHash: string;
        expiresAt: { $gt: Date };
      }) => {
        const row = states.get(filter.stateHash);
        if (
          !row ||
          row.browserHash !== filter.browserHash ||
          row.expiresAt <= filter.expiresAt.$gt
        )
          return Promise.resolve(null);
        states.delete(filter.stateHash);
        return Promise.resolve(row);
      },
    ),
  };
  const exchangeModel = {
    create: jest.fn(
      (row: {
        codeHash: string;
        userId?: Types.ObjectId;
        email?: string;
        fullName?: string;
        purpose: string;
        expiresAt: Date;
      }) => {
        exchanges.set(row.codeHash, row);
        return Promise.resolve(row);
      },
    ),
    findOneAndDelete: jest.fn(
      (filter: {
        codeHash: string;
        purpose: string;
        expiresAt: { $gt: Date };
      }) => {
        const row = exchanges.get(filter.codeHash);
        if (
          !row ||
          row.purpose !== filter.purpose ||
          row.expiresAt <= filter.expiresAt.$gt
        )
          return Promise.resolve(null);
        exchanges.delete(filter.codeHash);
        return Promise.resolve(row);
      },
    ),
  };
  const flow = new GoogleOAuthFlowService(
    stateModel as never,
    exchangeModel as never,
  );
  const now = new Date('2026-09-23T10:00:00.000Z');
  const hash = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  beforeEach(() => {
    states.clear();
    exchanges.clear();
    jest.clearAllMocks();
  });

  it('stores hashed browser-bound state and consumes it once', async () => {
    const { state, browser } = await flow.begin(now);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(browser).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stateModel.create).toHaveBeenCalledWith({
      stateHash: hash(state),
      browserHash: hash(browser),
      expiresAt: new Date(now.getTime() + GOOGLE_STATE_TTL_MS),
    });
    await expect(
      flow.consumeState(state, 'A'.repeat(43), now),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await flow.consumeState(state, browser, now);
    await expect(flow.consumeState(state, browser, now)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects missing, malformed, and expired state even before TTL cleanup', async () => {
    const { state, browser } = await flow.begin(now);
    await expect(
      flow.consumeState(undefined, browser, now),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      flow.consumeState(state, undefined, now),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      flow.consumeState(
        state,
        browser,
        new Date(now.getTime() + GOOGLE_STATE_TTL_MS),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('atomically consumes a purpose-scoped exchange once under concurrency', async () => {
    const userId = new Types.ObjectId();
    const code = await flow.createExchange(userId, now);
    expect(exchangeModel.create).toHaveBeenCalledWith({
      codeHash: hash(code),
      userId,
      purpose: 'google_login_exchange',
      expiresAt: new Date(now.getTime() + GOOGLE_EXCHANGE_TTL_MS),
    });
    const outcomes = await Promise.allSettled([
      flow.consumeExchange(code, now),
      flow.consumeExchange(code, now),
    ]);
    expect(
      outcomes.filter((value) => value.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((value) => value.status === 'rejected'),
    ).toHaveLength(1);
    await expect(flow.consumeExchange(code, now)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects tampered and expired exchange codes', async () => {
    const code = await flow.createExchange(new Types.ObjectId(), now);
    await expect(
      flow.consumeExchange('A'.repeat(43), now),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(flow.consumeExchange('bad', now)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      flow.consumeExchange(
        code,
        new Date(now.getTime() + GOOGLE_EXCHANGE_TTL_MS),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('uses a separate, one-use Google registration code', async () => {
    const profile = { email: 'new@example.com', fullName: 'New Owner' };
    const code = await flow.createRegistrationExchange(profile, now);
    expect(exchangeModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        codeHash: hash(code),
        purpose: 'google_registration_exchange',
        email: profile.email,
        expiresAt: new Date(now.getTime() + GOOGLE_STATE_TTL_MS),
      }),
    );
    await expect(flow.consumeExchange(code, now)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      flow.consumeRegistrationExchange(code, {} as never, now),
    ).resolves.toEqual({
      ...profile,
      avatar: undefined,
    });
    await expect(
      flow.consumeRegistrationExchange(code, {} as never, now),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('declares a real ObjectId reference and TTL index', () => {
    expect(googleOAuthExchangeSchema.path('userId').instance).toBe('ObjectId');
    expect(googleOAuthExchangeSchema.indexes()).toContainEqual([
      { expiresAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 0 }),
    ]);
    expect(googleOAuthStateSchema.indexes()).toContainEqual([
      { expiresAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 0 }),
    ]);
    expect(googleOAuthStateSchema.path('stateHash').options).toMatchObject({
      unique: true,
      select: false,
    });
    expect(googleOAuthExchangeSchema.path('codeHash').options).toMatchObject({
      unique: true,
      select: false,
    });
  });
});
