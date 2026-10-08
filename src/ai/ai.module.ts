import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '../auth/auth.module';
import { CompaniesModule } from '../companies/companies.module';
import { FilesModule } from '../files/files.module';
import { StatisticsModule } from '../statistics/statistics.module';
import { SubscriptionsDomainModule } from '../subscriptions/subscriptions-domain.module';
import { AiController } from './ai.controller';
import { AI_MODEL_CLIENT } from './ai-model-client';
import { AiService } from './ai.service';
import { AiProviderRouterService } from './ai-provider-router.service';
import { AiThrottlerGuard } from './ai-throttler.guard';
import { AiToolsService } from './ai-tools.service';
import { aiConversationSchema } from './entities/ai-conversation.entity';
import { aiMessageSchema } from './entities/ai-message.entity';
import { aiUsageSchema } from './entities/ai-usage.entity';
import { OpenRouterClientService } from './openrouter-client.service';
import { GeminiClientService } from './gemini-client.service';

@Module({
  imports: [
    AuthModule,
    CompaniesModule,
    FilesModule,
    StatisticsModule,
    SubscriptionsDomainModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          name: 'ai',
          ttl: 60_000,
          limit: config.getOrThrow<number>('AI_RATE_LIMIT_PER_MINUTE'),
        },
      ],
    }),
    MongooseModule.forFeature([
      { name: 'aiConversation', schema: aiConversationSchema },
      { name: 'aiMessage', schema: aiMessageSchema },
      { name: 'aiUsage', schema: aiUsageSchema },
    ]),
  ],
  controllers: [AiController],
  providers: [
    AiService,
    AiToolsService,
    AiThrottlerGuard,
    OpenRouterClientService,
    GeminiClientService,
    AiProviderRouterService,
    { provide: AI_MODEL_CLIENT, useExisting: AiProviderRouterService },
  ],
})
export class AiModule {}
