import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { NewPassword } from '../../common/password-policy';

export class ResetPasswordDto {
  @ApiProperty({ minLength: 43, maxLength: 43, writeOnly: true })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token: string;

  @ApiProperty({ minLength: 12, maxLength: 72, writeOnly: true })
  @IsString()
  @NewPassword()
  newPassword: string;
}
