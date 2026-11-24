import Anthropic from '@anthropic-ai/sdk';
import { supportsServerFallback, type Completion } from '@morph/planner';

import type { Relay } from './server';

// Server-side model calls (official SDK). Prompts and conversations provided by the app (D-193);
// model, output limit, and thinking effort determined by the server. API key resides exclusively in
// the server process and never leaves the server.

export interface SdkRelayOptions {
  model: string;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
}

/** Keep only content blocks needed to be sent back verbatim during app corrections, and keep only these fields; `/v1/complete` accepts only these. */
function replayable(block: Anthropic.Beta.BetaContentBlock): unknown[] {
  if (block.type === 'text') return [{ type: 'text', text: block.text }];
  if (block.type === 'thinking') {
    return [{ type: 'thinking', thinking: block.thinking, signature: block.signature }];
  }
  if (block.type === 'redacted_thinking') return [{ type: 'redacted_thinking', data: block.data }];
  return [];
}

function requestParams(
  options: SdkRelayOptions,
  { system, messages }: Parameters<Relay>[0],
): Anthropic.Beta.MessageCreateParamsNonStreaming {
  return {
    model: options.model,
    max_tokens: options.maxTokens,
    // System prompt for the same app version remains unchanged, marked for caching to reduce duplicate request costs.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: messages as Anthropic.Beta.BetaMessageParam[],
    ...(options.effort ? { output_config: { effort: options.effort } } : {}),
  };
}

function toCompletion(response: Anthropic.Beta.BetaMessage): Completion {
  return {
    text: response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join(''),
    stopReason: response.stop_reason,
    content: response.content.flatMap(replayable),
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

export function createSdkRelay(client: Anthropic, options: SdkRelayOptions): Relay {
  return async (request): Promise<Completion> => {
    const response = await client.beta.messages.create({
      ...requestParams(options, request),
      ...(supportsServerFallback(options.model)
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
        : {}),
    });
    return toCompletion(response);
  };
}

export interface BatchTiming {
  /** Duration of no new requests before submitting accumulated requests as a batch. */
  idleMs?: number;
  /** Interval for querying batch status. */
  pollMs?: number;
  log?: (line: string) => void;
}

interface Pending {
  params: Anthropic.Beta.MessageCreateParamsNonStreaming;
  resolve: (completion: Completion) => void;
  reject: (error: unknown) => void;
}

/**
 * For evaluation use only: accumulates concurrently arriving requests into a batch, using the
 * Batch API (half price, but takes minutes to hours). Batch API does not accept fallbacks, so
 * refusal fallbacks are omitted here.
 */
export function createBatchRelay(
  client: Anthropic,
  options: SdkRelayOptions,
  { idleMs = 1_000, pollMs = 30_000, log }: BatchTiming = {},
): Relay {
  let queue: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async (pending: Pending[]) => {
    try {
      let batch = await client.beta.messages.batches.create({
        requests: pending.map((p, i) => ({ custom_id: String(i), params: p.params })),
      });
      log?.(`已提交批次 ${batch.id}（${pending.length} 个请求），等待结果…`);
      while (batch.processing_status !== 'ended') {
        await new Promise((r) => setTimeout(r, pollMs));
        batch = await client.beta.messages.batches.retrieve(batch.id);
      }
      // Result order is not fixed, matches requests back by `custom_id`.
      for await (const item of await client.beta.messages.batches.results(batch.id)) {
        const p = pending[Number(item.custom_id)];
        if (!p) continue;
        if (item.result.type === 'succeeded') p.resolve(toCompletion(item.result.message));
        else
          p.reject(
            new Error(
              item.result.type === 'errored'
                ? `批处理请求出错：${JSON.stringify(item.result.error)}`
                : `批处理请求未完成：${item.result.type}`,
            ),
          );
      }
      // For requests that already have results, this `reject` has no effect.
      for (const p of pending) p.reject(new Error('批处理结果里没有这个请求'));
    } catch (e) {
      for (const p of pending) p.reject(e);
    }
  };

  return (request) =>
    new Promise<Completion>((resolve, reject) => {
      queue.push({ params: requestParams(options, request), resolve, reject });
      clearTimeout(timer);
      timer = setTimeout(() => {
        const pending = queue;
        queue = [];
        void flush(pending);
      }, idleMs);
    });
}
