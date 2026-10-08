import { ApiProperty, IntersectionType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';
import { CompanyProfileDto } from '../../companies/dto/company-profile.dto';
import { GoogleExchangeDto } from './google-exchange.dto';

export class GoogleRegistrationDto extends IntersectionType(
  GoogleExchangeDto,
  CompanyProfileDto,
) {
  @ApiProperty({ minLength: 2, maxLength: 100 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(2, 100)
  companyName: string;
}
