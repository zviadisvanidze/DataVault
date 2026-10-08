import { MongooseModule } from '@nestjs/mongoose';
import { AwsS3Module } from '../aws-s3/aws-s3.module';
import { PlansModule } from '../plans/plans.module';
import { companyFileSchema } from '../files/entities/company-file.entity';
import { userSchema } from '../users/entities/user.entity';
import { employeeInvitationSchema } from '../invitations/entities/employee-invitation.entity';
import { DowngradeCleanupController } from './downgrade-cleanup.controller';
import { DowngradeCleanupService } from './downgrade-cleanup.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsDomainModule } from './subscriptions-domain.module';

@Module({
  imports: [
    AuthModule,
    SubscriptionsDomainModule,
    AwsS3Module,
    PlansModule,
    MongooseModule.forFeature([
      { name: 'companyFile', schema: companyFileSchema },
      { name: 'user', schema: userSchema },
      { name: 'employeeInvitation', schema: employeeInvitationSchema },
    ]),
  ],
  controllers: [SubscriptionsController, DowngradeCleanupController],
  providers: [DowngradeCleanupService],
})
export class SubscriptionsModule {}
