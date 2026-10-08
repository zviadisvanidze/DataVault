import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';
import { PlanCode } from '../../plans/plan.constants';
import {
  PaymentAccess,
  PaymentSyncIssue,
  STRIPE_SUBSCRIPTION_STATUSES,
  StripeSubscriptionStatus,
} from '../../payments/payment.constants';

@Schema({ timestamps: true })
export class Subscription {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'company',
    required: true,
    unique: true,
    immutable: true,
  })
  companyId: Types.ObjectId;

  @Prop({
    type: String,
    enum: PlanCode,
    required: true,
    default: PlanCode.FREE,
  })
  planCode: PlanCode;

  @Prop({ type: Date, required: true, immutable: true })
  activatedAt: Date;

  @Prop({ type: Date, required: true })
  planChangedAt: Date;

  // Serializes plan changes, member additions, and usage recording in transactions.
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  revision: number;

  @Prop({ type: Boolean, default: false })
  stripeManaged: boolean;

  @Prop({ type: String })
  stripeCustomerId?: string;

  @Prop({ type: String })
  stripeSubscriptionId?: string;

  @Prop({ type: String, enum: STRIPE_SUBSCRIPTION_STATUSES })
  stripeStatus?: StripeSubscriptionStatus;

  @Prop({ type: String, enum: PaymentAccess, default: PaymentAccess.UNMANAGED })
  paymentAccess: PaymentAccess;

  @Prop({
    type: String,
    enum: PaymentSyncIssue,
    default: PaymentSyncIssue.NONE,
  })
  paymentSyncIssue: PaymentSyncIssue;

  @Prop({ type: Boolean, default: false })
  stripeCancelAtPeriodEnd: boolean;

  @Prop({ type: String, enum: PlanCode })
  pendingPlanCode?: PlanCode;

  @Prop({ type: Date })
  pendingPlanAt?: Date;

  @Prop({ type: String })
  stripeScheduleId?: string;

  @Prop({ type: String })
  stripeChangeOperation?: string;

  @Prop({ type: Date })
  stripeCheckoutAttemptAt?: Date;

  @Prop({ type: Date })
  stripeCustomerAttemptAt?: Date;

  @Prop({ type: Date })
  stripeSubscriptionAttemptAt?: Date;

  @Prop({ type: Date })
  stripePlanAttemptAt?: Date;

  @Prop({ type: Boolean, default: false })
  stripePlanConfirmed: boolean;

  @Prop({ type: Number, min: 0 })
  stripePlanEmployees?: number;

  @Prop({ type: Number, min: 0 })
  stripeCheckoutEmployees?: number;

  @Prop({ type: String })
  stripeCheckoutOperation?: string;

  @Prop({ type: String })
  stripeCheckoutSessionId?: string;

  @Prop({ type: String, enum: PlanCode })
  stripeCheckoutPlan?: PlanCode;

  @Prop({ type: Date })
  stripeSyncedAt?: Date;

  @Prop({ type: Date })
  stripeMeterStartedAt?: Date;

  @Prop({ type: Date })
  stripeNextSyncAt?: Date;

  @Prop({ type: String, select: false })
  stripeLeaseToken?: string;

  @Prop({ type: Date, select: false })
  stripeLeaseUntil?: Date;
}

export const subscriptionSchema = SchemaFactory.createForClass(Subscription);
subscriptionSchema.index(
  { stripeCheckoutSessionId: 1 },
  {
    unique: true,
    partialFilterExpression: { stripeCheckoutSessionId: { $type: 'string' } },
  },
);
subscriptionSchema.index(
  { stripeCustomerId: 1 },
  {
    unique: true,
    partialFilterExpression: { stripeCustomerId: { $type: 'string' } },
  },
);
subscriptionSchema.index(
  { stripeSubscriptionId: 1 },
  {
    unique: true,
    partialFilterExpression: { stripeSubscriptionId: { $type: 'string' } },
  },
);
subscriptionSchema.index({ stripeManaged: 1, stripeNextSyncAt: 1 });
subscriptionSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.stripeLeaseToken;
    delete ret.stripeLeaseUntil;
    return ret;
  },
});
