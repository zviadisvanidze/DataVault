import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AdminAccessRequestService } from './admin-access-request.service';
import {
  AccessDecisionDto,
  AccessRequestIdDto,
  AccessRequestQueryDto,
  AccessRequestTokenDto,
  RequestPlatformAccessDto,
  SetupPlatformAccessDto,
} from './dto/admin-access-request.dto';
import { AdminEmptyDto } from './dto/admin.dto';
import {
  CurrentPlatformAdmin,
  PlatformAdminActor,
  PlatformAdminOnly,
} from './platform-admin.guard';

@Controller('admin/access')
@UseGuards(ThrottlerGuard)
export class AdminPublicAccessController {
  constructor(private readonly access: AdminAccessRequestService) {}

  @Post('request')
  @HttpCode(202)
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ publicAuth: { limit: 3, ttl: 60000 } })
  request(
    @Body() dto: RequestPlatformAccessDto,
    @Query() query: AdminEmptyDto,
  ) {
    void query;
    return this.access.request(dto);
  }

  @Post('verify')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ publicAuth: { limit: 5, ttl: 60000 } })
  verify(@Body() dto: AccessRequestTokenDto, @Query() query: AdminEmptyDto) {
    void query;
    return this.access.verify(dto.token);
  }

  @Post('setup')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ publicAuth: { limit: 5, ttl: 60000 } })
  setup(@Body() dto: SetupPlatformAccessDto, @Query() query: AdminEmptyDto) {
    void query;
    return this.access.setup(dto);
  }
}

@Controller('admin/access-requests')
@PlatformAdminOnly()
@UseGuards(ThrottlerGuard)
@Throttle({ publicAuth: { limit: 60, ttl: 60000 } })
export class AdminAccessRequestController {
  constructor(private readonly access: AdminAccessRequestService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Query() query: AccessRequestQueryDto) {
    return this.access.list(query.page, query.limit);
  }

  @Post(':id/decision')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  decide(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param() params: AccessRequestIdDto,
    @Body() dto: AccessDecisionDto,
    @Query() query: AdminEmptyDto,
  ) {
    void query;
    return this.access.decide(actor.id, params.id, dto);
  }

  @Post(':id/resend-setup')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  resendSetup(
    @Param() params: AccessRequestIdDto,
    @Body() body: AdminEmptyDto,
    @Query() query: AdminEmptyDto,
  ) {
    void body;
    void query;
    return this.access.resendSetup(params.id);
  }

  @Post(':id/resend-rejection')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  resendRejection(
    @Param() params: AccessRequestIdDto,
    @Body() body: AdminEmptyDto,
    @Query() query: AdminEmptyDto,
  ) {
    void body;
    void query;
    return this.access.resendRejection(params.id);
  }
}
