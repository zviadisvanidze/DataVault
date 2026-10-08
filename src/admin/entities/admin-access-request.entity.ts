import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

export enum AdminAccessRequestStatus {
  AWAITING_VERIFICATION = 'awaiting_verification',
  PENDING_REVIEW = 'pending_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  ACTIVATED = 'activated',
  EXPIRED = 'expired',
}

@Schema({ timestamps: true })
export class AdminAccessRequest {
  @Prop({ required: true, trim: true, lowercase: true })
  email: string;

  @Prop({ required: true, trim: true })
  fullName: string;

  @Prop({ trim: true })
  reason?: string;

  @Prop({ required: true, enum: AdminAccessRequestStatus })
  status: AdminAccessRequestStatus;

  @Prop({ select: false })
  verificationTokenHash?: string;

  @Prop()
  verificationExpiresAt?: Date;

  @Prop({ select: false })
  setupTokenHash?: string;

  @Prop()
  setupExpiresAt?: Date;

  @Prop({ type: Types.ObjectId })
  reviewedBy?: Types.ObjectId;

  @Prop()
  reviewedAt?: Date;

  @Prop()
  verifiedAt?: Date;

  @Prop()
  activatedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const adminAccessRequestSchema =
  SchemaFactory.createForClass(AdminAccessRequest);

// A person can have one open request at a time. Rejected requests remain in
// the audit trail while a later, explicit application is possible.
adminAccessRequestSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: {
        $in: [
          AdminAccessRequestStatus.AWAITING_VERIFICATION,
          AdminAccessRequestStatus.PENDING_REVIEW,
          AdminAccessRequestStatus.APPROVED,
        ],
      },
    },
  },
);
adminAccessRequestSchema.index({ status: 1, createdAt: -1 });
adminAccessRequestSchema.index({ verificationTokenHash: 1 }, { sparse: true });
adminAccessRequestSchema.index({ setupTokenHash: 1 }, { sparse: true });
