import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { companySchema } from '../companies/entities/company.entity';
import { companyFileSchema } from '../files/entities/company-file.entity';
import { userSchema } from '../users/entities/user.entity';
import { subscriptionSchema } from '../subscriptions/entities/subscription.entity';
import { subscriptionPeriodSchema } from '../subscriptions/entities/subscription-period.entity';
import { employeeInvitationSchema } from '../invitations/entities/employee-invitation.entity';
import { SubscriptionsDomainModule } from '../subscriptions/subscriptions-domain.module';
import { EmailModule } from '../email/email.module';
import { AdminAuthService } from './admin-auth.service';
import { PLATFORM_ADMIN_JWT, platformAdminJwtOptions } from './admin-security';
import { AdminAuthController, AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { adminAuditSchema } from './entities/admin-audit.entity';
import { platformAdminSchema } from './entities/platform-admin.entity';
import { PlatformAdminGuard } from './platform-admin.guard';
import { adminAccessRequestSchema } from './entities/admin-access-request.entity';
import { AdminAccessRequestService } from './admin-access-request.service';
import {
  AdminAccessRequestController,
  AdminPublicAccessController,
} from './admin-access-request.controller';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: 'publicAuth', ttl: 60000, limit: 60 }]),
    SubscriptionsDomainModule,
    EmailModule,
    MongooseModule.forFeature([
      { name: 'platformAdmin', schema: platformAdminSchema },
      { name: 'adminAudit', schema: adminAuditSchema },
      { name: 'adminAccessRequest', schema: adminAccessRequestSchema },
      { name: 'company', schema: companySchema },
      { name: 'companyFile', schema: companyFileSchema },
      { name: 'user', schema: userSchema },
      { name: 'subscription', schema: subscriptionSchema },
      { name: 'subscriptionPeriod', schema: subscriptionPeriodSchema },
      { name: 'employeeInvitation', schema: employeeInvitationSchema },
    ]),
  ],
  controllers: [
    AdminController,
    AdminAuthController,
    AdminPublicAccessController,
    AdminAccessRequestController,
  ],
  providers: [
    AdminService,
    AdminAuthService,
    AdminAccessRequestService,
    PlatformAdminGuard,
    {
      provide: PLATFORM_ADMIN_JWT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new JwtService(platformAdminJwtOptions(config)),
    },
  ],
})
export class AdminModule {}
