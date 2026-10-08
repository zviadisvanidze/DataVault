import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { planSchema } from './entities/plan.entity';
import { PlansService } from './plans.service';
import { PlansController } from './plans.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: 'plan', schema: planSchema }])],
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
