import {
  Inject,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  UseGuards,
  createParamDecorator,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import { isMongoId } from 'class-validator';
import { Request } from 'express';
import { PlatformAdmin } from './entities/platform-admin.entity';
import {
  PLATFORM_ADMIN_JWT,
  PLATFORM_ADMIN_TOKEN_TYPE,
} from './admin-security';

export interface PlatformAdminActor {
  id: string;
}
export interface PlatformAdminRequest extends Request {
  platformAdmin?: PlatformAdminActor;
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    @Inject(PLATFORM_ADMIN_JWT) private readonly jwt: JwtService,
    @InjectModel('platformAdmin') private readonly admins: Model<PlatformAdmin>,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<PlatformAdminRequest>();
    const match = request.headers.authorization?.match(/^Bearer ([^\s]+)$/);
    if (!match)
      throw new UnauthorizedException(
        'Platform administrator authentication required',
      );
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        type: string;
        version?: number;
      }>(match[1]);
      if (payload.type !== PLATFORM_ADMIN_TOKEN_TYPE || !isMongoId(payload.sub))
        throw new Error();
      const admin = await this.admins.findById(payload.sub);
      if (
        !admin?.isActive ||
        (payload.version ?? 0) !== (admin.authVersion ?? 0)
      )
        throw new Error();
      request.platformAdmin = { id: admin._id.toString() };
      return true;
    } catch {
      throw new UnauthorizedException(
        'Invalid or expired platform administrator token',
      );
    }
  }
}

export const PlatformAdminOnly = () => UseGuards(PlatformAdminGuard);
export const CurrentPlatformAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<PlatformAdminRequest>().platformAdmin,
);
