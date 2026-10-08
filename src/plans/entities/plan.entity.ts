import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { BillingCurrency, BillingInterval, PlanCode } from '../plan.constants';

@Schema({ timestamps: true })
export class Plan {
  @Prop({
    type: String,
    enum: PlanCode,
    required: true,
    unique: true,
    immutable: true,
  })
  code: PlanCode;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: Number, required: true, min: 0 })
  includedFilesPerMonth: number;

  @Prop({ type: Number, default: null, min: 0 })
  maxEmployees: number | null;

  @Prop({ type: Number, required: true, min: 0 })
  basePriceCents: number;

  @Prop({ type: Number, required: true, min: 0 })
  employeePriceCents: number;

  @Prop({ type: Number, default: null, min: 0 })
  extraFilePriceCents: number | null;

  @Prop({ type: String, enum: BillingCurrency, required: true })
  currency: BillingCurrency;

  @Prop({ type: String, enum: BillingInterval, required: true })
  interval: BillingInterval;
}

export const planSchema = SchemaFactory.createForClass(Plan);
