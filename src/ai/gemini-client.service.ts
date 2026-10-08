import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import {
  AiModelClient,
  AiModelCompletion,
  AiProviderFailure,
  AiProviderFailureReason,
  AiProviderRequestDiagnostic,
} from './ai-model-client';
import { normalizeChatCompletion } from './chat-completion-response';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Google's supported OpenAI-compatible endpoint is a direct Gemini API call. */
@Injectable()
export class GeminiClientService implements AiModelClient {
  readonly enabled: boolean;
  private readonly client?: OpenAI;
  private readonly model?: string;
  private readonly maxOutputTokens: number;
  private readonly toolMessageRoles = new WeakMap<
    object,
    'assistant' | 'model'
  >();

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>('GEMINI_ENABLED') === true;
    this.maxOutputTokens = config.getOrThrow<number>(
      'GEMINI_MAX_OUTPUT_TOKENS',
    );
    if (this.enabled) {
      this.model = config.getOrThrow<string>('GEMINI_MODEL');
      this.client = new OpenAI({
        apiKey: config.getOrThrow<string>('GEMINI_API_KEY'),
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        timeout: config.getOrThrow<number>('GEMINI_TIMEOUT_MS'),
        maxRetries: 0,
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
    let sentMessages: ChatCompletionMessageParam[] | undefined;
    try {
      sentMessages = this.withToolNames(messages);
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: sentMessages,
          tools,
          tool_choice: 'auto',
          reasoning_effort: 'low',
          max_tokens: this.maxOutputTokens,
          stream: false,
        },
        { signal },
      );
      const completion = normalizeChatCompletion(response, 'gemini');
      if (completion.message.tool_calls?.length) {
        const originalRole: unknown = response.choices[0].message.role;
        this.toolMessageRoles.set(
          completion.message,
          originalRole === 'model' ? 'model' : 'assistant',
        );
      }
      return completion;
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
        if (status === 400)
          throw new AiProviderFailure(
            AiProviderFailureReason.UNAVAILABLE,
            status,
            undefined,
            this.badRequestDiagnostic(error, sentMessages ?? messages),
          );
        throw new AiProviderFailure(
          AiProviderFailureReason.UNAVAILABLE,
          status,
        );
      }
      if (error instanceof APIConnectionError)
        throw new AiProviderFailure(AiProviderFailureReason.UNAVAILABLE);
      // Unexpected local errors remain internal failures in AiService.
      throw error;
    }
  }

  private withToolNames(messages: ChatCompletionMessageParam[]) {
    const names = new Map<string, string>();
    return messages.map((message) => {
      if (message.role === 'assistant') {
        for (const call of message.tool_calls ?? [])
          if (call.type === 'function') names.set(call.id, call.function.name);
        if (message.tool_calls?.length) {
          // A response object is not a request DTO. Google's compatibility
          // examples use both assistant and model for tool-call history; keep
          // the original role, IDs, order and opaque signature metadata.
          const toolCalls = message.tool_calls.map((call) => {
            if (call.type !== 'function')
              throw new AiProviderFailure(
                AiProviderFailureReason.INVALID_RESPONSE,
              );
            const extra: unknown = (
              call as unknown as { extra_content?: unknown }
            ).extra_content;
            if (extra !== undefined && !record(extra))
              throw new AiProviderFailure(
                AiProviderFailureReason.INVALID_RESPONSE,
              );
            return {
              id: call.id,
              type: call.type,
              function: {
                name: call.function.name,
                arguments: call.function.arguments,
              },
              ...(extra === undefined ? {} : { extra_content: extra }),
            };
          });
          return {
            role: this.toolMessageRoles.get(message) ?? 'assistant',
            ...(typeof message.content === 'string' && message.content
              ? { content: message.content }
              : {}),
            tool_calls: toolCalls,
          } as unknown as ChatCompletionMessageParam;
        }
      }
      if (message.role !== 'tool') return message;
      const name = names.get(message.tool_call_id);
      if (!name || typeof message.content !== 'string')
        throw new AiProviderFailure(AiProviderFailureReason.INVALID_RESPONSE);
      return {
        role: 'tool',
        name,
        tool_call_id: message.tool_call_id,
        content: message.content,
      } as ChatCompletionMessageParam;
    });
  }

  private badRequestDiagnostic(
    error: unknown,
    messages: ChatCompletionMessageParam[],
  ): AiProviderRequestDiagnostic {
    // Inspect provider text only to select a fixed category. Never retain it.
    const detail = error instanceof Error ? error.message : '';
    const category: AiProviderRequestDiagnostic['category'] =
      /missing (?:a )?thought_signature/i.test(detail)
        ? 'missing_thought_signature'
        : /unknown name|unknown field/i.test(detail)
          ? 'unsupported_message_field'
          : /functionresponse|tool_call_id|function response/i.test(detail)
            ? 'invalid_tool_response'
            : /invalid.argument/i.test(detail)
              ? 'invalid_argument'
              : 'other_bad_request';
    const body: unknown = error instanceof APIError ? error.error : undefined;
    const rawCode = record(body) ? body.status : undefined;
    const providerCode: AiProviderRequestDiagnostic['providerCode'] =
      rawCode === 'INVALID_ARGUMENT' || rawCode === 'FAILED_PRECONDITION'
        ? rawCode
        : 'other';
    const toolCallSteps: unknown[][] = [];
    let toolResultCount = 0;
    for (const message of messages) {
      if (message.role === 'tool') toolResultCount++;
      const runtime: unknown = message;
      if (
        record(runtime) &&
        Array.isArray(runtime.tool_calls) &&
        runtime.tool_calls.length
      )
        toolCallSteps.push(runtime.tool_calls as unknown[]);
    }
    const allToolCallStepsSigned = toolCallSteps.length
      ? toolCallSteps.every((calls) => {
          const first = calls[0];
          if (!record(first) || !record(first.extra_content)) return false;
          const google = first.extra_content.google;
          return (
            record(google) &&
            typeof google.thought_signature === 'string' &&
            google.thought_signature.length > 0
          );
        })
      : undefined;
    return {
      phase: toolResultCount ? 'tool_continuation' : 'initial',
      category,
      providerCode,
      toolCallCount: Math.min(
        toolCallSteps.reduce((sum, calls) => sum + calls.length, 0),
        100,
      ),
      toolResultCount: Math.min(toolResultCount, 100),
      ...(allToolCallStepsSigned === undefined
        ? {}
        : { allToolCallStepsSigned }),
    };
  }
}
