import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from 'openai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import {
  AiModelClient,
  AiModelCompletion,
  AiProviderFailure,
  AiProviderFailureReason,
} from './ai-model-client';
import { normalizeChatCompletion } from './chat-completion-response';

type OpenRouterRequest = ChatCompletionCreateParamsNonStreaming & {
  models?: string[];
  usage: { include: true };
  provider: { data_collection: 'deny'; zdr?: true };
};

@Injectable()
export class OpenRouterClientService implements AiModelClient {
  readonly enabled: boolean;
  private readonly client?: OpenAI;
  private readonly model?: string;
  private readonly models: string[];
  private readonly maxOutputTokens: number;

  constructor(private readonly config: ConfigService) {
    this.enabled = config.getOrThrow<boolean>('OPENROUTER_ENABLED');
    this.models = config.get<string[]>('OPENROUTER_FALLBACK_MODELS') ?? [];
    this.maxOutputTokens = config.getOrThrow<number>(
      'OPENROUTER_MAX_OUTPUT_TOKENS',
    );
    if (this.enabled) {
      this.model = config.getOrThrow<string>('OPENROUTER_MODEL');
      this.client = new OpenAI({
        apiKey: config.getOrThrow<string>('OPENROUTER_API_KEY'),
        baseURL: 'https://openrouter.ai/api/v1',
        timeout: config.getOrThrow<number>('OPENROUTER_TIMEOUT_MS'),
        maxRetries: 0,
        defaultHeaders: { 'X-OpenRouter-Title': 'DataVault AI Assistant' },
      });
    }
  }

  async complete(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    signal: AbortSignal,
  ): Promise<AiModelCompletion> {
    if (!this.client || !this.model)
      throw new AiProviderFailure(AiProviderFailureReason.UNAVAILABLE);
    const request: OpenRouterRequest = {
      model: this.model,
      ...(this.models.length ? { models: [this.model, ...this.models] } : {}),
      messages,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      max_completion_tokens: this.maxOutputTokens,
      stream: false,
      usage: { include: true },
      provider: {
        data_collection: 'deny',
        ...(this.config.getOrThrow<boolean>('OPENROUTER_REQUIRE_ZDR')
          ? { zdr: true as const }
          : {}),
      },
    };
    try {
      const response = await this.client.chat.completions.create(request, {
        signal,
      });
      return normalizeChatCompletion(response, 'openrouter');
    } catch (error) {
      if (error instanceof AiProviderFailure) throw error;
      if (
        error instanceof APIConnectionTimeoutError ||
        (error instanceof Error && error.name === 'AbortError')
      )
        throw new AiProviderFailure(AiProviderFailureReason.TIMEOUT);
      if (error instanceof APIError) {
        const status =
          typeof error.status === 'number' ? error.status : undefined;
        if (status === 401 || status === 403)
          throw new AiProviderFailure(
            AiProviderFailureReason.AUTHENTICATION,
            status,
          );
        if (status === 402)
          throw new AiProviderFailure(AiProviderFailureReason.CREDITS, status);
        if (status === 429)
          throw new AiProviderFailure(
            AiProviderFailureReason.RATE_LIMIT,
            status,
          );
        throw new AiProviderFailure(
          AiProviderFailureReason.UNAVAILABLE,
          status,
        );
      }
      if (error instanceof APIConnectionError)
        throw new AiProviderFailure(AiProviderFailureReason.UNAVAILABLE);
      // Local programming errors are handled by AiService's internal boundary.
      throw error;
    }
  }
}
