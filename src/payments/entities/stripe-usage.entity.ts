import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, Types } from 'mongoose';
import { UsageDeliveryState } from '../payment.constants';

@Schema({ timestamps: true })
export class StripeUsage {
  @Prop({ type: String, required: true, unique: true, immutable: true })
  identifier: string;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    required: true,
    ref: 'company',
    immutable: true,
  })
  companyId: Types.ObjectId;

  @Prop({ type: String, required: true, immutable: true })
  customerId: string;

  @Prop({ type: String, required: true, immutable: true })
  subscriptionId: string;

  @Prop({
    type: Number,
    required: true,
    min: 1,
    immutable: true,
    validate: Number.isSafeInteger,
  })
  quantity: number;

  @Prop({
    type: Number,
    required: true,
    min: 0,
    immutable: true,
    validate: Number.isSafeInteger,
  })
  timestamp: number;

  @Prop({ type: Date, required: true, immutable: true })
  periodStartsAt: Date;

  @Prop({ type: Date, required: true, immutable: true })
  periodEndsAt: Date;

  @Prop({
    type: String,
    enum: UsageDeliveryState,
    default: UsageDeliveryState.PENDING,
    required: true,
  })
  state: UsageDeliveryState;

  @Prop({ type: Date })
  firstAttemptAt?: Date;

  @Prop({ type: Date })
  submittedAt?: Date;
}

export const stripeUsageSchema = SchemaFactory.createForClass(StripeUsage);
stripeUsageSchema.index({ companyId: 1, state: 1, timestamp: 1 });
stripeUsageSchema.index({ companyId: 1, periodStartsAt: 1 });
