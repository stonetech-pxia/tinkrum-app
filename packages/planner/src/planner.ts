import {
  t,
  FIXED_BY_A_LATER_STEP,
  PlanSchema,
  checkRequestParams,
  checkTools,
  expandPresetWorkflows,
  issueLines,
  prepareOps,
  hiddenIdsForAI,
  redactForAI,
  scopedViewForAI,
  type AIProvider,
  type Locale,
  type Plan,
  type Registry,
  type ToolIssue,
  type WorkspaceConfig,
} from '@morph/core';

import {
  buildRepairMessage,
  buildToolRepairMessage,
  buildUserMessage,
  systemPromptFor,
  type PromptRoute,
} from './prompt';
import { routeRequest } from './route';

// Planner: server (SDK) and in-app (HTTP, user bring-your-own-key, Claude or OpenAI-compatible
// interface) share the same logic. The model replies with JSON text conforming to core's Plan
// format; all replies go through PlanSchema and prepareOps validation, requesting a correction with
// specific issues when invalid (§8: model output is never trusted directly). Validated plans then
// run tool checks (AGENT_PLAN §3.6): if a new "tool unusable" issue is found, it is sent back to
// request another attempt. Maximum 3 model calls per round (initial, format repair, tool remedy);
// writing is not counted here, and is performed after the app receives the result (Invariant 16).

export interface PlannerMessage {
  role: 'user' | 'assistant';
  /** String, or the raw content blocks returned by the model in the previous round (appended as-is during correction retries). */
  content: string | unknown[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Completion {
  /** Text portion of the reply. */
  text: string;
  stopReason: string | null;
  /** Complete content blocks returned by the model. */
  content: unknown[];
  model: string;
  usage: Usage;
}

/**
 * A single model call. The transport method (SDK, HTTP, test double) is provided by the caller.
 * system is the system prompt used for this call (loaded on demand to contain only the parts
 * selected by routing); when omitted, the transport layer uses the complete prompt.
 */
export type Complete = (messages: PlannerMessage[], system?: string) => Promise<Completion>;

export class AIOutputError extends Error {}

export interface PlannerOptions {
  complete: Complete;
  registry: Registry;
  now: () => Date;
  /** Number of requests with the issue list when the reply is invalid. */
  maxRepairs?: number;
  onCompletion?: (completion: Completion) => void;
  /**
   * On-demand prompt loading (route.ts): off by default (founder, 2026-10-31), sending the full
   * prompt every time; when true, sends only the required parts based on routing. onRoute reports
   * the route used for each request (used for evaluation statistics).
   */
  route?: boolean;
  onRoute?: (route: PromptRoute) => void;
}

/** Maximum remedy attempts for tool checks. */
const MAX_TOOL_REPAIRS = 1;

const refusalMessage = (locale: 'en' | 'zh' | 'fr') =>
  t(locale, 'planner_This_request_can_t_be_handled_Try_desc_04270');

/**
 * Extract JSON from reply text (tolerant of code block markers occasionally added by models).
 * Non-Claude models often wrap JSON with extra text; if full-text parsing fails, retries parsing
 * the substring between the first { and the last }.
 */
export function parseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; issue: string } {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  for (const candidate of [
    trimmed,
    start >= 0 && end > start ? trimmed.slice(start, end + 1) : null,
  ]) {
    if (candidate === null) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Try the next one
    }
  }
  return { ok: false, issue: 'the reply was not a single valid JSON object' };
}

function isNeedMore(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'needMore'
  );
}

type OpsPlan = Extract<Plan, { kind: 'ops' }>;

/**
 * Severe issues newly introduced by this plan: counts only additional blockers compared to before
 * the change, plus counts and terms from the user utterance not mapped to parameters. By count
 * comparison: adding one more issue in the same place (another required field left unfilled)
 * counts as new; pre-existing issues merely rephrased do not count.
 */
function newToolIssues(
  input: string,
  locale: Locale,
  before: WorkspaceConfig,
  after: WorkspaceConfig,
  plan: OpsPlan,
  registry: Registry,
  /** moreSteps: boolean, indicating this is a step of a building plan with subsequent steps to follow: pages may appear later (same as next, rule 53). */
  moreSteps: boolean,
): ToolIssue[] {
  const keyOf = (i: ToolIssue) => `${i.code}|${i.target}`;
  const blockers = (config: WorkspaceConfig) =>
    checkTools(config, registry).issues.filter((i) => i.severity === 'blocker');
  const old = new Map<string, number>();
  for (const i of blockers(before)) old.set(keyOf(i), (old.get(keyOf(i)) ?? 0) + 1);

  const had = (ids: { id: string }[]) => new Set(ids.map((x) => x.id));
  const tablesBefore = had(before.data.tables);
  const pagesBefore = had(before.containers.pages);
  const newTables =
    plan.next || moreSteps ? after.data.tables.filter((t) => !tablesBefore.has(t.id)) : [];
  const later = (i: ToolIssue) => {
    if (newTables.length === 0 || !FIXED_BY_A_LATER_STEP.has(i.code)) return false;
    if (i.target.startsWith('page:')) return !pagesBefore.has(i.target.slice('page:'.length));
    return newTables.some((t) => i.target === `table:${t.id}`);
  };

  const added = blockers(after).filter((i) => {
    const left = old.get(keyOf(i)) ?? 0;
    if (left > 0) old.set(keyOf(i), left - 1);
    return left === 0 && !later(i);
  });
  return [...added, ...checkRequestParams(input, locale, before, after)];
}

/** Issues remaining after remedies: plan is still returned (reminders only, no refusal per Invariant 19), with a note in the user's language. Maximum 4 notes. */
function withToolNotes(plan: OpsPlan, issues: readonly ToolIssue[], locale: Locale): OpsPlan {
  if (issues.length === 0) return plan;
  const ours = [
    ...(issues.some((i) => i.code.startsWith('param-')) ? [t(locale, 'planCheckParams')] : []),
    ...(issues.some((i) => !i.code.startsWith('param-')) ? [t(locale, 'planCheckTools')] : []),
  ];
  return { ...plan, notes: [...(plan.notes ?? []).slice(0, 4 - ours.length), ...ours] };
}

/**
 * Old replies sent back to the model retain only text: intermediate replies during corrections
 * have changed, thinking blocks and context mismatch, and the API might reject them. When the
 * model writes nothing, inserts a placeholder: both /v1/complete and the Claude API reject empty
 * content.
 */
function replayableReply(completion: Completion): unknown[] {
  const texts = completion.content.flatMap((block) => {
    const { type, text } = block as { type?: unknown; text?: unknown };
    return type === 'text' && typeof text === 'string' && text.length > 0
      ? [{ type: 'text', text }]
      : [];
  });
  return texts.length > 0 ? texts : [{ type: 'text', text: '(no text in the reply)' }];
}

export function createClaudePlanner(options: PlannerOptions): AIProvider {
  const maxRepairs = options.maxRepairs ?? 1;
  return {
    async plan(input, ctx) {
      const first: PlannerMessage = {
        role: 'user',
        content: buildUserMessage(
          // In-app: the model sees only a portion of this app (D-485), and changes are executed and scope-checked against the complete configuration.
          ctx.scope
            ? scopedViewForAI(redactForAI(ctx.config, ctx.registry), ctx.scope.appId)
            : redactForAI(ctx.config, ctx.registry),
          input,
          ctx.locale,
          ctx.about,
          ctx.earlier,
          ctx.registry,
          ctx.session,
          ctx.scope
            ? { appId: ctx.scope.appId, hidden: hiddenIdsForAI(ctx.config, ctx.scope.appId) }
            : undefined,
        ),
      };
      // Always 1 or 3 items (user message, latest reply, latest correction): server /v1/complete accepts only these two structures.
      let messages: PlannerMessage[] = [first];
      let route: PromptRoute =
        options.route !== true
          ? 'full'
          : routeRequest({
              input,
              config: ctx.config,
              about: ctx.about,
              earlier: ctx.earlier ?? ctx.session?.recent,
            });
      let repairs = 0;
      let toolRepairs = 0;
      /** Currently best valid plan: fallback to this when remedies fail (invalid, refused, error), avoiding turning a usable result into a failure. */
      let best: { plan: OpsPlan; issues: ToolIssue[] } | null = null;
      const settle = (b: NonNullable<typeof best>) => withToolNotes(b.plan, b.issues, ctx.locale);
      for (;;) {
        options.onRoute?.(route);
        ctx.onProgress?.(repairs + toolRepairs > 0 ? 'fixing' : route);
        let completion: Completion;
        try {
          completion = await options.complete(messages, systemPromptFor(options.registry, route));
        } catch (e) {
          if (best) return settle(best);
          throw e;
        }
        options.onCompletion?.(completion);
        ctx.onProgress?.('checking');
        if (completion.stopReason === 'refusal') {
          if (best) return settle(best);
          return {
            kind: 'reject',
            reason: 'unknown',
            message: refusalMessage(ctx.locale),
            examples: [],
          };
        }

        let issues: string[];
        const json = parseJson(completion.text);
        // Model requests parts that were omitted (needMore): switches to the full prompt and re-asks the same sentence, without counting towards correction limits.
        if (route !== 'full' && json.ok && isNeedMore(json.value)) {
          route = 'full';
          continue;
        }
        // Preset shorthand addTool ({tool: {preset, params?}}) is first expanded into full quick actions (D-259).
        const expanded = json.ok ? expandPresetWorkflows(json.value, ctx.config, ctx.locale) : null;
        const parsed =
          expanded && !expanded.issues.length ? PlanSchema.safeParse(expanded.value) : null;
        if (!json.ok) {
          issues = [json.issue];
        } else if (expanded!.issues.length) {
          issues = expanded!.issues;
        } else if (!parsed!.success) {
          issues = issueLines(parsed!.error);
        } else {
          const plan = parsed!.data;
          if (plan.kind === 'build' && ctx.session?.step) {
            // Already executing a plan step, cannot generate another plan (rule 53).
            if (best) return settle(best);
            if (repairs >= maxRepairs)
              throw new AIOutputError('unusable model reply: a plan inside a step');
            repairs++;
            messages = [
              first,
              { role: 'assistant', content: replayableReply(completion) },
              {
                role: 'user',
                content: buildRepairMessage([
                  'this is one step of a plan the user already started: reply with ops for this step, not another build plan',
                ]),
              },
            ];
            route = 'full';
            continue;
          }
          if (plan.kind !== 'ops') return best ? settle(best) : plan;
          const prepared = prepareOps(ctx.config, plan.ops, {
            registry: options.registry,
            locale: ctx.locale,
            now: options.now(),
            fromAI: true,
            ...(ctx.scope ? { scope: ctx.scope } : {}),
          });
          if (prepared.ok) {
            const found = newToolIssues(
              input,
              ctx.locale,
              ctx.config,
              prepared.after,
              plan,
              options.registry,
              (ctx.session?.step?.remaining ?? 0) > 0,
            );
            // If issues do not decrease after remedy, keep the previous one; if equal in count, use the new one (model has reviewed the issues).
            if (!best || found.length <= best.issues.length) best = { plan, issues: found };
            if (best.issues.length === 0) return best.plan;
            if (toolRepairs >= MAX_TOOL_REPAIRS) return settle(best);
            toolRepairs++;
            messages = [
              first,
              { role: 'assistant', content: replayableReply(completion) },
              {
                role: 'user',
                content: buildToolRepairMessage(found.map((i) => i.message)),
              },
            ];
            route = 'full';
            continue;
          }
          issues = prepared.issues;
          // Returns as-is when correction attempts are exhausted; app-level validation intercepts and explains it to the user.
          if (!best && repairs >= maxRepairs) return plan;
        }
        if (best) return settle(best);
        if (repairs >= maxRepairs) {
          throw new AIOutputError(`unusable model reply: ${issues.join('; ')}`);
        }
        repairs++;
        messages = [
          first,
          { role: 'assistant', content: replayableReply(completion) },
          { role: 'user', content: buildRepairMessage(issues) },
        ];
        // Use complete prompts during correction: omitted parts might contain the correct syntax needed for the fix.
        route = 'full';
      }
    },
  };
}
