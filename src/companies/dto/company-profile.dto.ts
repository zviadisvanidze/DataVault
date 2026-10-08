import { Transform } from 'class-transformer';
import { IsISO31661Alpha2, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CompanyProfileDto {
  @ApiProperty({
    minLength: 2,
    maxLength: 2,
    description: 'ISO 3166-1 alpha-2 country code.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsISO31661Alpha2()
  country: string;

  @ApiProperty({ minLength: 2, maxLength: 100 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  @IsString()
  @Length(2, 100)
  industry: string;
}
