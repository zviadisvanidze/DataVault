import { PickType } from '@nestjs/swagger';
import { SignInDto } from './sign-in.dto';

export class ResendVerificationDto extends PickType(SignInDto, ['email']) {}
