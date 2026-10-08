import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { AwsS3Module } from './aws-s3/aws-s3.module';
import { CompaniesModule } from './companies/companies.module';
import { validateEnvironment } from './config/environment';
import { PlansModule } from './plans/plans.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { InvitationsModule } from './invitations/invitations.module';
import { FilesModule } from './files/files.module';
import { StatisticsModule } from './statistics/statistics.module';
import { HealthModule } from './health/health.module';
import { PaymentsModule } from './payments/payments.module';
import { AdminModule } from './admin/admin.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGO_URI'),
        serverSelectionTimeoutMS: config.getOrThrow<number>(
          'MONGO_SERVER_SELECTION_TIMEOUT_MS',
        ),
        maxPoolSize: config.getOrThrow<number>('MONGO_MAX_POOL_SIZE'),
        retryAttempts: config.getOrThrow<number>('MONGO_RETRY_ATTEMPTS'),
        retryDelay: config.getOrThrow<number>('MONGO_RETRY_DELAY_MS'),
        autoIndex: true,
      }),
    }),
    UsersModule,
    AuthModule,
    AwsS3Module,
    CompaniesModule,
    PlansModule,
    SubscriptionsModule,
    InvitationsModule,
    FilesModule,
    StatisticsModule,
    HealthModule,
    PaymentsModule,
    AdminModule,
    AiModule,
  ],
})
export class AppModule {}
