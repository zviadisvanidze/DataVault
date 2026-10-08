import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { companyFileSchema } from '../files/entities/company-file.entity';
import { employeeInvitationSchema } from '../invitations/entities/employee-invitation.entity';
import { PlansModule } from '../plans/plans.module';
import { subscriptionPeriodSchema } from '../subscriptions/entities/subscription-period.entity';
import { subscriptionSchema } from '../subscriptions/entities/subscription.entity';
import { userSchema } from '../users/entities/user.entity';
import { stripeEventSchema } from './entities/stripe-event.entity';
import { stripeUsageSchema } from './entities/stripe-usage.entity';
import { PaymentsService } from './payments.service';
import { StripeClientService } from './stripe-client.service';

@Module({
  imports: [
    PlansModule,
    MongooseModule.forFeature([
      { name: 'subscription', schema: subscriptionSchema },
      { name: 'subscriptionPeriod', schema: subscriptionPeriodSchema },
      { name: 'user', schema: userSchema },
      { name: 'companyFile', schema: companyFileSchema },
      { name: 'employeeInvitation', schema: employeeInvitationSchema },
    ]),
  ],
  providers: [
    StripeClientService,
    PaymentsService,
    ...[
      { name: 'stripeEvent', schema: stripeEventSchema },
      { name: 'stripeUsage', schema: stripeUsageSchema },
    ].map(({ name, schema }) => ({
      provide: getModelToken(name),
      inject: [ConfigService, getConnectionToken()],
      useFactory: async (config: ConfigService, connection: Connection) => {
        if (config.get<boolean>('STRIPE_ENABLED') !== true) return undefined;
        const model = connection.models[name] ?? connection.model(name, schema);
        // Event/outbox uniqueness is a correctness condition, not just a
        // performance hint. Do not accept webhooks before these indexes exist.
        const subscription =
          connection.models.subscription ??
          connection.model('subscription', subscriptionSchema);
        await Promise.all([model.init(), subscription.init()]);
        return model;
      },
    })),
  ],
  exports: [PaymentsService, StripeClientService],
})
export class PaymentsDomainModule {}
