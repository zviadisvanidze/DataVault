import { Role } from '../enums/roles.enum';
import { AiThrottlerGuard } from './ai-throttler.guard';

describe('AiThrottlerGuard', () => {
  it('tracks each authenticated user inside its company independently', async () => {
    const tracker = (
      AiThrottlerGuard.prototype as unknown as {
        getTracker(request: Record<string, unknown>): Promise<string>;
      }
    ).getTracker.bind({});
    await expect(
      tracker({
        auth: {
          id: 'user-id',
          companyId: 'company-id',
          role: Role.COMPANY_MEMBER,
        },
      }),
    ).resolves.toBe('company-id:user-id');
    await expect(tracker({})).resolves.toBe('unauthenticated');
  });
});
