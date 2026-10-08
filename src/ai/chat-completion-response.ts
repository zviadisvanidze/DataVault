import type { ChatCompletion } from 'openai/resources/chat/completions';
import {
  AiModelCompletion,
  AiProvider,
  AiProviderFailure,
  AiProviderFailureReason,
  AiResponseDiagnostic,
  AiResponseValidationCode,
} from './ai-model-client';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function costMicros(value: unknown) {
  const cost = typeof value === 'string' ? Number(value) : value;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)
    return undefined;
  const micros = Math.round(cost * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : undefined;
}

function diagnostic(
  code: AiResponseValidationCode,
  choice: unknown,
  message: unknown,
): AiProviderFailure {
  const rawReason = record(choice) ? choice.finish_reason : undefined;
  const finishReason: AiResponseDiagnostic['finishReason'] =
    rawReason === 'stop' || rawReason === 'length' || rawReason === 'tool_calls'
      ? rawReason
      : rawReason === undefined || rawReason === null
        ? 'missing'
        : 'other';
  const content = record(message) ? message.content : undefined;
  const contentType: AiResponseDiagnostic['contentType'] =
    content === undefined
      ? 'missing'
      : content === null
        ? 'null'
        : Array.isArray(content)
          ? 'array'
          : typeof content === 'string' ||
              typeof content === 'number' ||
              typeof content === 'boolean'
            ? (typeof content as 'string' | 'number' | 'boolean')
            : 'object';
  const calls = record(message) ? message.tool_calls : undefined;
  return new AiProviderFailure(
    AiProviderFailureReason.INVALID_RESPONSE,
    undefined,
    {
      code,
      finishReason,
      contentType,
      toolCallCount: Array.isArray(calls) ? Math.min(calls.length, 100) : 0,
    },
  );
}

/** Validate SDK data at runtime; TypeScript's response type is not a trust boundary. */
export function normalizeChatCompletion(
  response: ChatCompletion,
  provider: AiProvider,
): AiModelCompletion {
  const runtime = response as unknown;
  if (!record(runtime))
    throw diagnostic('invalid_envelope', undefined, undefined);
  if (!Array.isArray(runtime.choices) || runtime.choices.length === 0)
    throw diagnostic('missing_choices', undefined, undefined);
  const choice: unknown = runtime.choices[0];
  const rawMessage = record(choice) ? choice.message : undefined;
  if (!record(rawMessage))
    throw diagnostic('missing_message', choice, rawMessage);
  // Google's compatibility API documents `model` on function-call messages.
  // Keep the provider-neutral internal role, while retaining opaque extra_content.
  const role =
    provider === 'gemini' &&
    rawMessage.role === 'model' &&
    Array.isArray(rawMessage.tool_calls) &&
    rawMessage.tool_calls.length > 0
      ? 'assistant'
      : rawMessage.role;
  if (role !== 'assistant')
    throw diagnostic('invalid_message_role', choice, rawMessage);
  const calls = rawMessage.tool_calls;
  if (calls !== undefined) {
    if (!Array.isArray(calls))
      throw diagnostic('malformed_tool_call', choice, rawMessage);
    for (const call of calls) {
      if (
        !record(call) ||
        call.type !== 'function' ||
        typeof call.id !== 'string' ||
        !call.id ||
        call.id.length > 256 ||
        !record(call.function) ||
        typeof call.function.name !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(call.function.name)
      )
        throw diagnostic('malformed_tool_call', choice, rawMessage);
      if (typeof call.function.arguments !== 'string')
        throw diagnostic('invalid_tool_arguments', choice, rawMessage);
    }
  }
  const hasCalls = Array.isArray(calls) && calls.length > 0;
  // Google's documented OpenAI-compatible function-call response omits
  // `content` entirely. Accept that omission only alongside validated calls.
  const content =
    provider === 'gemini' && rawMessage.content === undefined && hasCalls
      ? null
      : rawMessage.content;
  if (typeof content !== 'string' && content !== null)
    throw diagnostic(
      content === undefined ? 'missing_visible_output' : 'invalid_content',
      choice,
      rawMessage,
    );
  if (!hasCalls && (content === null || !content.trim()))
    throw diagnostic('missing_visible_output', choice, rawMessage);
  if (
    typeof runtime.model !== 'string' ||
    !runtime.model.trim() ||
    runtime.model.length > 200
  )
    throw diagnostic('missing_model', choice, rawMessage);
  const message = {
    ...rawMessage,
    role: 'assistant',
    content,
  } as AiModelCompletion['message'];
  const usage = record(runtime.usage) ? runtime.usage : null;
  return {
    message,
    model: runtime.model,
    promptTokens: safeInteger(usage?.prompt_tokens),
    completionTokens: safeInteger(usage?.completion_tokens),
    totalTokens: safeInteger(usage?.total_tokens),
    ...(provider === 'openrouter'
      ? { providerCostUsdMicros: costMicros(usage?.cost) }
      : {}),
    provider,
  };
}
