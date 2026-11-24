import type { Registry } from '@morph/core';

import { AIHttpError, type AIErrorKind } from './http';
import type { Complete, Completion, PlannerMessage } from './planner';
import { systemPromptFor } from './prompt';

// Transport layer for OpenAI-compatible interfaces (POST {baseUrl}/chat/completions), used when
// "bring your own key" selects a non-Anthropic provider (D-241). Covers OpenAI, OpenRouter,
// DeepSeek, Gemini's compatible interface, Groq, Ollama, LM Studio, etc. Sends only standard fields
// (model, messages), omitting Anthropic-specific thinking effort and prompt caching, as well as
// response_format: not all providers support it, and responses always go through the planner's JSON
// parsing, validation, and correction. The key is placed only in the Authorization header and sent
// to the address filled in by the user; it is never written to logs or exposed in error messages.
// Local models do not require a key.

/** Base URLs of common providers, used only to help users fill in the address. */
export const OPENAI_COMPATIBLE_PRESETS: readonly { id: string; name: string; baseUrl: string }[] = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  {
    id: 'gemini',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
];

export type BaseUrlCheck = { ok: true; url: string } | { ok: false; issue: 'invalid' | 'insecure' };

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Check the Base URL entered by the user: must be https; http is allowed only for localhost
 * (localhost, 127.x, [::1]). Local network http is not allowed: Android release builds disable
 * plaintext requests by default, and the key would pass in plaintext over Wi-Fi (P-042). Avoids
 * `new URL`: React Native's URL does not support hostname.
 */
export function checkBaseUrl(raw: string): BaseUrlCheck {
  const match = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?(\/[^\s?#]*)?$/i.exec(
    raw.trim(),
  );
  if (!match || match[2]!.startsWith('.') || match[2]!.endsWith('.')) {
    return { ok: false, issue: 'invalid' };
  }
  const [, scheme, host, port = '', path = ''] = match;
  if (scheme!.toLowerCase() === 'http' && !LOOPBACK.test(host!)) {
    return { ok: false, issue: 'insecure' };
  }
  return {
    ok: true,
    url: `${scheme!.toLowerCase()}://${host!.toLowerCase()}${port}${path.replace(/\/+$/, '')}`,
  };
}

/** Hostname in the address, providing UI guidance on "where it is sent". */
export const hostOf = (url: string) => /^https?:\/\/([^/:]+|\[[^\]]+\])/i.exec(url)?.[1] ?? url;

interface ErrorBody {
  error?: { type?: string; code?: string | number; message?: string } | string;
}

function classify(status: number, body: ErrorBody | null): AIErrorKind {
  const error = typeof body?.error === 'object' ? body.error : undefined;
  const code = String(error?.code ?? error?.type ?? '');
  if (status === 401) return 'invalid_key';
  if (status === 402 || /insufficient_quota|billing/i.test(code)) return 'spend_limit';
  if (status === 403) return 'permission';
  if (status === 404 || code === 'model_not_found') return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'server';
  return 'bad_request';
}

export interface OpenAICompatibleOptions {
  baseUrl: string;
  /** Local models can have no key. */
  apiKey?: string | null | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function request(path: string, init: RequestInit, options: OpenAICompatibleOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  try {
    const response = await fetchImpl(`${options.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const kind = classify(response.status, body as ErrorBody | null);
      throw new AIHttpError(kind, response.status, `AI API error ${response.status} (${kind})`);
    }
    return body;
  } catch (e) {
    if (controller.signal.aborted) throw new AIHttpError('timeout', 0, 'AI API request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

interface ChatResponse {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | { type?: string; text?: string }[] | null;
      refusal?: string | null;
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  };
}

/** During correction retries, converts the previous round's content blocks ([{ type: 'text', text }]) back to a string. */
const toText = (content: PlannerMessage['content']) =>
  typeof content === 'string'
    ? content
    : content
        .map((b) =>
          (b as { type?: string; text?: string }).type === 'text'
            ? ((b as { text?: string }).text ?? '')
            : '',
        )
        .join('');

export interface OpenAICompletionOptions extends OpenAICompatibleOptions {
  model: string;
  registry: Registry;
}

export function createOpenAICompleter(options: OpenAICompletionOptions): Complete {
  return async (messages, system): Promise<Completion> => {
    const body = {
      model: options.model,
      messages: [
        { role: 'system', content: system ?? systemPromptFor(options.registry) },
        ...messages.map((m) => ({ role: m.role, content: toText(m.content) })),
      ],
    };
    const data = (await request(
      '/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      options,
    )) as ChatResponse | null;
    const choice = data?.choices?.[0];
    if (!choice?.message) {
      throw new AIHttpError('bad_request', 200, 'AI API reply had no message');
    }
    const raw = choice.message.content;
    const text = (typeof raw === 'string' ? raw : toText(raw ?? []))
      // Some reasoning models (such as locally run DeepSeek R1, Qwen) put the thinking process inside <think> tags, mixed with the answer.
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim();
    const refused = Boolean(choice.message.refusal) || choice.finish_reason === 'content_filter';
    return {
      text,
      // Normalize to the stop reason recognized by the planner: refusals are marked as refusal, and others are preserved as-is.
      stopReason: refused ? 'refusal' : (choice.finish_reason ?? null),
      content: [{ type: 'text', text }],
      model: data?.model ?? options.model,
      usage: {
        inputTokens: data?.usage?.prompt_tokens ?? 0,
        outputTokens: data?.usage?.completion_tokens ?? 0,
        cacheReadTokens: data?.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      },
    };
  };
}

/** List of model IDs provided by the vendor: GET {baseUrl}/models; returns an empty array if there is no list endpoint. */
export async function listOpenAICompatibleModels(
  options: OpenAICompatibleOptions,
): Promise<string[]> {
  const data = (await request('/models', { method: 'GET' }, options)) as {
    data?: { id?: unknown }[];
  } | null;
  const ids = Array.isArray(data?.data)
    ? data.data.flatMap((m) => (typeof m.id === 'string' && m.id ? [m.id] : []))
    : [];
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/**
 * Check whether the address and key are valid: GET {baseUrl}/models, consuming no tokens. Reports
 * not_found if the filled model cannot be found in the list; since model ID naming varies across
 * vendors (Gemini uses models/, Ollama uses :latest), uses loose comparison.
 */
export async function checkOpenAICompatible(
  model: string,
  options: OpenAICompatibleOptions,
): Promise<void> {
  const data = (await request('/models', { method: 'GET' }, options)) as {
    data?: { id?: string }[];
  } | null;
  const ids = Array.isArray(data?.data) ? data.data.map((m) => m.id ?? '') : [];
  if (ids.length === 0) return;
  const found = ids.some(
    (id) => id === model || id.endsWith(`/${model}`) || id === `${model}:latest`,
  );
  if (!found) throw new AIHttpError('not_found', 200, 'model not in the provider’s list');
}
