import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ timestamps: true })
export class PlatformAdmin {
  @Prop({
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  })
  email: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    minlength: 2,
    maxlength: 100,
  })
  fullName: string;

  @Prop({ type: String, required: true, select: false })
  password: string;

  @Prop({ type: Boolean, default: true, required: true })
  isActive: boolean;

  @Prop({ type: Number, default: 0, required: true })
  authVersion: number;

  @Prop({ type: String, select: false })
  passwordResetTokenHash?: string;

  @Prop({ type: Date, select: false })
  passwordResetExpiresAt?: Date;

  @Prop({ type: Date, select: false })
  passwordResetRequestedAt?: Date;

  createdAt: Date;
}

export const platformAdminSchema = SchemaFactory.createForClass(PlatformAdmin);
platformAdminSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete (ret as unknown as Record<string, unknown>).password;
    delete (ret as unknown as Record<string, unknown>).passwordResetTokenHash;
    delete (ret as unknown as Record<string, unknown>).passwordResetExpiresAt;
    delete (ret as unknown as Record<string, unknown>).passwordResetRequestedAt;
    return ret;
  },
});
