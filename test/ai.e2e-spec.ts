import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AI_MODEL_CLIENT, AiModelCompletion } from '../src/ai/ai-model-client';
import { ObjectStorage } from '../src/aws-s3/object-storage';
import { configureApp } from '../src/config/configure-app';
import { EmailSender } from '../src/email/email-sender';
import { StripeClientService } from '../src/payments/stripe-client.service';
import { adminFixture } from './admin.fixture';

describe('tenant AI assistant (e2e, mocked OpenRouter)', () => {
  interface ChatBody {
    conversation: { id: string; messageCount: number };
    messages: { role: string; content: string }[];
    usage: { model: string; totalTokens: number };
  }
  let app: INestApplication<App>;
  let f: Awaited<ReturnType<typeof adminFixture>>;
  let ownerToken: string;
  let memberToken: string;
  let otherOwnerToken: string;
  let inactiveOwnerToken: string;
  let platformToken: string;
  const complete = jest.fn<
    Promise<AiModelCompletion>,
    [ChatCompletionMessageParam[], ChatCompletionTool[], AbortSignal]
  >();
  const modelClient = { enabled: true, complete };
  const storage = {
    putObject: jest.fn(),
    getObject: jest.fn(),
    deleteObject: jest.fn(),
  };
  const response = (content: string): AiModelCompletion => ({
    message: { role: 'assistant', content, refusal: null },
    model: 'provider/tool-model',
    promptTokens: 12,
    completionTokens: 5,
    totalTokens: 17,
    providerCostUsdMicros: 9,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    modelClient.enabled = true;
    f = await adminFixture();
    const config = {
      NODE_ENV: 'test',
      FILE_MAX_SIZE_BYTES: 10485760,
      OPENROUTER_ENABLED: true,
      OPENROUTER_API_KEY: `sk-or-v1-${'x'.repeat(48)}`,
      OPENROUTER_MODEL: 'provider/tool-model',
      OPENROUTER_FALLBACK_MODELS: [],
      OPENROUTER_MAX_OUTPUT_TOKENS: 500,
      OPENROUTER_MAX_TOOL_ITERATIONS: 3,
      OPENROUTER_TIMEOUT_MS: 10000,
      OPENROUTER_REQUIRE_ZDR: false,
      AI_MAX_MESSAGE_CHARS: 200,
      AI_MAX_HISTORY_MESSAGES: 10,
      AI_MAX_CONTEXT_CHARS: 1000,
      AI_MAX_CONVERSATION_MESSAGES: 20,
      AI_MAX_CONVERSATIONS_PER_USER: 10,
      AI_RATE_LIMIT_PER_MINUTE: 2,
    };
    for (const [key, value] of Object.entries(config)) f.config.set(key, value);
    complete.mockResolvedValue(response('General answer'));
    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(f.config)
      .overrideProvider(getConnectionToken())
      .useValue({
        ...f.connection,
        close: jest.fn(),
        readyState: 1,
        db: { admin: () => ({ ping: jest.fn().mockResolvedValue({ ok: 1 }) }) },
      })
      .overrideProvider(getModelToken('companyVerification'))
      .useValue({})
      .overrideProvider(getModelToken('adminAccessRequest'))
      .useValue({})
      .overrideProvider(getModelToken('googleOAuthState'))
      .useValue({})
      .overrideProvider(getModelToken('googleOAuthExchange'))
      .useValue({})
      .overrideProvider(getModelToken('plan'))
      .useValue({ bulkWrite: jest.fn() })
      .overrideProvider(getModelToken('stripeEvent'))
      .useValue({})
      .overrideProvider(getModelToken('stripeUsage'))
      .useValue({})
      .overrideProvider(StripeClientService)
      .useValue({ enabled: true, api: {} })
      .overrideProvider(ObjectStorage)
      .useValue(storage)
      .overrideProvider(EmailSender)
      .useValue({ send: jest.fn() })
      .overrideProvider(AI_MODEL_CLIENT)
      .useValue(modelClient);
    for (const [name, model] of Object.entries(f.models))
      builder.overrideProvider(getModelToken(name)).useValue(model);
    const module = await builder.compile();
    app = module.createNestApplication<INestApplication<App>>({
      logger: false,
    });
    configureApp(app);
    await app.init();
    ownerToken = f.tenantJwt.sign({
      id: (f.users[1]._id as Types.ObjectId).toHexString(),
    });
    memberToken = f.tenantJwt.sign({
      id: (f.users[3]._id as Types.ObjectId).toHexString(),
    });
    otherOwnerToken = f.tenantJwt.sign({
      id: (f.users[0]._id as Types.ObjectId).toHexString(),
    });
    inactiveOwnerToken = f.tenantJwt.sign({
      id: (f.users[2]._id as Types.ObjectId).toHexString(),
    });
    platformToken = f.jwt.sign({
      sub: f.adminId.toHexString(),
      type: 'platform_admin',
    });
  });

  afterEach(async () => app?.close());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('supports general multi-turn conversations for owners and members', async () => {
    const created = await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth(ownerToken))
      .send({ message: 'Explain dependency injection.' })
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    const createdBody = created.body as ChatBody;
    expect(createdBody).toMatchObject({
      conversation: { messageCount: 2 },
      messages: [
        { role: 'user', content: 'Explain dependency injection.' },
        { role: 'assistant', content: 'General answer' },
      ],
      usage: { model: 'provider/tool-model', totalTokens: 17 },
    });
    const id = createdBody.conversation.id;
    complete.mockResolvedValueOnce(response('Context-aware follow-up'));
    const followUp = await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth(ownerToken))
      .send({ conversationId: id, message: 'Give an example.' })
      .expect(200);
    expect((followUp.body as ChatBody).conversation.messageCount).toBe(4);
    expect(complete.mock.calls[1][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'Explain dependency injection.',
        }),
        expect.objectContaining({
          role: 'assistant',
          content: 'General answer',
        }),
      ]),
    );
    const list = await request(app.getHttpServer())
      .get('/ai/conversations')
      .set(auth(ownerToken))
      .expect(200);
    expect((list.body as { total: number }).total).toBe(1);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth(memberToken))
      .send({ message: 'Help me brainstorm.' })
      .expect(200);
  });

  it('enforces user and tenant ownership with non-enumerating responses and deletion', async () => {
    const created = await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth(ownerToken))
      .send({ message: 'Private owner conversation' })
      .expect(200);
    const id = (created.body as ChatBody).conversation.id;
    for (const token of [memberToken, otherOwnerToken]) {
      await request(app.getHttpServer())
        .get(`/ai/conversations/${id}`)
        .set(auth(token))
        .expect(404);
      await request(app.getHttpServer())
        .delete(`/ai/conversations/${id}`)
        .set(auth(token))
        .expect(404);
    }
    await request(app.getHttpServer())
      .delete(`/ai/conversations/${id}`)
      .set(auth(ownerToken))
      .expect(200);
    await request(app.getHttpServer())
      .get(`/ai/conversations/${id}`)
      .set(auth(ownerToken))
      .expect(404);
    expect(f.aiusages).toHaveLength(1);
    expect(JSON.stringify(f.aiusages)).not.toContain(
      'Private owner conversation',
    );
  });

  it('uses existing file visibility and never sends storage or identity metadata', async () => {
    complete
      .mockResolvedValueOnce({
        ...response(''),
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: 'files-1',
              type: 'function',
              function: {
                name: 'list_visible_files',
                arguments: '{"limit":10}',
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce(response('You can see two files.'));
    await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth(memberToken))
      .send({ message: 'Which files can I see?' })
      .expect(200);
    const providerContext = JSON.stringify(complete.mock.calls[1][0]);
    expect(providerContext).toContain('sheet1.csv');
    expect(providerContext).toContain('sheet2.csv');
    expect(providerContext).not.toMatch(
      /hidden-storage-key|storageKey|companyId|uploaderId|restrictedUserIds/,
    );
  });

  it('rejects platform tokens, inactive tenants, missing auth, and injected client fields', async () => {
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'hello' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth(platformToken))
      .send({ message: 'hello' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth(inactiveOwnerToken))
      .send({ message: 'hello' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth(ownerToken))
      .send({
        message: 'hello',
        companyId: (f.companies[0]._id as Types.ObjectId).toHexString(),
        model: 'unapproved/model',
        totalTokens: 0,
      })
      .expect(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it('fails closed with a stable error when AI is disabled', async () => {
    modelClient.enabled = false;
    const response = await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth(ownerToken))
      .send({ message: 'hello' })
      .expect(503);
    expect((response.body as { code: string }).code).toBe('ai_disabled');
    expect(complete).not.toHaveBeenCalled();
    expect(f.aiconversations).toHaveLength(0);
  });

  it('returns a correlated sanitized 500 for an unexpected internal AI failure', async () => {
    complete.mockRejectedValueOnce(
      Object.assign(new TypeError('private provider response and prompt'), {
        apiKey: 'must-not-leak',
      }),
    );
    const response = await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth(ownerToken))
      .send({ message: 'private e2e prompt' })
      .expect(500);
    const body = response.body as Record<string, unknown>;
    expect(body).toMatchObject({
      message: 'AI assistant request could not be completed',
      code: 'ai_internal_error',
    });
    expect(typeof body.requestId).toBe('string');
    expect(JSON.stringify(response.body)).not.toMatch(
      /private provider response|private e2e prompt|must-not-leak/,
    );
    expect(f.aiconversations).toHaveLength(0);
    expect(f.aimessages).toHaveLength(0);
    expect(f.aiusages).toHaveLength(0);
  });

  it('rate-limits model requests independently for each authenticated user', async () => {
    for (let index = 0; index < 2; index++)
      await request(app.getHttpServer())
        .post('/ai/chat')
        .set(auth(ownerToken))
        .send({ message: `request ${index}` })
        .expect(200);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth(ownerToken))
      .send({ message: 'request over limit' })
      .expect(429);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth(memberToken))
      .send({ message: 'member has an independent budget' })
      .expect(200);
    expect(complete).toHaveBeenCalledTimes(3);
  });
});
