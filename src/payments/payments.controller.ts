import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Role } from '../enums/roles.enum';
import { IsAuthGuard } from '../guards/is-auth.guard';
import { PlanCode } from '../plans/plan.constants';
import {
  CheckoutDto,
  EmptyPaymentDto,
  PaymentPlanDto,
} from './dto/payment.dto';
import { PaymentsService } from './payments.service';

@Controller('payments')
@UseGuards(IsAuthGuard, RolesGuard, ThrottlerGuard)
@Roles(Role.COMPANY_OWNER)
@Throttle({ publicAuth: { limit: 20, ttl: 60000 } })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('checkout')
  checkout(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CheckoutDto,
    @Query() query: EmptyPaymentDto,
  ) {
    void query;
    return this.payments.checkout(actor, dto.planCode);
  }

  @Post('portal')
  portal(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: EmptyPaymentDto,
    @Query() query: EmptyPaymentDto,
  ) {
    void body;
    void query;
    return this.payments.portal(actor);
  }

  @Get('current')
  @Header('Cache-Control', 'private, no-store')
  current(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: EmptyPaymentDto,
    @Query() query: EmptyPaymentDto,
  ) {
    void body;
    void query;
    return this.payments.current(actor);
  }

  @Post('plan')
  plan(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: PaymentPlanDto,
    @Query() query: EmptyPaymentDto,
  ) {
    void query;
    return this.payments.changePlan(actor, dto.planCode);
  }

  @Post('cancel')
  cancel(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: EmptyPaymentDto,
    @Query() query: EmptyPaymentDto,
  ) {
    void body;
    void query;
    return this.payments.changePlan(actor, PlanCode.FREE);
  }

  @Post('reconcile')
  @Throttle({ publicAuth: { limit: 5, ttl: 60000 } })
  reconcile(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: EmptyPaymentDto,
    @Query() query: EmptyPaymentDto,
  ) {
    void body;
    void query;
    return this.payments.reconcile(actor);
  }
}

@Controller('payments')
export class StripeWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.payments.webhook(request.rawBody, signature);
  }
}
