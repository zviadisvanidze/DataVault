import { ConfigService } from '@nestjs/config';
import { APIConnectionTimeoutError, APIError } from 'openai';
import { AiProviderFailure, AiProviderFailureReason } from './ai-model-client';
import { OpenRouterClientService } from './openrouter-client.service';

function fixture(enabled = true) {
  const values: Record<string, unknown> = {
    OPENROUTER_ENABLED: enabled,
    OPENROUTER_API_KEY: `sk-or-v1-${'x'.repeat(48)}`,
    OPENROUTER_MODEL: 'provider/primary-tool-model',
    OPENROUTER_FALLBACK_MODELS: ['provider/fallback-tool-model'],
    OPENROUTER_MAX_OUTPUT_TOKENS: 700,
    OPENROUTER_TIMEOUT_MS: 10000,
    OPENROUTER_REQUIRE_ZDR: true,
  };
  const config = {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) throw new Error(`missing ${key}`);
      return values[key];
    }),
  } as unknown as ConfigService;
  const service = new OpenRouterClientService(config);
  const create = jest.fn();
  if (enabled)
    (service as unknown as { client: unknown }).client = {
      chat: { completions: { create } },
    };
  return { service, create, values };
}

describe('OpenRouterClientService', () => {
  const messages = [{ role: 'user' as const, content: 'safe fixture prompt' }];
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: 'safe_tool',
        description: 'fixture',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];

  it('uses server-controlled fallbacks, tool settings, privacy controls, and provider usage', async () => {
    const { service, create, values } = fixture();
    create.mockResolvedValue({
      model: 'provider/fallback-tool-model',
      choices: [{ message: { role: 'assistant', content: 'answer' } }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 4,
        total_tokens: 15,
        cost: '0.000012',
      },
    });
    const signal = AbortSignal.timeout(1000);
    await expect(service.complete(messages, tools, signal)).resolves.toEqual({
      message: { role: 'assistant', content: 'answer' },
      model: 'provider/fallback-tool-model',
      promptTokens: 11,
      completionTokens: 4,
      totalTokens: 15,
      providerCostUsdMicros: 12,
      provider: 'openrouter',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: values.OPENROUTER_MODEL,
        models: [values.OPENROUTER_MODEL, 'provider/fallback-tool-model'],
        messages,
        tools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        max_completion_tokens: 700,
        usage: { include: true },
        provider: { data_collection: 'deny', zdr: true },
      }),
      { signal },
    );
    expect(JSON.stringify(create.mock.calls)).not.toContain(
      values.OPENROUTER_API_KEY as string,
    );
  });

  it('fails closed when disabled or the response is malformed', async () => {
    const disabled = fixture(false).service;
    await expect(
      disabled.complete(messages, tools, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ reason: AiProviderFailureReason.UNAVAILABLE });
    const { service, create } = fixture();
    create.mockResolvedValue({ choices: [] });
    await expect(
      service.complete(messages, tools, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({
      reason: AiProviderFailureReason.INVALID_RESPONSE,
    });
  });

  it('rejects non-string assistant content as an invalid provider response', async () => {
    const { service, create } = fixture();
    create.mockResolvedValue({
      model: 'provider/primary-tool-model',
      choices: [
        {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'unexpected content shape' }],
          },
        },
      ],
    });
    await expect(
      service.complete(messages, tools, AbortSignal.timeout(1000)),
    ).rejects.toEqual(
      new AiProviderFailure(AiProviderFailureReason.INVALID_RESPONSE),
    );
  });

  it('rejects a non-object provider response as invalid', async () => {
    const { service, create } = fixture();
    create.mockResolvedValue(null);
    await expect(
      service.complete(messages, tools, AbortSignal.timeout(1000)),
    ).rejects.toEqual(
      new AiProviderFailure(AiProviderFailureReason.INVALID_RESPONSE),
    );
  });

  it.each([
    [
      'non-array tool_calls',
      { role: 'assistant', content: null, tool_calls: {} },
    ],
    [
      'missing function payload',
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function' }],
      },
    ],
    [
      'non-string arguments',
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'safe_tool', arguments: {} },
          },
        ],
      },
    ],
  ])('rejects malformed provider tool calls: %s', async (_label, message) => {
    const { service, create } = fixture();
    create.mockResolvedValue({
      model: 'provider/primary-tool-model',
      choices: [{ message }],
    });
    await expect(
      service.complete(messages, tools, AbortSignal.timeout(1000)),
    ).rejects.toEqual(
      new AiProviderFailure(AiProviderFailureReason.INVALID_RESPONSE),
    );
  });

  it('accepts a structurally valid function tool call response', async () => {
    const { service, create } = fixture();
    const message = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'safe_tool', arguments: '{}' },
        },
      ],
    };
    create.mockResolvedValue({
      model: 'provider/primary-tool-model',
      choices: [{ message }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    await expect(
      service.complete(messages, tools, AbortSignal.timeout(1000)),
    ).resolves.toMatchObject({ message, model: 'provider/primary-tool-model' });
  });

  it.each([
    [401, AiProviderFailureReason.AUTHENTICATION],
    [402, AiProviderFailureReason.CREDITS],
    [429, AiProviderFailureReason.RATE_LIMIT],
    [500, AiProviderFailureReason.UNAVAILABLE],
  ])('sanitizes provider HTTP %i failures', async (status, reason) => {
    const { service, create } = fixture();
    create.mockRejectedValue(
      APIError.generate(
        status,
        { error: { message: 'provider-private-message' } },
        'provider-private-message',
        new Headers(),
      ),
    );
    await expect(
      service.complete(messages, tools, AbortSignal.timeout(1000)),
    ).rejects.toEqual(new AiProviderFailure(reason, status));
  });

  it('maps SDK timeout failures without exposing their details', async () => {
    const { service, create } = fixture();
    create.mockRejectedValue(new APIConnectionTimeoutError());
    await expect(
      service.complete(messages, tools, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ reason: AiProviderFailureReason.TIMEOUT });
  });

  it('does not misclassify local programming errors as provider unavailability', async () => {
    const { service, create } = fixture();
    create.mockRejectedValue(new TypeError('fixture internal failure'));
    await expect(
      service.complete(messages, tools, AbortSignal.timeout(1000)),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
