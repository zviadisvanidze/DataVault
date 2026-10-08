import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Role } from '../enums/roles.enum';
import { IsAuthGuard } from '../guards/is-auth.guard';
import {
  DowngradeCleanupDto,
  DowngradePreviewDto,
} from './dto/downgrade-cleanup.dto';
import { DowngradeCleanupService } from './downgrade-cleanup.service';

@Controller('subscriptions')
@UseGuards(IsAuthGuard, RolesGuard, ThrottlerGuard)
@Roles(Role.COMPANY_OWNER)
@Throttle({ publicAuth: { limit: 10, ttl: 60000 } })
export class DowngradeCleanupController {
  constructor(private readonly cleanup: DowngradeCleanupService) {}

  @Post('downgrade-preview')
  preview(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: DowngradePreviewDto,
  ) {
    return this.cleanup.preview(actor, dto.planCode);
  }

  @Post('downgrade-cleanup')
  confirm(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: DowngradeCleanupDto,
  ) {
    return this.cleanup.cleanup(actor, dto.planCode, dto.previewToken);
  }
}
