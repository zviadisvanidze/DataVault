import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class GoogleOAuthExchange {
  @Prop({ type: String, required: true, unique: true, select: false })
  codeHash?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'user' })
  userId?: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: ['google_login_exchange', 'google_registration_exchange'],
  })
  purpose: string;

  @Prop({ type: String })
  email?: string;

  @Prop({ type: String })
  fullName?: string;

  @Prop({ type: String })
  avatar?: string;

  @Prop({ type: Date, required: true })
  expiresAt: Date;
}

export const googleOAuthExchangeSchema =
  SchemaFactory.createForClass(GoogleOAuthExchange);
googleOAuthExchangeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
googleOAuthExchangeSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.codeHash;
    return ret;
  },
});
