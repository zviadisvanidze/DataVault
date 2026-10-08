import { Type } from 'class-transformer';
import { IsInt, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryParams {
  @ApiPropertyOptional({ minimum: 1, maximum: 1000000, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    default: 30,
    description: 'The service caps returned rows at 30.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  take: number = 30;
}
