import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Role } from '../enums/roles.enum';
import { IsAuthGuard } from '../guards/is-auth.guard';
import { IsValidMongoDBId } from '../users/dto/is-valid-objectID.dto';
import { QueryParams } from '../users/dto/query-params.dto';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { InviteEmployeeDto } from './dto/invite-employee.dto';
import { InvitationsService } from './invitations.service';

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ publicAuth: { limit: 10, ttl: 60_000 } })
  accept(@Body() dto: AcceptInvitationDto) {
    return this.invitationsService.accept(dto);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(IsAuthGuard, RolesGuard)
  @Roles(Role.COMPANY_OWNER)
  invite(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: InviteEmployeeDto,
  ) {
    return this.invitationsService.invite(actor, dto);
  }

  @Get()
  @UseGuards(IsAuthGuard, RolesGuard)
  @Roles(Role.COMPANY_OWNER)
  findPending(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: QueryParams,
  ) {
    return this.invitationsService.findPending(actor, query);
  }

  @Post(':id/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(IsAuthGuard, RolesGuard)
  @Roles(Role.COMPANY_OWNER)
  resend(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IsValidMongoDBId,
  ) {
    return this.invitationsService.resend(actor, id);
  }

  @Delete(':id')
  @UseGuards(IsAuthGuard, RolesGuard)
  @Roles(Role.COMPANY_OWNER)
  revoke(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IsValidMongoDBId,
  ) {
    return this.invitationsService.revoke(actor, id);
  }
}
