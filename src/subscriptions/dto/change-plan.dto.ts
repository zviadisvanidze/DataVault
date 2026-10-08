import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PlanCode } from '../../plans/plan.constants';

export class ChangePlanDto {
  @ApiProperty({ enum: PlanCode })
  @IsEnum(PlanCode)
  planCode: PlanCode;
}
