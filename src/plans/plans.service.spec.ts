import { BadRequestException } from '@nestjs/common';
import { PlanCode } from './plan.constants';
import { PlansService } from './plans.service';
import { planSchema } from './entities/plan.entity';

describe('PlansService', () => {
  const planModel = {
    bulkWrite: jest
      .fn<Promise<void>, [unknown[]]>()
      .mockResolvedValue(undefined),
  };
  const service = new PlansService(planModel as never);

  beforeEach(() => jest.clearAllMocks());

  it('publishes exactly the assignment plan catalog', () => {
    expect(service.findAll()).toEqual([
      expect.objectContaining({
        code: PlanCode.FREE,
        basePriceCents: 0,
        includedFilesPerMonth: 10,
        maxEmployees: 0,
      }),
      expect.objectContaining({
        code: PlanCode.BASIC,
        basePriceCents: 0,
        employeePriceCents: 500,
        includedFilesPerMonth: 100,
        maxEmployees: 10,
      }),
      expect.objectContaining({
        code: PlanCode.PREMIUM,
        basePriceCents: 30000,
        employeePriceCents: 0,
        extraFilePriceCents: 50,
        includedFilesPerMonth: 1000,
        maxEmployees: null,
      }),
    ]);
  });

  it('upserts the code-defined plans at startup', async () => {
    await service.onModuleInit();
    const operations = planModel.bulkWrite.mock.calls[0][0] as unknown as {
      updateOne: { filter: { code: PlanCode }; upsert: boolean };
    }[];
    expect(operations).toHaveLength(3);
    expect(operations[0].updateOne).toMatchObject({
      filter: { code: PlanCode.FREE },
      upsert: true,
    });
  });

  it('rejects unknown internal plan codes', () => {
    expect(() => service.findOne('enterprise' as PlanCode)).toThrow(
      BadRequestException,
    );
  });

  it('enforces a unique immutable plan code', () => {
    expect(planSchema.path('code').options).toMatchObject({
      required: true,
      unique: true,
      immutable: true,
    });
  });
});
