import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { IsAuthGuard } from '../guards/is-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../enums/roles.enum';
import { UpdateCompanyDto } from './dto/update-company.dto';

@Controller('companies')
@UseGuards(IsAuthGuard, RolesGuard)
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Get('current')
  findCurrent(@CurrentUser() user: AuthenticatedUser) {
    return this.companiesService.findCurrent(user.companyId);
  }

  @Patch('current')
  @Roles(Role.COMPANY_OWNER)
  updateCurrent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.companiesService.updateCurrent(user.companyId, dto);
  }
}
