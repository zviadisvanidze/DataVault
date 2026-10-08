import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

@Schema({ timestamps: true })
export class SubscriptionPeriod {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'company',
    required: true,
    immutable: true,
  })
  companyId: Types.ObjectId;

  @Prop({ type: Date, required: true, immutable: true })
  startsAt: Date;

  @Prop({ type: Date, required: true, immutable: true })
  endsAt: Date;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  uploadedFiles: number;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  fileOverageCents: number;
}

export const subscriptionPeriodSchema =
  SchemaFactory.createForClass(SubscriptionPeriod);
subscriptionPeriodSchema.index({ companyId: 1, startsAt: 1 }, { unique: true });
subscriptionPeriodSchema.index({ endsAt: 1, startsAt: 1 });
