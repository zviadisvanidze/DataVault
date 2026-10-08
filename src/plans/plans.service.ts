import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Plan } from './entities/plan.entity';
import { PLAN_CATALOG, PlanCode } from './plan.constants';

@Injectable()
export class PlansService implements OnModuleInit {
  constructor(@InjectModel('plan') private readonly planModel: Model<Plan>) {}

  async onModuleInit() {
    // The assignment's code-defined catalog is authoritative; no HTTP catalog mutations.
    await this.planModel.bulkWrite(
      this.findAll().map(({ code, ...metadata }) => ({
        updateOne: {
          filter: { code },
          update: { $set: metadata, $setOnInsert: { code } },
          upsert: true,
        },
      })),
    );
  }

  findAll() {
    return Object.values(PLAN_CATALOG).map((plan) => ({ ...plan }));
  }

  findOne(code: PlanCode) {
    const plan = PLAN_CATALOG[code];
    if (!plan) throw new BadRequestException('Unknown plan');
    return plan;
  }
}
