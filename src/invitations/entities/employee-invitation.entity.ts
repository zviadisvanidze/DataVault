import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

export enum InvitationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REVOKED = 'revoked',
  EXPIRED = 'expired',
}

@Schema({ timestamps: true })
export class EmployeeInvitation {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'company',
    required: true,
    immutable: true,
    index: true,
  })
  companyId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'user',
    required: true,
    immutable: true,
  })
  invitedBy: Types.ObjectId;

  @Prop({ type: String, required: true, lowercase: true, trim: true })
  email: string;

  @Prop({
    type: String,
    enum: InvitationStatus,
    default: InvitationStatus.PENDING,
  })
  status: InvitationStatus;

  @Prop({
    type: String,
    select: false,
    required: function (this: EmployeeInvitation) {
      return this.status === InvitationStatus.PENDING;
    },
  })
  tokenHash?: string;

  @Prop({ type: Date, required: true })
  expiresAt: Date;

  @Prop({ type: Date, required: true })
  lastSentAt: Date;

  @Prop({ type: Date })
  acceptedAt?: Date;

  @Prop({ type: Date })
  revokedAt?: Date;
}

export const employeeInvitationSchema =
  SchemaFactory.createForClass(EmployeeInvitation);
employeeInvitationSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { status: InvitationStatus.PENDING },
  },
);
employeeInvitationSchema.index(
  { tokenHash: 1 },
  {
    unique: true,
    partialFilterExpression: { tokenHash: { $type: 'string' } },
  },
);
employeeInvitationSchema.index({ companyId: 1, status: 1, expiresAt: 1 });
employeeInvitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
employeeInvitationSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.tokenHash;
    return ret;
  },
});
