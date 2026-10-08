import { Logger } from '@nestjs/common';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  AiModelCompletion,
  AiProviderFailure,
  AiProviderFailureReason,
} from './ai-model-client';
import { AiProviderRouterService } from './ai-provider-router.service';
import { GeminiClientService } from './gemini-client.service';
import { OpenRouterClientService } from './openrouter-client.service';

const completion = (provider: 'openrouter' | 'gemini'): AiModelCompletion => ({
  provider,
  model: provider === 'gemini' ? 'gemini-3.5-flash-lite' : 'provider/model',
  message: { role: 'assistant', content: 'fixture answer', refusal: null },
  promptTokens: 4,
  completionTokens: 3,
  totalTokens: 7,
});

function fixture(openRouterEnabled = true, geminiEnabled = true) {
  const openRouter = {
    enabled: openRouterEnabled,
    complete: jest.fn().mockResolvedValue(completion('openrouter')),
  };
  const gemini = {
    enabled: geminiEnabled,
    complete: jest.fn().mockResolvedValue(completion('gemini')),
  };
  const router = new AiProviderRouterService(
    openRouter as unknown as OpenRouterClientService,
    gemini as unknown as GeminiClientService,
  );
  const messages: ChatCompletionMessageParam[] = [
    { role: 'user', content: 'fixture prompt' },
  ];
  const call = () =>
    router.complete(messages, [], AbortSignal.timeout(1000), {
      requestId: 'fixture-request-id',
    });
  return { router, openRouter, gemini, messages, call };
}

describe('AiProviderRouterService', () => {
  it('keeps OpenRouter primary and never calls Gemini after success', async () => {
    const { call, openRouter, gemini } = fixture();
    await expect(call()).resolves.toMatchObject({ provider: 'openrouter' });
    await call();
    expect(openRouter.complete).toHaveBeenCalledTimes(2);
    expect(gemini.complete).not.toHaveBeenCalled();
  });

  it('does not switch providers after a successful tool round', async () => {
    const { call, openRouter, gemini } = fixture();
    await call();
    openRouter.complete.mockRejectedValueOnce(
      new AiProviderFailure(AiProviderFailureReason.RATE_LIMIT, 429),
    );
    await expect(call()).rejects.toMatchObject({
      reason: AiProviderFailureReason.RATE_LIMIT,
    });
    expect(gemini.complete).not.toHaveBeenCalled();
  });

  it('does not start Gemini after the request deadline has expired', async () => {
    const { router, openRouter, gemini, messages } = fixture();
    const controller = new AbortController();
    controller.abort();
    openRouter.complete.mockRejectedValueOnce(
      new AiProviderFailure(AiProviderFailureReason.TIMEOUT),
    );
    await expect(
      router.complete(messages, [], controller.signal),
    ).rejects.toMatchObject({ reason: AiProviderFailureReason.TIMEOUT });
    expect(gemini.complete).not.toHaveBeenCalled();
  });

  it.each([
    [AiProviderFailureReason.RATE_LIMIT, 429],
    [AiProviderFailureReason.UNAVAILABLE, 503],
    [AiProviderFailureReason.UNAVAILABLE, undefined],
    [AiProviderFailureReason.TIMEOUT, undefined],
  ])('falls back once for %s %s and pins Gemini', async (reason, status) => {
    const { call, openRouter, gemini } = fixture();
    openRouter.complete.mockRejectedValueOnce(
      new AiProviderFailure(reason, status),
    );
    await expect(call()).resolves.toMatchObject({ provider: 'gemini' });
    await call();
    expect(openRouter.complete).toHaveBeenCalledTimes(1);
    expect(gemini.complete).toHaveBeenCalledTimes(2);
  });

  it.each([
    [AiProviderFailureReason.AUTHENTICATION, 401],
    [AiProviderFailureReason.CREDITS, 402],
    [AiProviderFailureReason.INVALID_RESPONSE, undefined],
    [AiProviderFailureReason.UNAVAILABLE, 400],
  ])('does not fallback on non-eligible %s %s', async (reason, status) => {
    const { call, openRouter, gemini } = fixture();
    openRouter.complete.mockRejectedValueOnce(
      new AiProviderFailure(reason, status),
    );
    await expect(call()).rejects.toMatchObject({ reason, status });
    expect(gemini.complete).not.toHaveBeenCalled();
  });

  it('does not turn a local programming error into provider fallback', async () => {
    const { call, openRouter, gemini } = fixture();
    openRouter.complete.mockRejectedValueOnce(new TypeError('fixture'));
    await expect(call()).rejects.toBeInstanceOf(TypeError);
    expect(gemini.complete).not.toHaveBeenCalled();
  });

  it('returns sanitized provider failure when both providers fail', async () => {
    const { call, openRouter, gemini } = fixture();
    openRouter.complete.mockRejectedValueOnce(
      new AiProviderFailure(AiProviderFailureReason.RATE_LIMIT, 429),
    );
    gemini.complete.mockRejectedValueOnce(
      new AiProviderFailure(AiProviderFailureReason.UNAVAILABLE, 503),
    );
    await expect(call()).rejects.toMatchObject({
      reason: AiProviderFailureReason.UNAVAILABLE,
      status: 503,
    });
    expect(gemini.complete).toHaveBeenCalledTimes(1);
  });

  it('preserves OpenRouter-only, Gemini-only, and both-disabled modes', async () => {
    const onlyOpenRouter = fixture(true, false);
    await onlyOpenRouter.call();
    expect(onlyOpenRouter.gemini.complete).not.toHaveBeenCalled();
    const onlyGemini = fixture(false, true);
    await expect(onlyGemini.call()).resolves.toMatchObject({
      provider: 'gemini',
    });
    expect(onlyGemini.openRouter.complete).not.toHaveBeenCalled();
    expect(fixture(false, false).router.enabled).toBe(false);
  });

  it('logs only safe fallback metadata with correlation ID', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    try {
      const { call, openRouter } = fixture();
      openRouter.complete.mockRejectedValueOnce(
        new AiProviderFailure(AiProviderFailureReason.RATE_LIMIT, 429),
      );
      await call();
      const output = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
      expect(output).toContain('fixture-request-id');
      expect(output).toContain('rate_limit');
      expect(output).not.toContain('fixture prompt');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('logs only allowlisted structural validation diagnostics after Gemini fallback fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      const { call, openRouter, gemini } = fixture();
      openRouter.complete.mockRejectedValueOnce(
        new AiProviderFailure(AiProviderFailureReason.RATE_LIMIT, 429),
      );
      gemini.complete.mockRejectedValueOnce(
        new AiProviderFailure(
          AiProviderFailureReason.INVALID_RESPONSE,
          undefined,
          {
            code: 'missing_visible_output',
            finishReason: 'length',
            contentType: 'missing',
            toolCallCount: 0,
          },
        ),
      );
      await expect(call()).rejects.toMatchObject({
        reason: AiProviderFailureReason.INVALID_RESPONSE,
      });
      const output = JSON.stringify(warn.mock.calls);
      expect(output).toContain('missing_visible_output');
      expect(output).toContain('fixture-request-id');
      expect(output).not.toContain('fixture prompt');
      expect(output).not.toContain('thought_signature');
    } finally {
      warn.mockRestore();
    }
  });
});
