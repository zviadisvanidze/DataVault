import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NewPassword } from '../../common/password-policy';

export class ChangePasswordDto {
  @ApiProperty({ minLength: 1, maxLength: 72, writeOnly: true })
  @IsString()
  @Length(1, 72)
  currentPassword: string;

  @ApiProperty({ minLength: 12, maxLength: 72, writeOnly: true })
  @IsString()
  @NewPassword()
  newPassword: string;
}
