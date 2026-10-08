import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { companySchema } from '../companies/entities/company.entity';
import { EmailModule } from '../email/email.module';
import { SubscriptionsDomainModule } from '../subscriptions/subscriptions-domain.module';
import { userSchema } from '../users/entities/user.entity';
import { employeeInvitationSchema } from './entities/employee-invitation.entity';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
  imports: [
    AuthModule,
    EmailModule,
    SubscriptionsDomainModule,
    MongooseModule.forFeature([
      { name: 'employeeInvitation', schema: employeeInvitationSchema },
      { name: 'company', schema: companySchema },
      { name: 'user', schema: userSchema },
    ]),
  ],
  controllers: [InvitationsController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
