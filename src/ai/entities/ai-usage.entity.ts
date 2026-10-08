import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, Types } from 'mongoose';

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AiUsage {
  @Prop({ type: String, required: true, unique: true, immutable: true })
  requestId: string;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    ref: 'company',
    required: true,
    immutable: true,
  })
  companyId: Types.ObjectId;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    ref: 'user',
    required: true,
    immutable: true,
  })
  userId: Types.ObjectId;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    ref: 'aiConversation',
    required: true,
    immutable: true,
  })
  conversationId: Types.ObjectId;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    ref: 'aiMessage',
    required: true,
    immutable: true,
  })
  assistantMessageId: Types.ObjectId;

  @Prop({ type: String, required: true, immutable: true, maxlength: 200 })
  modelId: string;

  @Prop({
    type: String,
    enum: ['openrouter', 'gemini'],
    default: 'openrouter',
    required: true,
    immutable: true,
  })
  provider: 'openrouter' | 'gemini';

  @Prop({ type: [String], required: true, immutable: true })
  modelsUsed: string[];

  @Prop({ type: Number, required: true, immutable: true, min: 0 })
  promptTokens: number;

  @Prop({ type: Number, required: true, immutable: true, min: 0 })
  completionTokens: number;

  @Prop({ type: Number, required: true, immutable: true, min: 0 })
  totalTokens: number;

  @Prop({ type: Number, immutable: true, min: 0 })
  providerCostUsdMicros?: number;

  @Prop({ type: Number, required: true, immutable: true, min: 0 })
  durationMs: number;

  @Prop({ type: Number, required: true, immutable: true, min: 0, max: 25 })
  toolCallCount: number;

  createdAt: Date;
}

export const aiUsageSchema = SchemaFactory.createForClass(AiUsage);
aiUsageSchema.index({ companyId: 1, createdAt: -1, _id: -1 });
aiUsageSchema.index({ userId: 1, createdAt: -1, _id: -1 });
aiUsageSchema.index({ conversationId: 1, createdAt: -1, _id: -1 });
