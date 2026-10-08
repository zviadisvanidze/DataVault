import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { isISO31661Alpha2 } from 'class-validator';
import { Schema as MongoSchema, Types } from 'mongoose';
import {
  CompanyPlatformReason,
  CompanyPlatformStatus,
} from '../platform-status';

@Schema({ timestamps: true })
export class Company {
  @Prop({
    type: String,
    required: true,
    trim: true,
    minlength: 2,
    maxlength: 100,
  })
  name: string;

  @Prop({
    type: String,
    required: true,
    uppercase: true,
    trim: true,
    minlength: 2,
    maxlength: 2,
    match: /^[A-Z]{2}$/,
    validate: { validator: isISO31661Alpha2, message: 'Invalid country code' },
  })
  country: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    minlength: 2,
    maxlength: 100,
    set: (value: string) => value.trim().replace(/\s+/g, ' '),
  })
  industry: string;

  @Prop({ type: Date, default: null })
  activatedAt: Date | null;

  @Prop({
    type: String,
    enum: CompanyPlatformStatus,
    default: CompanyPlatformStatus.ACTIVE,
  })
  platformStatus: CompanyPlatformStatus;

  @Prop({ type: String, enum: CompanyPlatformReason, select: false })
  platformStatusReason?: CompanyPlatformReason;

  @Prop({ type: Date, select: false })
  platformStatusChangedAt?: Date;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    ref: 'platformAdmin',
    select: false,
  })
  platformStatusChangedBy?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

export const companySchema = SchemaFactory.createForClass(Company);
companySchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } },
);
companySchema.index({ platformStatus: 1, createdAt: -1, _id: -1 });
companySchema.index({ activatedAt: 1, createdAt: -1, _id: -1 });
companySchema.index({ createdAt: -1, _id: -1 });
companySchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.platformStatusReason;
    delete ret.platformStatusChangedAt;
    delete ret.platformStatusChangedBy;
    return ret;
  },
});
