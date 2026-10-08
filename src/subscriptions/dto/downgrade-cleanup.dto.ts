import { IsEnum, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PlanCode } from '../../plans/plan.constants';

export class DowngradePreviewDto {
  @ApiProperty({ enum: PlanCode })
  @IsEnum(PlanCode)
  planCode: PlanCode;
}

export class DowngradeCleanupDto extends DowngradePreviewDto {
  @ApiProperty({ description: 'Token from the current cleanup preview' })
  @Matches(/^[a-f0-9]{64}$/)
  previewToken: string;
}
