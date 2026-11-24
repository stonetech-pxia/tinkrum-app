import type { Registry } from '@morph/core';

import { supportsServerFallback } from './models';
import type { Complete, Completion } from './planner';
import { systemPromptFor } from './prompt';

// Transport layer for direct Claude HTTP API calls, used by the in-app "bring-your-own API key"
// mode. The official TypeScript SDK does not currently support React Native, so the app side uses
// fetch; the server still uses the SDK. The key is sent only in the request header to
// api.anthropic.com, and is never logged or exposed in error messages.

export const ANTHROPIC_API_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

export type AIErrorKind =
  | 'invalid_key'
  | 'permission'
  | 'spend_limit'
  | 'rate_limit'
  | 'overloaded'
  | 'not_found'
  | 'bad_request'
  | 'server'
  | 'timeout';

/** Error shared by both bring-your-own-key transport layers (Claude and OpenAI-compatible interfaces). */
export class AIHttpError extends Error {
  constructor(
    readonly kind: AIErrorKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ErrorBody {
  error?: { type?: string; message?: string; details?: { error_code?: string } };
}

function classify(status: number, body: ErrorBody | null): AIErrorKind {
  const type = body?.error?.type;
  const message = body?.error?.message ?? '';
  if (status === 401 || type === 'authentication_error') return 'invalid_key';
  if (status === 403 || type === 'permission_error') return 'permission';
  if (body?.error?.details?.error_code === 'enforced_spend_limit_reached') return 'spend_limit';
  if (status === 400 && /usage limits/i.test(message)) return 'spend_limit';
  if (status === 429) return 'rate_limit';
  if (status === 529 || type === 'overloaded_error') return 'overloaded';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'bad_request';
}

export interface HttpOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

async function request(
  path: string,
  init: RequestInit & { headers: Record<string, string> },
  options: HttpOptions,
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  try {
    const response = await fetchImpl(`${options.baseUrl ?? ANTHROPIC_API_URL}${path}`, {
      ...init,
      headers: {
        'x-api-key': options.apiKey,
        'anthropic-version': API_VERSION,
        ...init.headers,
      },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const kind = classify(response.status, body as ErrorBody | null);
      throw new AIHttpError(kind, response.status, `Claude API error ${response.status} (${kind})`);
    }
    return body;
  } catch (e) {
    if (controller.signal.aborted)
      throw new AIHttpError('timeout', 0, 'Claude API request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface HttpCompleterOptions extends HttpOptions {
  model: string;
  registry: Registry;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
}

interface MessageResponse {
  content: { type: string; text?: string }[];
  stop_reason: string | null;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

export function createHttpCompleter(options: HttpCompleterOptions): Complete {
  const fallback = supportsServerFallback(options.model);
  return async (messages, system): Promise<Completion> => {
    const body = {
      model: options.model,
      max_tokens: 16000,
      // System prompt is stable, tagged with caching to reduce duplicate request costs.
      system: [
        {
          type: 'text',
          text: system ?? systemPromptFor(options.registry),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages,
      ...(options.effort ? { output_config: { effort: options.effort } } : {}),
      ...(fallback ? { fallbacks: 'default' } : {}),
    };
    const data = (await request(
      '/v1/messages',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
        },
        body: JSON.stringify(body),
      },
      options,
    )) as MessageResponse;
    return {
      text: data.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(''),
      stopReason: data.stop_reason,
      content: data.content,
      model: data.model,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: data.usage.cache_creation_input_tokens ?? 0,
      },
    };
  };
}

/** Check whether the key is valid and has access to the model. Uses the Models API, consuming no tokens. */
export async function checkModelAccess(model: string, options: HttpOptions): Promise<void> {
  await request(`/v1/models/${encodeURIComponent(model)}`, { method: 'GET', headers: {} }, options);
}
