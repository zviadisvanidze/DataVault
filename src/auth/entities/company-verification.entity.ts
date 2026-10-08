import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

@Schema({ timestamps: true })
export class CompanyVerification {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'company',
    required: true,
    unique: true,
    immutable: true,
  })
  companyId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'user',
    required: true,
    immutable: true,
  })
  ownerId: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true, select: false })
  tokenHash?: string;

  @Prop({ type: Date, required: true })
  expiresAt: Date;

  @Prop({ type: Date, required: true })
  lastSentAt: Date;
}

export const companyVerificationSchema =
  SchemaFactory.createForClass(CompanyVerification);
companyVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
companyVerificationSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.tokenHash;
    return ret;
  },
});
