import type { Registry } from '@morph/core';

import type { Complete, Completion } from './planner';
import { systemPromptFor } from './prompt';

// Transport layer for "Morph server" mode (D-193): prompts, validation, and corrections happen
// entirely in the app, same as "self-provided key"; the server only attaches the key and forwards
// to Claude, without understanding schemas, tools, or prompts, so the server doesn't need updates
// when the app upgrades.

export interface RelayCompleterOptions {
  baseUrl: string;
  registry: Registry;
  /** Client token bundled into the app (D-132); not a secret. */
  clientToken?: string | undefined;
  /** Used for server-side rate limiting per device. */
  deviceId?: (() => Promise<string | null>) | undefined;
  /** Platform saved with requests during testing period (D-240). */
  platform?: 'ios' | 'android' | undefined;
  appVersion?: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Server rejection or connection failure. code is the error returned by the server (rate_limited, daily_limit, etc.), or network / timeout. */
export class RelayError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`Morph relay error ${status} (${code})`);
  }
}

export function createRelayCompleter(options: RelayCompleterOptions): Complete {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (messages, system): Promise<Completion> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45_000);
    try {
      const device = await options.deviceId?.();
      const response = await fetchImpl(`${options.baseUrl}/v1/complete`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.clientToken ? { 'x-morph-client': options.clientToken } : {}),
          ...(device ? { 'x-morph-device': device } : {}),
          ...(options.platform ? { 'x-morph-platform': options.platform } : {}),
          ...(options.appVersion ? { 'x-morph-version': options.appVersion } : {}),
        },
        body: JSON.stringify({ system: system ?? systemPromptFor(options.registry), messages }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as
        (Completion & { error?: string }) | null;
      if (!response.ok || !body || typeof body.text !== 'string') {
        throw new RelayError(body?.error ?? 'unavailable', response.status);
      }
      return body;
    } catch (e) {
      if (e instanceof RelayError) throw e;
      throw new RelayError(controller.signal.aborted ? 'timeout' : 'network', 0);
    } finally {
      clearTimeout(timer);
    }
  };
}
