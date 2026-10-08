import { Schema, Types } from 'mongoose';
import { aiConversationSchema } from './ai-conversation.entity';
import { aiMessageSchema } from './ai-message.entity';
import { aiUsageSchema } from './ai-usage.entity';

describe('AI persistence schemas', () => {
  it.each([
    [aiConversationSchema, ['companyId', 'userId']],
    [aiMessageSchema, ['conversationId', 'companyId', 'userId']],
    [
      aiUsageSchema,
      ['companyId', 'userId', 'conversationId', 'assistantMessageId'],
    ],
  ] as const)(
    'uses real ObjectId tenant and ownership paths',
    (schema, paths) => {
      for (const path of paths) {
        const schemaPath = schema.paths[path];
        expect(schemaPath).toBeInstanceOf(Schema.Types.ObjectId);
        expect(
          schemaPath?.cast(new Types.ObjectId().toHexString()),
        ).toBeInstanceOf(Types.ObjectId);
      }
    },
  );

  it('uniquely constrains usage requests and indexes tenant history', () => {
    expect(aiUsageSchema.path('requestId').options.unique).toBe(true);
    expect(aiUsageSchema.indexes()).toEqual(
      expect.arrayContaining([
        [{ companyId: 1, createdAt: -1, _id: -1 }, expect.any(Object)],
        [{ userId: 1, createdAt: -1, _id: -1 }, expect.any(Object)],
        [{ conversationId: 1, createdAt: -1, _id: -1 }, expect.any(Object)],
      ]),
    );
  });

  it('records the serving provider without changing old usage semantics', () => {
    const provider = aiUsageSchema.path('provider');
    expect(provider.options.enum).toEqual(['openrouter', 'gemini']);
    expect(provider.options.default).toBe('openrouter');
    expect(provider.options.immutable).toBe(true);
  });

  it('keeps conversation leases out of serialized responses', () => {
    const transform = aiConversationSchema.get('toJSON')?.transform as (
      document: unknown,
      value: Record<string, unknown>,
    ) => Record<string, unknown>;
    const value = transform(null, {
      activeRequestId: 'private-lock',
      activeRequestExpiresAt: new Date(),
      title: 'Safe title',
    });
    expect(value).toEqual({ title: 'Safe title' });
  });
});
