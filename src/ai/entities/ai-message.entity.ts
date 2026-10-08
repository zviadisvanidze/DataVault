import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, Types } from 'mongoose';

export enum AiMessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
}

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AiMessage {
  @Prop({
    type: MongoSchema.Types.ObjectId,
    ref: 'aiConversation',
    required: true,
    immutable: true,
  })
  conversationId: Types.ObjectId;

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

  @Prop({ type: String, enum: AiMessageRole, required: true, immutable: true })
  role: AiMessageRole;

  @Prop({ type: String, required: true, minlength: 1, maxlength: 50_000 })
  content: string;

  createdAt: Date;
}

export const aiMessageSchema = SchemaFactory.createForClass(AiMessage);
aiMessageSchema.index({ conversationId: 1, createdAt: 1, _id: 1 });
aiMessageSchema.index({ companyId: 1, userId: 1, createdAt: -1, _id: -1 });
