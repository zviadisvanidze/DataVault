import {
  Body,
  Controller,
  Get,
  Header,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { IsAuthGuard } from '../guards/is-auth.guard';
import { StatisticsQueryDto } from './dto/statistics-query.dto';
import { StatisticsService } from './statistics.service';

@Controller('statistics')
@UseGuards(IsAuthGuard)
export class StatisticsController {
  constructor(private readonly statisticsService: StatisticsService) {}

  @Get('current')
  @Header('Cache-Control', 'private, no-store')
  getCurrent(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: StatisticsQueryDto,
    @Body() body: StatisticsQueryDto,
  ) {
    void query;
    void body;
    return this.statisticsService.getCurrent(actor.companyId);
  }
}
