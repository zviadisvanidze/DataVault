import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { MongoTransactionSupportService } from './mongo-transaction-support.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService, MongoTransactionSupportService],
})
export class HealthModule {}
