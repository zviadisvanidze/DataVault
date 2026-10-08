import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class GoogleExchangeDto {
  @ApiProperty({
    description: 'Short-lived, single-use Google sign-in exchange code.',
    writeOnly: true,
    minLength: 43,
    maxLength: 43,
    pattern: '^[A-Za-z0-9_-]{43}$',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  code: string;
}
