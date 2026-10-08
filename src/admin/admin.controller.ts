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
import {
  CompanyPlatformReason,
  CompanyPlatformStatus,
} from '../companies/platform-status';
import { AdminAuthService } from './admin-auth.service';
import { AdminService } from './admin.service';
import {
  AdminAuditQueryDto,
  AdminCompanyIdDto,
  AdminCompanyQueryDto,
  AdminEmptyDto,
  AdminFileQueryDto,
  AdminForgotPasswordDto,
  AdminLoginDto,
  AdminResetPasswordDto,
  AdminUserQueryDto,
  SuspendCompanyDto,
} from './dto/admin.dto';
import {
  CurrentPlatformAdmin,
  PlatformAdminActor,
  PlatformAdminOnly,
} from './platform-admin.guard';

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ThrottlerGuard)
  @Throttle({ publicAuth: { limit: 5, ttl: 60000 } })
  login(@Body() dto: AdminLoginDto, @Query() query: AdminEmptyDto) {
    void query;
    return this.auth.login(dto);
  }

  @Post('forgot-password')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ThrottlerGuard)
  @Throttle({ publicAuth: { limit: 5, ttl: 60000 } })
  forgotPassword(
    @Body() dto: AdminForgotPasswordDto,
    @Query() query: AdminEmptyDto,
  ) {
    void query;
    return this.auth.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ThrottlerGuard)
  @Throttle({ publicAuth: { limit: 5, ttl: 60000 } })
  resetPassword(
    @Body() dto: AdminResetPasswordDto,
    @Query() query: AdminEmptyDto,
  ) {
    void query;
    return this.auth.resetPassword(dto);
  }
}

@Controller('admin')
@PlatformAdminOnly()
@UseGuards(ThrottlerGuard)
@Throttle({ publicAuth: { limit: 60, ttl: 60000 } })
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('dashboard')
  @Header('Cache-Control', 'private, no-store')
  dashboard(@Query() query: AdminEmptyDto) {
    void query;
    return this.admin.dashboard();
  }

  @Get('companies')
  @Header('Cache-Control', 'private, no-store')
  companies(@Query() query: AdminCompanyQueryDto) {
    return this.admin.listCompanies(query);
  }

  @Get('companies/:id')
  @Header('Cache-Control', 'private, no-store')
  company(@Param() params: AdminCompanyIdDto, @Query() query: AdminEmptyDto) {
    void query;
    return this.admin.companyDetail(params.id);
  }

  @Post('companies/:id/suspend')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  suspend(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param() params: AdminCompanyIdDto,
    @Body() dto: SuspendCompanyDto,
    @Query() query: AdminEmptyDto,
  ) {
    void query;
    return this.admin.changeCompanyStatus(
      actor,
      params.id,
      CompanyPlatformStatus.SUSPENDED,
      dto.reason,
    );
  }

  @Post('companies/:id/reactivate')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  reactivate(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param() params: AdminCompanyIdDto,
    @Body() body: AdminEmptyDto,
    @Query() query: AdminEmptyDto,
  ) {
    void body;
    void query;
    return this.admin.changeCompanyStatus(
      actor,
      params.id,
      CompanyPlatformStatus.ACTIVE,
      CompanyPlatformReason.REVIEW_COMPLETED,
    );
  }

  @Get('users')
  @Header('Cache-Control', 'private, no-store')
  users(@Query() query: AdminUserQueryDto) {
    return this.admin.listUsers(query);
  }

  @Get('files')
  @Header('Cache-Control', 'private, no-store')
  files(@Query() query: AdminFileQueryDto) {
    return this.admin.listFiles(query);
  }

  @Get('audit-logs')
  @Header('Cache-Control', 'private, no-store')
  audit(@Query() query: AdminAuditQueryDto) {
    return this.admin.listAudit(query);
  }
}
