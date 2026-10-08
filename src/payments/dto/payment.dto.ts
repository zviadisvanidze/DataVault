import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PlanCode } from '../../plans/plan.constants';

export class CheckoutDto {
  @ApiProperty({ enum: [PlanCode.BASIC, PlanCode.PREMIUM] })
  @IsIn([PlanCode.BASIC, PlanCode.PREMIUM])
  planCode: PlanCode.BASIC | PlanCode.PREMIUM;
}

export class PaymentPlanDto {
  @ApiProperty({ enum: PlanCode })
  @IsIn(Object.values(PlanCode))
  planCode: PlanCode;
}

export class EmptyPaymentDto {}
