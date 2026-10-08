import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthenticatedRequest } from '../auth/auth.types';

@Injectable()
export class AiThrottlerGuard extends ThrottlerGuard {
  protected getTracker(request: Record<string, unknown>): Promise<string> {
    const actor = (request as unknown as AuthenticatedRequest).auth;
    return Promise.resolve(
      actor ? `${actor.companyId}:${actor.id}` : 'unauthenticated',
    );
  }
}
