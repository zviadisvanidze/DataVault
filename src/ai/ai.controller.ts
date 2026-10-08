import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { IsAuthGuard } from '../guards/is-auth.guard';
import { AiThrottlerGuard } from './ai-throttler.guard';
import { AiService } from './ai.service';
import {
  AiChatDto,
  AiConversationIdDto,
  AiConversationQueryDto,
  AiEmptyDto,
} from './dto/ai.dto';

@Controller('ai')
@UseGuards(IsAuthGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('chat')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(AiThrottlerGuard)
  chat(@CurrentUser() actor: AuthenticatedUser, @Body() dto: AiChatDto) {
    return this.ai.chat(actor, dto);
  }

  @Get('conversations')
  @Header('Cache-Control', 'private, no-store')
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: AiConversationQueryDto,
  ) {
    return this.ai.list(actor, query);
  }

  @Get('conversations/:id')
  @Header('Cache-Control', 'private, no-store')
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: AiConversationIdDto,
    @Query() query: AiEmptyDto,
  ) {
    void query;
    return this.ai.get(actor, params.id);
  }

  @Delete('conversations/:id')
  @Header('Cache-Control', 'private, no-store')
  delete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: AiConversationIdDto,
    @Query() query: AiEmptyDto,
  ) {
    void query;
    return this.ai.delete(actor, params.id);
  }
}
