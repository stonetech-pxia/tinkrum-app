import type { AIProvider, Plan, Registry } from '@morph/core';
import {
  AIOutputError,
  RelayError,
  createClaudePlanner,
  createRelayCompleter,
} from '@morph/planner';

import type { NeedSender } from '../ai/settings';
import { t } from '../i18n';

// "Morph Server" mode (D-193): prompts, validation, and correction are performed on the phone just
// like "bring your own key", except model calls are proxied through the Morph server (which adds
// the key). The mobile client holds no API keys. Plans are re-validated by the store using
// PlanSchema and prepareOps.

export interface RemoteAIOptions {
  baseUrl: string;
  /** Client token bundled into the app (D-132); temporary protection before login auth goes live, not a secret. */
  clientToken?: string | undefined;
  /** Used for server-side rate limiting per device. */
  deviceId?: () => Promise<string | null>;
  platform?: 'ios' | 'android';
  appVersion?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const ERROR_KEYS = {
  rate_limited: 'aiRateLimited',
  daily_limit: 'aiDailyLimit',
} as const;

export function createRemoteAIProvider(
  options: RemoteAIOptions & { registry: Registry; now: () => Date },
): AIProvider {
  const planner = createClaudePlanner({
    complete: createRelayCompleter(options),
    registry: options.registry,
    now: options.now,
  });
  return {
    async plan(input, ctx): Promise<Plan> {
      const unavailable = (
        key: 'aiUnavailable' | 'aiRateLimited' | 'aiDailyLimit' | 'aiBadOutput',
      ): Plan => ({
        kind: 'reject',
        reason: 'unavailable',
        message: t(ctx.locale, key),
        examples: [],
      });
      try {
        return await planner.plan(input, ctx);
      } catch (e) {
        if (e instanceof AIOutputError) return unavailable('aiBadOutput');
        const key =
          e instanceof RelayError ? ERROR_KEYS[e.code as keyof typeof ERROR_KEYS] : undefined;
        return unavailable(key ?? 'aiUnavailable');
      }
    },
  };
}

/**
 * Need collection (D-189): when AI cannot fulfill a request, user taps "Tell us about this need",
 * sending that single sentence, language, refusal reason, AI type, platform, and version to
 * /v1/needs. Sends only the sentence, config, files, and records are not sent. Device ID is used
 * only for server rate limiting and is not stored.
 */
export function createNeedSender(options: RemoteAIOptions): NeedSender {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (need) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    try {
      const device = await options.deviceId?.();
      const response = await fetchImpl(`${options.baseUrl}/v1/needs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.clientToken ? { 'x-morph-client': options.clientToken } : {}),
          ...(device ? { 'x-morph-device': device } : {}),
        },
        body: JSON.stringify({
          text: need.text,
          locale: need.locale,
          reason: need.reason,
          ai: need.ai,
          ...(options.platform ? { platform: options.platform } : {}),
          ...(options.appVersion ? { appVersion: options.appVersion } : {}),
        }),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
