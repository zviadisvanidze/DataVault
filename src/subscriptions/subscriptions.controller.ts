import {
  Body,
  Controller,
  Get,
  Header,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Role } from '../enums/roles.enum';
import { IsAuthGuard } from '../guards/is-auth.guard';
import { ChangePlanDto } from './dto/change-plan.dto';
import { SubscriptionsService } from './subscriptions.service';
import { BillingQueryDto } from './dto/billing-query.dto';

@UseGuards(IsAuthGuard, RolesGuard)
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get('current')
  getCurrent(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptionsService.getCurrent(user.companyId);
  }

  @Patch('current')
  @Roles(Role.COMPANY_OWNER)
  changePlan(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePlanDto,
  ) {
    return this.subscriptionsService.changePlan(user, dto.planCode);
  }

  @Get('current/billing')
  @Header('Cache-Control', 'private, no-store')
  getBilling(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BillingQueryDto,
    @Body() body: BillingQueryDto,
  ) {
    void query;
    void body;
    return this.subscriptionsService.getCurrentBilling(user.companyId);
  }
}
