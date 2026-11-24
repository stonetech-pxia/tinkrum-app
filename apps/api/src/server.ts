import { createHash, timingSafeEqual } from 'node:crypto';

import type { Completion, PlannerMessage } from '@morph/planner';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

// Model relay (D-193): App sends system prompt and conversation, server attaches key and relays to
// Claude using its own chosen model, returning the response as-is. The server is agnostic to
// schemas, tools, and prompts, allowing the app to upgrade without server changes; model output is
// validated by the app (§8). Since prompts are provided by the app, abuse prevention relies on:
// accepting only request shapes required for planning, rate limiting by amount, penalizing/banning
// devices for non-plan-like responses, and pre-release device attestation (P-024). Feature requests
// (D-189): when AI fails, user tapping "Tell us about this feature" sends that single sentence to
// /v1/needs, storing it in needs. Test-period request saving (D-240): when requests is provided,
// every successful relay saves the prompt, conversation, and response to debug sentences
// misunderstood by the AI.

/** Single relay: contains only system prompt and conversation; all other parameters (model, max output tokens, thinking effort) are determined by the server. */
export type Relay = (request: {
  system: string;
  messages: PlannerMessage[];
}) => Promise<Completion>;

/** USD / million tokens. Cache writes are billed at 1.25x the input price. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ServerOptions {
  /** Null when ANTHROPIC_API_KEY is not configured, causing /v1/complete to return 503. */
  relay: Relay | null;
  model: string | null;
  price: Price;
  /** Maximum requests per device per minute (prevents accidental or rapid-loop quota exhaustion). */
  perMinuteLimit: number;
  /** Maximum USD spend per device per day. */
  deviceDailyUsd: number;
  /** Maximum total USD spend across all devices per day. Since tokens and device IDs can be forged, this is the true spending cap (D-132). */
  globalDailyUsd: number;
  /** Number of times a device gives a non-plan-like response in a day before relays are stopped for that day. */
  offPlanLimit: number;
  /** When set, requests must include the x-morph-client header. Temporary protection before login authentication goes live (D-132). */
  clientToken?: string;
  /** Maximum output tokens per relay response (matches relay max_tokens); reserved for in-flight requests, defaulting to 16000. */
  maxOutputTokens?: number;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  /** Feature requests (D-189): stores user-submitted feature requests; when absent, /v1/needs returns 503. */
  needs?: NeedStore;
  /** Maximum feature requests per device per day. */
  needsPerDeviceLimit?: number;
  /** Maximum total feature requests accepted across all devices per day. */
  needsDailyLimit?: number;
  /** Test-period request saving (D-240): when absent, requests are not saved. */
  requests?: RequestStore;
}

/** A successful relayed request: device ID stores only a hash (like logs), without raw ID or IP. */
export interface RequestEntry {
  at: string;
  device: string;
  platform?: string | undefined;
  appVersion?: string | undefined;
  round: 1 | 2;
  system: string;
  messages: PlannerMessage[];
  reply: string;
  stopReason: Completion['stopReason'];
  inputTokens: number;
  outputTokens: number;
}

export interface RequestStore {
  append(entry: RequestEntry): Promise<void>;
}

export interface NeedEntry {
  at: string;
  text: string;
  locale: 'en' | 'zh' | 'fr';
  reason: string;
  /** AI type used: mock (built-in rules), server, byok. Many sentences misunderstood by built-in rules are due to rule limitations. */
  ai?: string | undefined;
  platform?: string | undefined;
  appVersion?: string | undefined;
}

export interface NeedStore {
  append(entry: NeedEntry): Promise<void>;
}

const NeedRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(500),
  locale: z.enum(['en', 'zh', 'fr']),
  reason: z.enum(['unknown', 'errand', 'notInstalled']),
  ai: z.enum(['mock', 'server', 'byok']).optional(),
  platform: z.enum(['ios', 'android']).optional(),
  appVersion: z
    .string()
    .regex(/^[0-9A-Za-z.+-]{1,32}$/)
    .optional(),
});

// Accepts only shapes required for planning: initial request, or a sequence of three ("request,
// model response, correction"). User messages must be text only (no images or files), and model
// responses must be its own returned text and thinking blocks. Clients cannot specify models,
// tools, or any other parameters. Large configs (D7): config is included in user messages along
// with instructions. Limits are character-based, whereas bodyLimit below is byte-based.
const MAX_USER_MESSAGE = 128_000;
const UserMessage = z.strictObject({
  role: z.literal('user'),
  content: z.string().min(1).max(MAX_USER_MESSAGE),
});
const AssistantMessage = z.strictObject({
  role: z.literal('assistant'),
  content: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('text'), text: z.string().max(64_000) }),
        z.strictObject({
          type: z.literal('thinking'),
          thinking: z.string().max(64_000),
          signature: z.string().max(64_000),
        }),
        z.strictObject({ type: z.literal('redacted_thinking'), data: z.string().max(64_000) }),
      ]),
    )
    .min(1)
    .max(8),
});
const CompleteRequestSchema = z.strictObject({
  system: z.string().min(1).max(192_000),
  messages: z.union([
    z.tuple([UserMessage]),
    z.tuple([UserMessage, AssistantMessage, UserMessage]),
  ]),
});

/** Checks whether a response resembles a modification plan: a JSON object with a string kind field. Independent of Plan versions, used solely for abuse scoring. */
export function looksLikePlan(text: string): boolean {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const value = JSON.parse(trimmed) as unknown;
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { kind?: unknown }).kind === 'string'
    );
  } catch {
    return false;
  }
}

export const costOf = (usage: Completion['usage'], price: Price) =>
  (usage.inputTokens * price.input +
    usage.cacheWriteTokens * price.input * 1.25 +
    usage.cacheReadTokens * price.cacheRead +
    usage.outputTokens * price.output) /
  1_000_000;

// Random ID generated on first app use, used solely for per-device rate limiting.
const DEVICE_ID = /^[A-Za-z0-9-]{8,64}$/;
const PLATFORM = /^(ios|android)$/;
const APP_VERSION = /^[0-9A-Za-z.+-]{1,32}$/;

const digest = (value: string) => createHash('sha256').update(value).digest();

interface DeviceUsage {
  recent: number[];
  /** Amount spent today (settled by actual usage after model response). */
  usd: number;
  /** Reserved and unsettled amount for in-flight requests. */
  reserved: number;
  offPlan: number;
}
interface Day {
  name: string;
  usd: number;
  reserved: number;
  devices: Map<string, DeviceUsage>;
}
const newDay = (name: string): Day => ({ name, usd: 0, reserved: 0, devices: new Map() });

export function createApp(options: ServerOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const tokenDigest = options.clientToken ? digest(options.clientToken) : null;
  // Each device's recent request timestamps, daily spend (including reserved amounts for in-flight
  // requests), and non-plan-like response counts; records only relayed requests, so size is
  // bounded. One entry per day: rolls over at date change, while prior-day in-flight requests
  // settle against their start day and are not charged to the new day.
  let today = newDay(new Date(now()).toDateString());
  /** Switches to a new day past midnight. */
  const dayNow = (t: number) => {
    const name = new Date(t).toDateString();
    if (name !== today.name) today = newDay(name);
    return today;
  };
  const maxOutputTokens = options.maxOutputTokens ?? 16_000;
  /**
   * Admission control: checks limits and registers if passed (minute count, reserved cost). Must
   * be no await between check and registration to ensure concurrent requests do not pass while
   * "no money spent" holds (R03). When reserve is null, checks only without registering. Spend
   * cap evaluated against "spent + in-flight reserved": maximum potential cost of in-flight
   * requests is reserved upfront and settled post-execution; requests are admitted as long as the
   * cap is not reached, allowing at most one request's cost to exceed the limit.
   */
  function admit(
    key: string,
    t: number,
    reserve: number | null,
  ):
    | { ok: false; status: 429 | 403; error: string }
    | { ok: true; day: Day; device: DeviceUsage; reserved: number } {
    const day = dayNow(t);
    if (day.usd >= options.globalDailyUsd) return { ok: false, status: 429, error: 'daily_limit' };
    if (day.usd + day.reserved >= options.globalDailyUsd)
      return { ok: false, status: 429, error: 'rate_limited' };
    const device = day.devices.get(key) ?? { recent: [], usd: 0, reserved: 0, offPlan: 0 };
    if (device.offPlan >= options.offPlanLimit) return { ok: false, status: 403, error: 'blocked' };
    while (device.recent.length > 0 && t - device.recent[0]! > 60_000) device.recent.shift();
    if (device.recent.length >= options.perMinuteLimit)
      return { ok: false, status: 429, error: 'rate_limited' };
    if (device.usd >= options.deviceDailyUsd)
      return { ok: false, status: 429, error: 'daily_limit' };
    if (device.usd + device.reserved >= options.deviceDailyUsd)
      return { ok: false, status: 429, error: 'rate_limited' };
    const reserved = reserve ?? 0;
    if (reserve !== null) {
      device.recent.push(t);
      device.reserved += reserved;
      day.reserved += reserved;
      day.devices.set(key, device);
    }
    return { ok: true, day, device, reserved };
  }

  const app = new Hono();

  const requireClient = async (c: Context, next: Next) => {
    if (tokenDigest && !timingSafeEqual(digest(c.req.header('x-morph-client') ?? ''), tokenDigest))
      return c.json({ error: 'unauthorized' }, 401);
    await next();
  };

  // Request counts: rate-limited strictly by device ID without persistent storage.
  let needDay = new Date(now()).toDateString();
  let needCount = 0;
  let needDevices = new Map<string, number>();

  app.get('/health', (c) =>
    c.json({ ok: true, ai: options.relay ? 'claude' : 'none', model: options.model }),
  );

  app.post(
    '/v1/needs',
    requireClient,
    bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
    async (c) => {
      if (!options.needs) return c.json({ error: 'not_collecting' }, 503);
      const deviceHeader = c.req.header('x-morph-device');
      if (deviceHeader !== undefined && !DEVICE_ID.test(deviceHeader))
        return c.json({ error: 'bad_request' }, 400);
      const t = now();
      const today = new Date(t).toDateString();
      if (today !== needDay) {
        needDay = today;
        needCount = 0;
        needDevices = new Map();
      }
      const device = deviceHeader ?? 'unknown';
      if (needCount >= (options.needsDailyLimit ?? 2000))
        return c.json({ error: 'daily_limit' }, 429);
      if ((needDevices.get(device) ?? 0) >= (options.needsPerDeviceLimit ?? 20))
        return c.json({ error: 'daily_limit' }, 429);
      const body = NeedRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: 'bad_request' }, 400);
      needDevices.set(device, (needDevices.get(device) ?? 0) + 1);
      needCount++;
      try {
        await options.needs.append({ at: new Date(t).toISOString(), ...body.data });
      } catch (e) {
        log({ event: 'need_error', error: String(e) });
        return c.json({ error: 'store_failed' }, 500);
      }
      log({ event: 'need', reason: body.data.reason, chars: body.data.text.length });
      return c.json({ ok: true });
    },
  );

  app.post(
    '/v1/complete',
    requireClient,
    // When entirely in Chinese (3 bytes per character in UTF-8): prompt 192k + two user messages
    // 128k + model response 64k = 512k characters ≈ 1.5 MiB, leaving margin for JSON escaping and
    // thinking blocks.
    bodyLimit({
      maxSize: 2 * 1024 * 1024,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
    async (c) => {
      if (!options.relay) return c.json({ error: 'ai_unavailable' }, 503);
      const deviceHeader = c.req.header('x-morph-device');
      if (deviceHeader !== undefined && !DEVICE_ID.test(deviceHeader))
        return c.json({ error: 'bad_request' }, 400);
      const t = now();
      const key = deviceHeader ?? 'unknown';
      // Perform an inexpensive preliminary check first (rejected requests bypass request body
      // parsing), followed by a second admission check after parsing: parsing requires await,
      // during which other requests might exhaust the quota.
      const early = admit(key, t, null);
      if (!early.ok) return c.json({ error: early.error }, early.status);

      const body = CompleteRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: 'bad_request' }, 400);

      // Reservation: inputs estimated at half of UTF-8 byte count for tokens (conservative), outputs at max; cache writes cost 25% more and are included.
      const inputBytes =
        Buffer.byteLength(body.data.system) +
        body.data.messages.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m.content)), 0);
      const reserve = costOf(
        {
          inputTokens: 0,
          cacheWriteTokens: Math.ceil(inputBytes / 2),
          cacheReadTokens: 0,
          outputTokens: maxOutputTokens,
        },
        options.price,
      );
      const admitted = admit(key, now(), reserve);
      if (!admitted.ok) return c.json({ error: admitted.error }, admitted.status);
      const { day, device } = admitted;
      // Settlement: reserved amount is refunded and actual spend is recorded. Logged to the day of admission (cross-day transitions do not spill over to the new day); settled exactly once.
      let open = true;
      const close = (usd: number) => {
        if (!open) return;
        open = false;
        device.reserved -= reserve;
        day.reserved -= reserve;
        device.usd += usd;
        day.usd += usd;
      };
      try {
        const completion = await options.relay(body.data);
        const usd = costOf(completion.usage, options.price);
        close(usd);
        const offPlan = completion.stopReason !== 'refusal' && !looksLikePlan(completion.text);
        if (offPlan) device.offPlan++;
        const deviceHash = digest(key).toString('hex').slice(0, 8);
        const round = body.data.messages.length === 1 ? 1 : 2;
        if (options.requests) {
          // Invalid platform and version formats are not saved but do not reject requests; save failures are logged while responses return normally.
          const platform = c.req.header('x-morph-platform');
          const appVersion = c.req.header('x-morph-version');
          await options.requests
            .append({
              at: new Date(t).toISOString(),
              device: deviceHash,
              ...(platform && PLATFORM.test(platform) ? { platform } : {}),
              ...(appVersion && APP_VERSION.test(appVersion) ? { appVersion } : {}),
              round,
              system: body.data.system,
              messages: body.data.messages,
              reply: completion.text,
              stopReason: completion.stopReason,
              inputTokens: completion.usage.inputTokens,
              outputTokens: completion.usage.outputTokens,
            })
            .catch((e: unknown) => log({ event: 'request_store_error', error: String(e) }));
        }
        // Logs record metadata only, excluding prompts, user inputs, or responses; device IDs store only the first 8 characters of their hash.
        log({
          event: 'complete',
          device: deviceHash,
          round,
          inputTokens: completion.usage.inputTokens,
          cacheReadTokens: completion.usage.cacheReadTokens,
          outputTokens: completion.usage.outputTokens,
          usd: Number(usd.toFixed(6)),
          ...(offPlan ? { offPlan: true } : {}),
          ms: now() - t,
        });
        return c.json(completion);
      } catch (e) {
        close(0);
        log({ event: 'complete_error', error: String(e), ms: now() - t });
        return c.json({ error: 'ai_unavailable' }, 502);
      }
    },
  );

  return app;
}
