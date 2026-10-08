import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, MongooseError, Types } from 'mongoose';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { Role } from '../enums/roles.enum';
import {
  AiModelCompletion,
  AiModelRequestContext,
  AiProviderFailure,
  AiProviderFailureReason,
} from './ai-model-client';
import { AiService } from './ai.service';
import { AiProviderRouterService } from './ai-provider-router.service';
import { AiToolFailure } from './ai-tools.service';
import { GeminiClientService } from './gemini-client.service';
import { OpenRouterClientService } from './openrouter-client.service';

type Row = Record<string, unknown>;
const scalar = (value: unknown) =>
  value instanceof Types.ObjectId ? value.toHexString() : value;
function match(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or')
      return (expected as Row[]).some((entry) => match(row, entry));
    const actual = row[key];
    if (
      expected &&
      typeof expected === 'object' &&
      !(expected instanceof Types.ObjectId) &&
      !(expected instanceof Date)
    )
      return Object.entries(expected as Row).every(([operator, value]) => {
        if (operator === '$exists') return (actual !== undefined) === value;
        if (operator === '$gt') return Number(actual) > Number(value);
        if (operator === '$lte')
          return (
            scalar(actual) !== undefined && scalar(actual)! <= scalar(value)!
          );
        throw new Error(`unsupported ${operator}`);
      });
    return scalar(actual) === scalar(expected);
  });
}
class Query<T> implements PromiseLike<T> {
  constructor(private value: T) {}
  select() {
    return this;
  }
  sort(sort: Row) {
    if (Array.isArray(this.value))
      this.value.sort((left, right) => {
        for (const [key, direction] of Object.entries(sort)) {
          const a = scalar((left as Row)[key]) as string | number | Date;
          const b = scalar((right as Row)[key]) as string | number | Date;
          if (a !== b) return (a < b ? -1 : 1) * Number(direction);
        }
        return 0;
      });
    return this;
  }
  skip(count: number) {
    if (Array.isArray(this.value)) this.value = this.value.slice(count) as T;
    return this;
  }
  limit(count: number) {
    if (Array.isArray(this.value)) this.value = this.value.slice(0, count) as T;
    return this;
  }
  then<A = T, B = never>(
    fulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    rejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ) {
    return Promise.resolve(this.value).then(fulfilled, rejected);
  }
}
function model(rows: Row[]) {
  const update = (row: Row, value: Row) => {
    Object.assign(row, value.$set as Row | undefined);
    for (const [key, amount] of Object.entries((value.$inc as Row) ?? {}))
      row[key] = Number(row[key] ?? 0) + Number(amount);
    for (const key of Object.keys((value.$unset as Row) ?? {})) delete row[key];
  };
  return {
    countDocuments: jest.fn((filter: Row) =>
      Promise.resolve(rows.filter((row) => match(row, filter)).length),
    ),
    create: jest.fn(
      (
        input: Row | Row[],
        options?: { session?: unknown; ordered?: boolean },
      ) => {
        if (
          Array.isArray(input) &&
          input.length > 1 &&
          options?.session &&
          !options.ordered
        )
          return Promise.reject(
            new MongooseError(
              'Multiple documents with a session require ordered writes',
            ),
          );
        const now = new Date();
        const created = (Array.isArray(input) ? input : [input]).map(
          (value) => ({
            _id: value._id ?? new Types.ObjectId(),
            createdAt: value.createdAt ?? now,
            updatedAt: value.updatedAt ?? now,
            ...value,
          }),
        );
        rows.push(...created);
        return Promise.resolve(Array.isArray(input) ? created : created[0]);
      },
    ),
    find: jest.fn(
      (filter: Row) =>
        new Query(rows.filter((row) => match(row, filter)).map((row) => row)),
    ),
    findOne: jest.fn(
      (filter: Row) =>
        new Query(rows.find((row) => match(row, filter)) ?? null),
    ),
    exists: jest.fn(
      (filter: Row) => new Query(rows.some((row) => match(row, filter))),
    ),
    findOneAndUpdate: jest.fn((filter: Row, value: Row) => {
      const row = rows.find((entry) => match(entry, filter));
      if (row) {
        update(row, value);
        row.updatedAt = new Date();
      }
      return new Query(row ?? null);
    }),
    updateOne: jest.fn((filter: Row, value: Row) => {
      const row = rows.find((entry) => match(entry, filter));
      if (row) update(row, value);
      return Promise.resolve({ modifiedCount: row ? 1 : 0 });
    }),
    deleteOne: jest.fn((filter: Row) => {
      const index = rows.findIndex((row) => match(row, filter));
      if (index >= 0) rows.splice(index, 1);
      return Promise.resolve({ deletedCount: index >= 0 ? 1 : 0 });
    }),
    findOneAndDelete: jest.fn((filter: Row) => {
      const index = rows.findIndex((row) => match(row, filter));
      return Promise.resolve(index >= 0 ? rows.splice(index, 1)[0] : null);
    }),
    deleteMany: jest.fn((filter: Row) => {
      const matches = rows.filter((row) => match(row, filter));
      for (const row of matches) rows.splice(rows.indexOf(row), 1);
      return Promise.resolve({ deletedCount: matches.length });
    }),
  };
}
const answer = (
  content = 'A useful general answer',
  modelName = 'provider/model',
): AiModelCompletion => ({
  message: { role: 'assistant', content, refusal: null },
  model: modelName,
  promptTokens: 10,
  completionTokens: 4,
  totalTokens: 14,
  providerCostUsdMicros: 7,
});

function fixture(overrides: Record<string, unknown> = {}) {
  const conversations: Row[] = [];
  const messages: Row[] = [];
  const usages: Row[] = [];
  const conversationModel = model(conversations);
  const messageModel = model(messages);
  const usageModel = model(usages);
  const values: Record<string, unknown> = {
    AI_MAX_MESSAGE_CHARS: 100,
    AI_MAX_HISTORY_MESSAGES: 4,
    AI_MAX_CONTEXT_CHARS: 200,
    AI_MAX_CONVERSATION_MESSAGES: 6,
    AI_MAX_CONVERSATIONS_PER_USER: 2,
    OPENROUTER_MAX_TOOL_ITERATIONS: 2,
    OPENROUTER_TIMEOUT_MS: 5000,
    OPENROUTER_ENABLED: true,
    GEMINI_ENABLED: false,
    ...overrides,
  };
  const complete = jest
    .fn<
      Promise<AiModelCompletion>,
      [
        ChatCompletionMessageParam[],
        ChatCompletionTool[],
        AbortSignal,
        AiModelRequestContext?,
      ]
    >()
    .mockResolvedValue(answer());
  const client = { enabled: true, complete };
  const tools = {
    definitions: [{ type: 'function', function: { name: 'fixture' } }],
    execute: jest.fn().mockResolvedValue({ safe: 'authoritative' }),
    fingerprint: jest.fn(
      (name: string, args: string) =>
        `${name}:${JSON.stringify(JSON.parse(args))}`,
    ),
  };
  const connection = {
    transaction: jest.fn((work: (session: object) => unknown) =>
      Promise.resolve().then(() => work({ fixture: true })),
    ),
  };
  const service = new AiService(
    conversationModel as never,
    messageModel as never,
    usageModel as never,
    connection as unknown as Connection,
    client,
    tools as never,
    {
      getOrThrow: (key: string) => values[key],
      get: (key: string) => values[key],
    } as ConfigService,
  );
  const actor = {
    id: new Types.ObjectId().toHexString(),
    companyId: new Types.ObjectId().toHexString(),
    role: Role.COMPANY_OWNER,
  };
  return {
    service,
    actor,
    client,
    complete,
    tools,
    conversations,
    messages,
    usages,
    conversationModel,
    messageModel,
    usageModel,
    connection,
  };
}

describe('AiService', () => {
  it('persists a general-purpose answer, bounded metadata, and authoritative usage', async () => {
    const f = fixture();
    const result = await f.service.chat(f.actor, {
      message: 'Explain dependency injection',
    });
    expect(result).toMatchObject({
      conversation: { title: 'Explain dependency injection', messageCount: 2 },
      messages: [
        { role: 'user', content: 'Explain dependency injection' },
        { role: 'assistant', content: 'A useful general answer' },
      ],
      usage: {
        model: 'provider/model',
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
        providerCostUsdMicros: 7,
        toolCallCount: 0,
      },
    });
    expect(f.complete.mock.calls[0][0][0]).toMatchObject({ role: 'system' });
    expect(f.usages).toHaveLength(1);
    expect(JSON.stringify(f.usages[0])).not.toContain(
      'Explain dependency injection',
    );
  });

  it('serializes multi-document message creation inside the transaction session', async () => {
    const f = fixture();

    await expect(
      f.service.chat(f.actor, { message: 'Persist this exchange' }),
    ).resolves.toMatchObject({ conversation: { messageCount: 2 } });

    expect(f.messageModel.create).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
      ]),
      { session: { fixture: true }, ordered: true },
    );
    expect(f.messages).toHaveLength(2);
    expect(f.usages).toHaveLength(1);
  });

  it('continues multi-turn context while keeping ownership tenant- and user-scoped', async () => {
    const f = fixture();
    const first = await f.service.chat(f.actor, { message: 'First question' });
    f.complete.mockResolvedValueOnce(answer('Second answer'));
    await f.service.chat(f.actor, {
      conversationId: String(first.conversation.id),
      message: 'Follow-up',
    });
    expect(f.complete.mock.calls[1][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'First question' }),
        expect.objectContaining({
          role: 'assistant',
          content: 'A useful general answer',
        }),
        expect.objectContaining({ role: 'user', content: 'Follow-up' }),
      ]),
    );
    const other = { ...f.actor, id: new Types.ObjectId().toHexString() };
    await expect(
      f.service.get(other, String(first.conversation.id)),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      f.service.chat(other, {
        conversationId: String(first.conversation.id),
        message: 'steal it',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('bounds persisted context by both recent-message count and characters', async () => {
    const f = fixture({
      AI_MAX_MESSAGE_CHARS: 10,
      AI_MAX_HISTORY_MESSAGES: 4,
      AI_MAX_CONTEXT_CHARS: 10,
    });
    const conversationId = new Types.ObjectId();
    f.conversations.push({
      _id: conversationId,
      companyId: f.actor.companyId,
      userId: f.actor.id,
      title: 'bounded',
      messageCount: 4,
    });
    for (const [index, content] of ['oldest', 'older!', 'newest'].entries())
      f.messages.push({
        _id: new Types.ObjectId(),
        conversationId,
        companyId: f.actor.companyId,
        userId: f.actor.id,
        role: index % 2 ? 'assistant' : 'user',
        content,
        createdAt: new Date(index),
      });
    await f.service.chat(f.actor, {
      conversationId: conversationId.toHexString(),
      message: 'current',
    });
    const supplied = f.complete.mock.calls[0][0];
    expect(supplied).toEqual([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({ content: 'newest' }),
      { role: 'user', content: 'current' },
    ]);
  });

  it('hard-deletes owned conversation content while retaining content-free usage', async () => {
    const f = fixture();
    const result = await f.service.chat(f.actor, { message: 'Temporary' });
    await expect(
      f.service.delete(f.actor, String(result.conversation.id)),
    ).resolves.toEqual({ message: 'Conversation deleted' });
    expect(f.conversations).toHaveLength(0);
    expect(f.messages).toHaveLength(0);
    expect(f.usages).toHaveLength(1);
  });

  it('executes controlled tools as the authenticated actor and aggregates rounds', async () => {
    const f = fixture();
    f.complete
      .mockResolvedValueOnce({
        ...answer('', 'provider/primary'),
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'get_company_statistics', arguments: '{}' },
            },
          ],
        },
      })
      .mockResolvedValueOnce(
        answer('You have authoritative data.', 'provider/fallback'),
      );
    const result = await f.service.chat(f.actor, {
      message: 'How are we doing?',
    });
    expect(f.tools.execute).toHaveBeenCalledWith(
      f.actor,
      'get_company_statistics',
      '{}',
    );
    expect(f.complete.mock.calls[1][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          content: '{"safe":"authoritative"}',
        }),
      ]),
    );
    expect(result.usage).toMatchObject({
      promptTokens: 20,
      completionTokens: 8,
      totalTokens: 28,
      providerCostUsdMicros: 14,
      toolCallCount: 1,
      model: 'provider/fallback',
    });
  });

  it('persists exactly one exchange after Gemini fallback and retains multi-turn context', async () => {
    const f = fixture({ GEMINI_ENABLED: true, GEMINI_TIMEOUT_MS: 5000 });
    const primary = {
      enabled: true,
      complete: jest
        .fn()
        .mockRejectedValue(
          new AiProviderFailure(AiProviderFailureReason.RATE_LIMIT, 429),
        ),
    };
    const gemini = {
      enabled: true,
      complete: jest
        .fn()
        .mockResolvedValueOnce({
          ...answer('', 'gemini-3.5-flash-lite'),
          provider: 'gemini',
          providerCostUsdMicros: undefined,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'gemini-call-1',
                type: 'function',
                function: { name: 'get_company_statistics', arguments: '{}' },
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          ...answer('You have 12 uploads left.', 'gemini-3.5-flash-lite'),
          provider: 'gemini',
          providerCostUsdMicros: undefined,
        })
        .mockResolvedValueOnce({
          ...answer('The quota resets next period.', 'gemini-3.5-flash-lite'),
          provider: 'gemini',
          providerCostUsdMicros: undefined,
        }),
    };
    const router = new AiProviderRouterService(
      primary as unknown as OpenRouterClientService,
      gemini as unknown as GeminiClientService,
    );
    f.complete.mockImplementation((messages, tools, signal, context) =>
      router.complete(messages, tools, signal, context),
    );

    const first = await f.service.chat(f.actor, {
      message: 'How many uploads remain?',
    });
    expect(f.tools.execute).toHaveBeenCalledWith(
      f.actor,
      'get_company_statistics',
      '{}',
    );
    expect(first.usage).toMatchObject({
      model: 'gemini-3.5-flash-lite',
      totalTokens: 28,
      toolCallCount: 1,
    });
    expect(f.usages[0]).toMatchObject({
      provider: 'gemini',
      modelId: 'gemini-3.5-flash-lite',
    });
    expect(f.usages[0].providerCostUsdMicros).toBeUndefined();
    expect(f.messages).toHaveLength(2);
    const second = await f.service.chat(f.actor, {
      conversationId: String(first.conversation.id),
      message: 'When does it reset?',
    });
    expect(second.usage.model).toBe('gemini-3.5-flash-lite');
    expect(primary.complete).toHaveBeenCalledTimes(2);
    expect(gemini.complete).toHaveBeenCalledTimes(3);
    const geminiCalls: unknown = gemini.complete.mock.calls;
    expect((geminiCalls as unknown[][])[2][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'You have 12 uploads left.',
        }),
      ]),
    );
    expect(f.messages).toHaveLength(4);
    expect(f.usages).toHaveLength(2);
  });

  it('runs the complete Gemini tool continuation with only documented wire fields', async () => {
    const f = fixture({ GEMINI_ENABLED: true, GEMINI_TIMEOUT_MS: 5000 });
    const gemini = new GeminiClientService({
      get: (key: string) =>
        (({ GEMINI_ENABLED: true }) as Record<string, unknown>)[key],
      getOrThrow: (key: string) =>
        (
          ({
            GEMINI_API_KEY: 'fixture-key-not-for-network',
            GEMINI_MODEL: 'gemini-3.5-flash-lite',
            GEMINI_TIMEOUT_MS: 5000,
            GEMINI_MAX_OUTPUT_TOKENS: 1024,
          }) as Record<string, unknown>
        )[key],
    } as ConfigService);
    const signature = 'opaque-signature-fixture';
    const create = jest
      .fn()
      .mockResolvedValueOnce({
        model: 'gemini-3.5-flash-lite',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              refusal: null,
              reasoning_content: 'internal-provider-only-fixture',
              tool_calls: [
                {
                  id: 'gemini-call-1',
                  type: 'function',
                  function: { name: 'get_company_statistics', arguments: '{}' },
                  extra_content: { google: { thought_signature: signature } },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      })
      .mockResolvedValueOnce({
        model: 'gemini-3.5-flash-lite',
        choices: [
          { message: { role: 'assistant', content: '12 uploads remain.' } },
        ],
        usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
      });
    (gemini as unknown as { client: unknown }).client = {
      chat: { completions: { create } },
    };
    const primary = {
      enabled: true,
      complete: jest
        .fn()
        .mockRejectedValue(
          new AiProviderFailure(AiProviderFailureReason.RATE_LIMIT, 429),
        ),
    };
    const router = new AiProviderRouterService(
      primary as unknown as OpenRouterClientService,
      gemini,
    );
    f.complete.mockImplementation((messages, tools, signal, context) =>
      router.complete(messages, tools, signal, context),
    );

    const result = await f.service.chat(f.actor, {
      message: 'How many uploads remain?',
    });
    expect(result.usage).toMatchObject({
      model: 'gemini-3.5-flash-lite',
      promptTokens: 30,
      completionTokens: 14,
      totalTokens: 44,
      toolCallCount: 1,
    });
    expect(primary.complete).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(f.tools.execute).toHaveBeenCalledWith(
      f.actor,
      'get_company_statistics',
      '{}',
    );
    const recorded: unknown = create.mock.calls;
    const continuation = (recorded as Array<Array<{ messages: unknown }>>)[1][0]
      .messages as Array<Record<string, unknown>>;
    expect(continuation.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    expect(continuation[2]).toEqual({
      role: 'assistant',
      tool_calls: [
        {
          id: 'gemini-call-1',
          type: 'function',
          function: { name: 'get_company_statistics', arguments: '{}' },
          extra_content: { google: { thought_signature: signature } },
        },
      ],
    });
    expect(continuation[3]).toEqual({
      role: 'tool',
      name: 'get_company_statistics',
      tool_call_id: 'gemini-call-1',
      content: '{"safe":"authoritative"}',
    });
    expect(JSON.stringify(continuation)).not.toContain(
      'internal-provider-only-fixture',
    );
    expect(f.messages).toHaveLength(2);
    expect(f.usages).toHaveLength(1);
  });

  it('rejects repeated, invalid, or excessive tool calls without persisting prompts', async () => {
    const toolAnswer = {
      ...answer(),
      message: {
        role: 'assistant' as const,
        content: null,
        refusal: null,
        tool_calls: [
          {
            id: 'call',
            type: 'function' as const,
            function: { name: 'fixture', arguments: '{}' },
          },
        ],
      },
    };
    const f = fixture();
    f.complete.mockResolvedValue(toolAnswer);
    await expect(
      f.service.chat(f.actor, { message: 'Repeat forever' }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(f.conversations).toHaveLength(0);
    expect(f.messages).toHaveLength(0);
    expect(f.usages).toHaveLength(0);
    const invalid = fixture();
    invalid.tools.execute.mockRejectedValue(new AiToolFailure());
    invalid.complete.mockResolvedValueOnce(toolAnswer);
    await expect(
      invalid.service.chat(invalid.actor, { message: 'Inject another tenant' }),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('enforces disabled, prompt, conversation, and per-conversation bounds', async () => {
    const disabled = fixture();
    disabled.client.enabled = false;
    await expect(
      disabled.service.chat(disabled.actor, { message: 'hello' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const f = fixture();
    await expect(
      f.service.chat(f.actor, { message: 'x'.repeat(101) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    f.conversations.push(
      ...[0, 1].map(() => ({
        _id: new Types.ObjectId(),
        companyId: f.actor.companyId,
        userId: f.actor.id,
        title: 'full',
        messageCount: 2,
      })),
    );
    await expect(
      f.service.chat(f.actor, { message: 'one too many' }),
    ).rejects.toBeInstanceOf(ConflictException);
    f.conversations.splice(0);
    const fullId = new Types.ObjectId();
    f.conversations.push({
      _id: fullId,
      companyId: f.actor.companyId,
      userId: f.actor.id,
      title: 'full',
      messageCount: 6,
    });
    await expect(
      f.service.chat(f.actor, {
        conversationId: fullId.toHexString(),
        message: 'too late',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    [AiProviderFailureReason.TIMEOUT, GatewayTimeoutException],
    [AiProviderFailureReason.INVALID_RESPONSE, BadGatewayException],
    [AiProviderFailureReason.AUTHENTICATION, ServiceUnavailableException],
    [AiProviderFailureReason.CREDITS, ServiceUnavailableException],
    [AiProviderFailureReason.RATE_LIMIT, ServiceUnavailableException],
    [AiProviderFailureReason.UNAVAILABLE, ServiceUnavailableException],
  ])(
    'maps %s failures to safe API errors and sanitized logs',
    async (reason, type) => {
      const f = fixture();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      f.complete.mockRejectedValue(
        Object.assign(new AiProviderFailure(reason, 500), {
          providerSecret: 'must-not-log',
        }),
      );
      await expect(
        f.service.chat(f.actor, { message: 'private prompt' }),
      ).rejects.toBeInstanceOf(type);
      const logs = JSON.stringify(warn.mock.calls);
      expect(logs).toContain(reason);
      expect(logs).not.toMatch(/private prompt|must-not-log/);
      warn.mockRestore();
    },
  );

  it('correlates and sanitizes unexpected conversation setup failures', async () => {
    const f = fixture();
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    f.conversationModel.countDocuments.mockRejectedValueOnce(
      Object.assign(new TypeError('private prompt and database details'), {
        password: 'must-not-log',
      }),
    );

    let failure: unknown;
    try {
      await f.service.chat(f.actor, { message: 'private setup prompt' });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(InternalServerErrorException);
    const response = (
      failure as InternalServerErrorException
    ).getResponse() as {
      code?: unknown;
      requestId?: unknown;
    };
    expect(response.code).toBe('ai_internal_error');
    expect(typeof response.requestId).toBe('string');
    const logs = JSON.stringify(logged.mock.calls);
    expect(logs).toContain(response.requestId as string);
    expect(logs).toMatch(/conversation_create.*database.*TypeError/);
    expect(logs).not.toMatch(
      /private setup prompt|private prompt|database details|must-not-log/,
    );
    logged.mockRestore();
  });

  it('rejects invalid runtime model-client values as typed provider responses', async () => {
    const f = fixture();
    f.complete.mockResolvedValueOnce(null as never);
    let failure: unknown;
    try {
      await f.service.chat(f.actor, { message: 'private prompt' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BadGatewayException);
    expect((failure as BadGatewayException).getResponse()).toEqual({
      message: 'AI assistant returned an invalid response',
      code: 'ai_invalid_response',
    });
    expect(f.conversations).toHaveLength(0);
  });

  it.each([
    [
      'tool_execution',
      () => Promise.reject(new Error('private tool database failure')),
    ],
    ['tool_result_serialization', () => Promise.resolve({ unsafe: BigInt(1) })],
  ])(
    'sanitizes unexpected internal %s failures without misclassifying them as model errors',
    async (stage, implementation) => {
      const f = fixture();
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      f.complete.mockResolvedValueOnce({
        ...answer(''),
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'fixture', arguments: '{}' },
            },
          ],
        },
      });
      f.tools.execute.mockImplementationOnce(implementation);

      await expect(
        f.service.chat(f.actor, { message: 'private tool prompt' }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      const logs = JSON.stringify(logged.mock.calls);
      expect(logs).toContain(stage);
      expect(logs).toContain('tool_backend');
      expect(logs).not.toMatch(
        /private tool prompt|private tool database failure|must-not-log/,
      );
      expect(f.conversations).toHaveLength(0);
      logged.mockRestore();
    },
  );

  it('identifies transaction failures without logging raw database errors', async () => {
    const f = fixture();
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    f.connection.transaction.mockRejectedValueOnce(
      Object.assign(new Error('mongodb://private-host/private-database'), {
        name: 'MongoServerError',
      }),
    );

    await expect(
      f.service.chat(f.actor, { message: 'private persistence prompt' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    const logs = JSON.stringify(logged.mock.calls);
    expect(logs).toMatch(/persistence_transaction.*database.*MongoServerError/);
    expect(logs).not.toMatch(
      /mongodb:\/\/|private-host|private-database|private persistence prompt/,
    );
    expect(f.conversations).toHaveLength(0);
    expect(f.messages).toHaveLength(0);
    expect(f.usages).toHaveLength(0);
    logged.mockRestore();
  });

  it('fails closed on invalid stored history and logs only data-integrity metadata', async () => {
    const f = fixture();
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const conversationId = new Types.ObjectId();
    f.conversations.push({
      _id: conversationId,
      companyId: f.actor.companyId,
      userId: f.actor.id,
      title: 'fixture',
      messageCount: 2,
    });
    f.messages.push({
      _id: new Types.ObjectId(),
      conversationId,
      companyId: f.actor.companyId,
      userId: f.actor.id,
      role: 'user',
      content: null,
      createdAt: new Date(),
    });

    await expect(
      f.service.chat(f.actor, {
        conversationId: conversationId.toHexString(),
        message: 'private follow-up',
      }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    const logs = JSON.stringify(logged.mock.calls);
    expect(logs).toMatch(
      /history_validation.*data_integrity.*InvalidStoredMessage/,
    );
    expect(logs).not.toContain('private follow-up');
    logged.mockRestore();
  });

  it('keeps the primary provider error while reporting cleanup failures safely', async () => {
    const f = fixture();
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    f.complete.mockRejectedValueOnce(
      new AiProviderFailure(AiProviderFailureReason.RATE_LIMIT, 429),
    );
    f.conversationModel.deleteOne.mockRejectedValueOnce(
      Object.assign(new Error('private cleanup database address'), {
        name: 'MongoNetworkError',
      }),
    );

    await expect(
      f.service.chat(f.actor, { message: 'private cleanup prompt' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const logs = JSON.stringify(logged.mock.calls);
    expect(logs).toMatch(/conversation_cleanup.*database.*MongoNetworkError/);
    expect(logs).not.toMatch(
      /private cleanup prompt|private cleanup database address/,
    );
    logged.mockRestore();
  });
});
