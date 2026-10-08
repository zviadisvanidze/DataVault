import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { companyFileSchema } from '../files/entities/company-file.entity';
import { employeeInvitationSchema } from '../invitations/entities/employee-invitation.entity';
import { SubscriptionsDomainModule } from '../subscriptions/subscriptions-domain.module';
import { StatisticsController } from './statistics.controller';
import { StatisticsService } from './statistics.service';

@Module({
  imports: [
    AuthModule,
    SubscriptionsDomainModule,
    MongooseModule.forFeature([
      { name: 'employeeInvitation', schema: employeeInvitationSchema },
      { name: 'companyFile', schema: companyFileSchema },
    ]),
  ],
  controllers: [StatisticsController],
  providers: [StatisticsService],
  exports: [StatisticsService],
})
export class StatisticsModule {}
