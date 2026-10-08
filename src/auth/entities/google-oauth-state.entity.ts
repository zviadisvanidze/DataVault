import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class GoogleOAuthState {
  @Prop({ type: String, required: true, unique: true, select: false })
  stateHash?: string;

  @Prop({ type: String, required: true, select: false })
  browserHash?: string;

  @Prop({ type: Date, required: true })
  expiresAt: Date;
}

export const googleOAuthStateSchema =
  SchemaFactory.createForClass(GoogleOAuthState);
googleOAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
googleOAuthStateSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.stateHash;
    delete ret.browserHash;
    return ret;
  },
});
