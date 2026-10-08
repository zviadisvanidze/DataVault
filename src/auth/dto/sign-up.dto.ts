import { Transform } from 'class-transformer';
import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
  PickType,
} from '@nestjs/swagger';
import { IsString, Length, ValidateIf } from 'class-validator';
import { NewPassword } from '../../common/password-policy';
import { CompanyProfileDto } from '../../companies/dto/company-profile.dto';
import { SignInDto } from './sign-in.dto';

export class SignUpDto extends IntersectionType(
  PickType(SignInDto, ['email'] as const),
  CompanyProfileDto,
) {
  @ApiProperty({ minLength: 12, maxLength: 72, writeOnly: true })
  @IsString()
  @NewPassword()
  password: string;

  @ApiProperty({ minLength: 2, maxLength: 100 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(2, 100)
  companyName: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Length(1, 100)
  fullName?: string;
}
