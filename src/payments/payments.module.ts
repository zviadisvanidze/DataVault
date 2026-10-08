import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { subscriptionSchema } from '../subscriptions/entities/subscription.entity';
import { PaymentsDomainModule } from './payments-domain.module';
import {
  PaymentsController,
  StripeWebhookController,
} from './payments.controller';
import { PaymentsWorker } from './payments.worker';

@Module({
  imports: [
    AuthModule,
    PaymentsDomainModule,
    MongooseModule.forFeature([
      { name: 'subscription', schema: subscriptionSchema },
    ]),
  ],
  controllers: [PaymentsController, StripeWebhookController],
  providers: [PaymentsWorker],
})
export class PaymentsModule {}
