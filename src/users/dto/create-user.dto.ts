import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length } from 'class-validator';
import { NewPassword } from '../../common/password-policy';

export class CreateUserDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100)
  fullName: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email: string;

  @IsString()
  @NewPassword()
  password: string;
}
