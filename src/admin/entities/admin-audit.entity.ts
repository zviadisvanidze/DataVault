import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, Types } from 'mongoose';
import {
  CompanyPlatformReason,
  CompanyPlatformStatus,
} from '../../companies/platform-status';

export enum AdminAuditAction {
  BOOTSTRAP_CREATED = 'bootstrap_created',
  PASSWORD_RESET = 'password_reset',
  LOGIN_SUCCEEDED = 'login_succeeded',
  LOGIN_FAILED = 'login_failed',
  COMPANY_SUSPENDED = 'company_suspended',
  COMPANY_REACTIVATED = 'company_reactivated',
  ACCESS_REQUESTED = 'admin_access_requested',
  ACCESS_VERIFIED = 'admin_access_verified',
  ACCESS_APPROVED = 'admin_access_approved',
  ACCESS_REJECTED = 'admin_access_rejected',
  ACCESS_ACTIVATED = 'admin_access_activated',
}

export enum AdminAuditReason {
  INVALID_CREDENTIALS = 'invalid_credentials',
}

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AdminAudit {
  @Prop({
    type: String,
    enum: AdminAuditAction,
    required: true,
    immutable: true,
  })
  action: AdminAuditAction;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    ref: 'platformAdmin',
    immutable: true,
  })
  actorId?: Types.ObjectId;

  @Prop({ type: MongoSchema.Types.ObjectId, immutable: true })
  targetId?: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['platform_admin', 'company', 'admin_access_request'],
    immutable: true,
  })
  targetType?: 'platform_admin' | 'company' | 'admin_access_request';

  @Prop({
    type: String,
    enum: [
      ...Object.values(CompanyPlatformReason),
      ...Object.values(AdminAuditReason),
    ],
    immutable: true,
  })
  reason?: CompanyPlatformReason | AdminAuditReason;

  @Prop({ type: String, enum: CompanyPlatformStatus, immutable: true })
  previousStatus?: CompanyPlatformStatus;

  @Prop({ type: String, enum: CompanyPlatformStatus, immutable: true })
  nextStatus?: CompanyPlatformStatus;

  createdAt: Date;
}

export const adminAuditSchema = SchemaFactory.createForClass(AdminAudit);
adminAuditSchema.pre('bulkWrite', function () {
  throw new Error('Platform audit records are append-only');
});
adminAuditSchema.pre(
  'deleteOne',
  { document: true, query: false },
  function () {
    throw new Error('Platform audit records are append-only');
  },
);
adminAuditSchema.pre('save', function () {
  if (!this.isNew) throw new Error('Platform audit records are append-only');
});
adminAuditSchema.index({ createdAt: -1, _id: -1 });
adminAuditSchema.index({ actorId: 1, createdAt: -1, _id: -1 });
adminAuditSchema.index({ targetId: 1, createdAt: -1, _id: -1 });
adminAuditSchema.index({ action: 1, createdAt: -1, _id: -1 });
adminAuditSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  function () {
    throw new Error('Platform audit records are append-only');
  },
);
