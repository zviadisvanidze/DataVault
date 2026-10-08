import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, Types } from 'mongoose';

@Schema({ timestamps: true })
export class AiConversation {
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

  @Prop({ type: String, required: true, trim: true, maxlength: 80 })
  title: string;

  @Prop({ type: Number, required: true, default: 0, min: 0, max: 200 })
  messageCount: number;

  @Prop({ type: String, select: false })
  activeRequestId?: string;

  @Prop({ type: Date, select: false })
  activeRequestExpiresAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const aiConversationSchema =
  SchemaFactory.createForClass(AiConversation);
aiConversationSchema.index({ companyId: 1, userId: 1, updatedAt: -1, _id: -1 });
aiConversationSchema.index({ userId: 1, createdAt: -1, _id: -1 });
aiConversationSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.activeRequestId;
    delete ret.activeRequestExpiresAt;
    return ret;
  },
});
