import { Injectable, Logger } from '@nestjs/common';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import {
  AiModelClient,
  AiModelCompletion,
  AiModelRequestContext,
  AiProviderFailure,
  AiProviderFailureReason,
} from './ai-model-client';
import { GeminiClientService } from './gemini-client.service';
import { OpenRouterClientService } from './openrouter-client.service';

@Injectable()
export class AiProviderRouterService implements AiModelClient {
  readonly enabled: boolean;
  private readonly logger = new Logger(AiProviderRouterService.name);
  // The same message array is used throughout one agent exchange. Pin the first
  // successful provider so tool-call history never changes protocols mid-turn.
  private readonly selected = new WeakMap<
    ChatCompletionMessageParam[],
    AiModelClient
  >();

  constructor(
    private readonly openRouter: OpenRouterClientService,
    private readonly gemini: GeminiClientService,
  ) {
    this.enabled = openRouter.enabled || gemini.enabled;
  }

  async complete(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    signal: AbortSignal,
    context?: AiModelRequestContext,
  ): Promise<AiModelCompletion> {
    const pinned = this.selected.get(messages);
    if (pinned) return pinned.complete(messages, tools, signal, context);
    if (this.openRouter.enabled) {
      try {
        const completion = await this.openRouter.complete(
          messages,
          tools,
          signal,
        );
        this.selected.set(messages, this.openRouter);
        return completion;
      } catch (error) {
        if (!this.gemini.enabled || !this.eligible(error) || signal.aborted)
          throw error;
        this.logger.warn({
          message: 'AI primary provider failed; Gemini fallback attempted',
          requestId: context?.requestId,
          provider: 'openrouter',
          reason: error.reason,
          status: error.status,
          ...(error.diagnostic ? { validation: error.diagnostic } : {}),
        });
      }
    }
    if (!this.gemini.enabled)
      throw new AiProviderFailure(AiProviderFailureReason.UNAVAILABLE);
    try {
      const completion = await this.gemini.complete(messages, tools, signal);
      this.selected.set(messages, this.gemini);
      if (this.openRouter.enabled)
        this.logger.log({
          message: 'AI Gemini fallback succeeded',
          requestId: context?.requestId,
          provider: 'gemini',
          model: completion.model,
        });
      return completion;
    } catch (error) {
      if (this.openRouter.enabled && error instanceof AiProviderFailure)
        this.logger.warn({
          message: 'AI Gemini fallback failed',
          requestId: context?.requestId,
          provider: 'gemini',
          reason: error.reason,
          status: error.status,
          ...(error.diagnostic ? { validation: error.diagnostic } : {}),
        });
      throw error;
    }
  }

  private eligible(error: unknown): error is AiProviderFailure {
    if (!(error instanceof AiProviderFailure)) return false;
    if (
      error.reason === AiProviderFailureReason.RATE_LIMIT ||
      error.reason === AiProviderFailureReason.TIMEOUT
    )
      return true;
    return (
      error.reason === AiProviderFailureReason.UNAVAILABLE &&
      (error.status === undefined || error.status >= 500)
    );
  }
}
