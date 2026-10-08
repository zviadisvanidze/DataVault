import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, Types } from 'mongoose';

@Schema({ timestamps: true })
export class StripeEvent {
  @Prop({ type: String, required: true, unique: true, immutable: true })
  eventId: string;

  @Prop({ type: String, required: true, immutable: true })
  type: string;

  @Prop({ type: MongoSchema.Types.ObjectId, ref: 'company', immutable: true })
  companyId?: Types.ObjectId;

  @Prop({ type: Date, required: true })
  processedAt: Date;
}

export const stripeEventSchema = SchemaFactory.createForClass(StripeEvent);
