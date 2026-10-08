import { IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyAccountDto {
  @ApiProperty({
    minLength: 43,
    maxLength: 43,
    pattern: '^[A-Za-z0-9_-]{43}$',
    writeOnly: true,
    description: 'Single-use token from the account activation link.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token: string;
}
