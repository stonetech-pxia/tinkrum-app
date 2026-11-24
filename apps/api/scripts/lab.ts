import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  BUILTIN_TOOLS,
  applicableOps,
  applyOps,
  buildItemId,
  deferredLookText,
  checkTools,
  createRegistry,
  emptySession,
  functionFirst,
  issueReason,
  planSession,
  prepareOps,
  recheckItems,
  recordTurn,
  setItemStatus,
  splitDraftOnlyOps,
  startBuildItems,
  toolVerdict,
  workKindOfOps,
  type Locale,
  type Op,
  type Plan,
  type PlanAbout,
  type PlanEarlier,
  type SessionTurn,
  type WorkSession,
  type WorkspaceConfig,
} from '@morph/core';
import {
  EVAL_CASES,
  SCENARIOS,
  buildSetup,
  nextAsk,
  runEvalCase,
  scoreScenario,
  type EvalCase,
  type EvalSetup,
  type Scenario,
  type ScenarioScore,
} from '@morph/core/src/eval';

import {
  MODELS,
  createClaudePlanner,
  createRelayCompleter,
  systemPromptFor,
  type Complete,
  type Completion,
  type PlannerMessage,
} from '@morph/planner';

import { createRelayRuntime, loadRootEnv } from '../src/config';
import { createApp } from '../src/server';

// Prompt testing workbench (`side-session-notes/agent-test-plan/PLAN.md`): extends `eval.ts` with
// repeated runs, concurrency, comprehensive logging, and general checks. Usage: `npx tsx
// scripts/lab.ts --out runs/x.jsonl [--suite eval|<cases.json>] [--cases A1,C1] [--repeat 5]`
//        [--concurrency 16] [--model claude-haiku-5-5] [--effort low] [--drop-rule 17,44] [--rule-first 51] [--resume]
// Personal record capability acceptance: `npx tsx scripts/lab.ts --out runs/accept.jsonl
// --acceptance [--acceptance-ids habit-simple,todo-board]` follows the same flow as `--app-flow`,
// outputting an opening statement, then proceeding sentence by sentence through failed core items
// (up to 4 rounds), and finally tapping "Fix these" once. Statistics are handled by
// `lab-accept-report.ts`. `cases.json` is an array where each item is `{id, input or turns, locale,
// setup, about?, earlier?, expect?, rubric?, tags?, configFile?}`. There is no check, only logging;
// judgment is delegated to `lab-judge.ts`. `turns` is a long conversation, sentence by sentence
// following app behavior.

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    suite: { type: 'string' },
    cases: { type: 'string' },
    repeat: { type: 'string' },
    concurrency: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    'drop-rule': { type: 'string' },
    'rule-first': { type: 'string' },
    resume: { type: 'boolean' },
    'strip-examples': { type: 'boolean' },
    'max-repairs': { type: 'string' },
    route: { type: 'boolean' },
    // Same flow as the app (`runAppFlow`): look changes enter a draft, feature changes take effect immediately, each sentence includes a tool inventory, and large tasks are performed incrementally.
    'app-flow': { type: 'boolean' },
    acceptance: { type: 'boolean' },
    'acceptance-ids': { type: 'string' },
    // Change opening statement (scenario ID -> a vague phrase); requirements and scoring remain unchanged.
    'acceptance-openings': { type: 'string' },
  },
});

interface LabCase {
  id: string;
  input?: string;
  turns?: string[];
  locale: Locale;
  setup: EvalSetup;
  about?: PlanAbout;
  earlier?: PlanEarlier[];
  expect?: { kind: string; reason?: string };
  rubric?: string;
  tags?: string[];
  /** Configuration comes from a file (scale testing), overriding setup. */
  configFile?: string;
  /** Additional operations to be performed prior to existing setup (e.g., single record page). */
  setupOps?: unknown[];
}

interface CallLog {
  text: string;
  stopReason: string | null;
  usage: Completion['usage'];
  ms: number;
  /** This invocation is a repair: list of issues sent to the model. */
  repair?: string;
}

loadRootEnv();
const env = { ...process.env };
if (values.model) env.MORPH_AI_MODEL = values.model;
if (values.effort) env.MORPH_AI_EFFORT = values.effort;
const out = values.out;
if (!out) throw new Error('--out 必填');

// Budget (founder 2026-11-03: use Haiku only, total budget $10): cumulative cost is recorded in `LAB_LEDGER`, stops when limit is reached.
const LEDGER = process.env.LAB_LEDGER;
const BUDGET = 10;
if (!LEDGER) throw new Error('需要 LAB_LEDGER');
if ((env.MORPH_AI_MODEL ?? 'claude-haiku-5-5') !== 'claude-haiku-5-5')
  throw new Error('只能用 Haiku');
const spent = () => (existsSync(LEDGER) ? Number(readFileSync(LEDGER, 'utf8')) : 0);
const usdOf = (u: Completion['usage']) =>
  (u.inputTokens * 0.1 +
    u.cacheWriteTokens * 0.125 +
    u.outputTokens * 0.5 +
    u.cacheReadTokens * 0.01) /
  1_000_000;
function charge(u: Completion['usage']) {
  writeFileSync(LEDGER!, String(spent() + usdOf(u)));
}

const runtime = createRelayRuntime(env);
if (!runtime.relay) throw new Error('未配置 ANTHROPIC_API_KEY');
const registry = createRegistry(BUILTIN_TOOLS);
const server = createApp({
  ...runtime,
  perMinuteLimit: 1_000_000,
  deviceDailyUsd: 1_000_000,
  globalDailyUsd: 1_000_000,
  offPlanLimit: 1_000_000,
  log: () => {},
});
const relay = createRelayCompleter({
  baseUrl: 'http://relay.test',
  registry,
  timeoutMs: 300_000,
  fetchImpl: ((url: string, init?: RequestInit) => server.request(url, init)) as typeof fetch,
});

/** Ablation study: remove or move rules forward. Rules are under `## Rules`, one per line, starting with "number. ". */
const ruleLine = (n: number) => new RegExp(`^${n}\\. .*\\n`, 'm');
function transformSystem(system: string): string {
  let s = system;
  for (const n of (values['drop-rule'] ?? '').split(',').filter(Boolean)) {
    if (!ruleLine(Number(n)).test(s)) throw new Error(`没有规则 ${n}`);
    s = s.replace(ruleLine(Number(n)), '');
  }
  if (values['rule-first']) {
    const m = s.match(ruleLine(Number(values['rule-first'])));
    if (!m) throw new Error('没有这条规则');
    s = s.replace(m[0], '').replace('## Rules\n', `## Rules\n${m[0]}`);
  }
  // Remove example sentences in parentheses (user utterances) from rules to see if rules still work without examples.
  if (values['strip-examples']) {
    const start = s.indexOf('## Rules');
    const end = s.indexOf('\n## ', start + 1);
    const rules = s
      .slice(start, end)
      .replace(/\s*\((?:e\.g\. )?["“「][^()]*?\)/g, '')
      .replace(/ → /g, ' → ');
    s = s.slice(0, start) + rules + s.slice(end);
  }
  return s;
}

const baseSystem = transformSystem(systemPromptFor(registry));
const promptHash = createHash('sha256').update(baseSystem).digest('hex').slice(0, 12);
const INFRA = /Morph relay error/;

function logged(calls: CallLog[]): Complete {
  return async (messages: PlannerMessage[], system?: string) => {
    const last = messages.at(-1);
    const started = Date.now();
    let completion: Completion | undefined;
    for (let tries = 0; ; tries++) {
      try {
        completion = await relay(messages, transformSystem(system ?? systemPromptFor(registry)));
        break;
      } catch (e) {
        if (tries >= 6 || !INFRA.test(String(e))) throw e;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** tries));
      }
    }
    charge(completion.usage);
    calls.push({
      text: completion.text,
      stopReason: completion.stopReason,
      usage: completion.usage,
      ms: Date.now() - started,
      ...(messages.length > 1 && typeof last?.content === 'string' ? { repair: last.content } : {}),
    });
    return completion;
  };
}

/** Sort keys before comparing: validation adjusts key order, which is not considered a change. */
const json = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
const ctxFor = (locale: Locale) => ({ registry, locale, now: new Date() });

/** Differences between previous and subsequent configurations, listed in user-understandable terms: used for general "accidentally changed something else" checks. */
function scopeOf(before: WorkspaceConfig, after: WorkspaceConfig): string[] {
  const changes: string[] = [];
  const diffById = <T extends { id: string }>(
    label: string,
    a: readonly T[],
    b: readonly T[],
    inner?: (x: T, y: T) => string[],
  ) => {
    const left = new Map(a.map((x) => [x.id, x]));
    const right = new Map(b.map((x) => [x.id, x]));
    for (const [id, x] of right) {
      const old = left.get(id);
      if (!old) changes.push(`+${label}:${id}`);
      else if (json(old) !== json(x)) {
        const nested = inner?.(old, x) ?? [];
        changes.push(...(nested.length ? nested : [`~${label}:${id}`]));
      }
    }
    for (const id of left.keys()) if (!right.has(id)) changes.push(`-${label}:${id}`);
  };
  type Page = WorkspaceConfig['containers']['pages'][number];
  diffById('page', before.containers.pages, after.containers.pages, (x: Page, y: Page) => {
    const own: string[] = [];
    const blocksIn = (p: Page) => p.blocks as unknown as { id: string }[];
    const l = new Map(blocksIn(x).map((b) => [b.id, json(b)]));
    const r = new Map(blocksIn(y).map((b) => [b.id, json(b)]));
    for (const [id, v] of r) {
      if (!l.has(id)) own.push(`+block:${x.id}/${id}`);
      else if (l.get(id) !== v) own.push(`~block:${x.id}/${id}`);
    }
    for (const id of l.keys()) if (!r.has(id)) own.push(`-block:${x.id}/${id}`);
    const order = (p: Page) => json(blocksIn(p).map((b) => b.id));
    if (order(x) !== order(y)) own.push(`~order:${x.id}`);
    if (x.title !== y.title) own.push(`~title:${x.id}`);
    return own;
  });
  diffById('table', before.data.tables, after.data.tables);
  diffById(
    'tool',
    before.tools as unknown as { id: string }[],
    after.tools as unknown as { id: string }[],
  );
  for (const key of ['theme', 'nav', 'packages'] as const) {
    if (json(before[key]) !== json(after[key])) changes.push(`~${key}`);
  }
  if (json(before.data.calendar) !== json(after.data.calendar)) changes.push('~calendar');
  if (json(before.containers.desk) !== json(after.containers.desk)) changes.push('~desk');
  return changes;
}

/** Sentences shown to the user and newly written names by the model: used for general language and terminology checks. */
function planTexts(plan: Plan): string[] {
  if (plan.kind === 'reject') return [plan.message, ...plan.examples];
  if (plan.kind !== 'ops') return [];
  return [...(plan.notes ?? []), ...(plan.next ? [plan.next] : []), ...(plan.suggest ?? [])];
}

const CJK = /[㐀-鿿]/;
const WORDS: Record<Locale, RegExp> = {
  zh: /安装|卸载|工作流|插件/,
  en: /\b(install|uninstall|installed|workflow)\b/i,
  fr: /\b(installer|désinstaller|workflow|flux de travail)\b/i,
};

function flagsOf(plan: Plan, locale: Locale, calls: CallLog[]): string[] {
  const flags: string[] = [];
  const texts = planTexts(plan);
  for (const text of texts) {
    if (locale !== 'zh' && CJK.test(text)) flags.push(`lang:cjk-in-${locale}: ${text}`);
    if (locale === 'zh' && !CJK.test(text) && /[a-z]{4}/i.test(text))
      flags.push(`lang:no-cjk: ${text}`);
    if (WORDS[locale].test(text)) flags.push(`term: ${text}`);
  }
  if (plan.kind === 'ops') {
    if (plan.ops.length === 0) flags.push('ops:empty');
    for (const s of plan.suggest ?? []) if (s.length > 40) flags.push(`suggest:long: ${s}`);
  }
  if (plan.kind === 'reject' && plan.examples.length === 0) flags.push('reject:no-examples');
  if (calls.some((c) => c.stopReason === 'max_tokens')) flags.push('truncated');
  return flags;
}

interface TurnLog {
  input: string;
  plan: Plan | null;
  ok: boolean;
  issues?: string[];
  lines?: string[];
  scope?: string[];
}

function initialConfig(c: LabCase): WorkspaceConfig {
  if (c.configFile) return JSON.parse(readFileSync(c.configFile, 'utf8')) as WorkspaceConfig;
  const config = buildSetup(c.setup, c.locale, registry);
  if (!c.setupOps) return config;
  const prepared = prepareOps(config, c.setupOps, ctxFor(c.locale));
  if (!prepared.ok) throw new Error(`setupOps: ${prepared.issues.join('; ')}`);
  return prepared.after;
}

async function runConversation(c: LabCase, calls: CallLog[]) {
  const provider = createClaudePlanner({
    complete: logged(calls),
    registry,
    now: () => new Date(),
    route: values.route === true,
    maxRepairs: Number(values['max-repairs'] ?? 1),
  });
  let config = initialConfig(c);
  const history: WorkspaceConfig[] = [];
  const earlier: PlanEarlier[] = [...(c.earlier ?? [])];
  const turns: TurnLog[] = [];
  const queue = [...(c.turns ?? [c.input!])];
  while (queue.length > 0 && turns.length < 40) {
    const input = queue.shift()!;
    const plan = await provider.plan(input, {
      config,
      registry,
      locale: c.locale,
      ...(c.about ? { about: c.about } : {}),
      ...(earlier.length ? { earlier: [...earlier] } : {}),
    });
    if (plan.kind === 'ops') {
      const prepared = prepareOps(config, plan.ops, { ...ctxFor(c.locale), fromAI: true });
      if (prepared.ok) {
        turns.push({
          input,
          plan,
          ok: true,
          lines: prepared.lines,
          scope: scopeOf(config, prepared.after),
        });
        history.push(config);
        config = prepared.after;
        earlier.push({ input, done: true, reply: prepared.lines.join('; ') });
        // User taps "Continue modifying" (D-191).
        if (plan.next) queue.unshift(plan.next);
      } else {
        turns.push({ input, plan, ok: false, issues: prepared.issues });
        earlier.push({ input, done: false, reply: prepared.issues.join('; ') });
      }
    } else if (plan.kind === 'restorePrevious') {
      const previous = history.pop();
      turns.push({ input, plan, ok: previous !== undefined });
      if (previous) {
        config = previous;
        earlier.push({ input, done: true, reply: 'restored the previous version' });
      }
    } else if (plan.kind === 'build') {
      // This path does not use steps (unlike `--app-flow`): only records that a plan was returned.
      turns.push({ input, plan, ok: true });
    } else {
      turns.push({ input, plan, ok: false, issues: [plan.message] });
      earlier.push({ input, done: false, reply: plan.message });
    }
  }
  return { turns, finalConfig: config };
}

/**
 * Current app flow (`ai-change.ts`, `draft.ts`, `build.ts`): every sentence includes a tool list
 * (D-414); large tasks automatically click "Start", execute step by step, and record each step's
 * result (D-415); for feature modifications relying on drafts, simulates user clicking "Apply
 * draft and continue" (D-413).
 */
async function runAppFlow(
  c: LabCase,
  calls: CallLog[],
  options: {
    /** After the opening and before clicking "Fix these", continue speaking (acceptance simulated user). */
    afterOpening?: (flow: {
      config: () => WorkspaceConfig;
      send: (input: string) => Promise<void>;
    }) => Promise<void>;
    /** Maximum number of times to click "Fix these". */
    fixRounds?: number;
  } = {},
) {
  const provider = createClaudePlanner({
    complete: logged(calls),
    registry,
    now: () => new Date(),
  });
  type Step = { ops: Op[]; input: string; reply: string };
  type FlowLog = TurnLog & {
    failed?: string;
    inChat?: boolean;
    buildStep?: { index: number; total: number; id: string };
    appliedDraftFirst?: boolean;
    /** Looks in this plan cannot be fitted (D-419) and did not enter the draft. */
    lookNotDone?: string[];
  };
  type Draft = { config: WorkspaceConfig; steps: Step[] };
  let head = initialConfig(c);
  // Read and write via functions: a `let` modified inside a closure will be narrowed to `never` by TypeScript within loops.
  const box: { draft: Draft | null; session: WorkSession; next: string | null } = {
    draft: null,
    session: emptySession(),
    next: null,
  };
  const parents: WorkspaceConfig[] = [];
  const turns: FlowLog[] = [];
  const ctx = { ...ctxFor(c.locale), fromAI: true };
  const shown = () => box.draft?.config ?? head;
  const note = (turn: SessionTurn, config: WorkspaceConfig) => {
    box.session = recheckItems(recordTurn(box.session, turn), config, registry, c.locale);
  };
  // Rebase draft onto a new version (`draft.ts`'s `rebaseDraft`): drop the step that failed to fit and all subsequent steps; cleanup operations follow along with this step.
  const rebase = (cleanup: readonly Op[] = []) => {
    if (!box.draft) return;
    let config = head;
    let left = [...cleanup];
    const kept: Step[] = [];
    for (const step of box.draft.steps) {
      let ops = step.ops;
      let r = prepareOps(config, ops, ctx);
      if (!r.ok) {
        const applied = applyOps(config, ops, ctx);
        const usable = applied.ok ? applicableOps(applied.config, left, ctx) : [];
        ops = [...ops, ...usable];
        r = prepareOps(config, ops, ctx);
        left = left.filter((op) => !usable.includes(op));
      }
      if (!r.ok) break;
      config = r.after;
      kept.push({ ...step, ops });
    }
    box.draft = kept.length ? { config, steps: kept } : null;
  };
  const applyDraft = () => {
    if (!box.draft) return;
    parents.push(head);
    head = box.draft.config;
    box.draft = null;
  };

  /** A single sentence. Returns the reason for getting stuck (used by the builder to stop), or `null` if not stuck. */
  const say = async (
    input: string,
    stepInfo?: { index: number; total: number; id: string },
  ): Promise<string | null> => {
    const base = shown();
    const inChat = box.draft !== null;
    const log = stepInfo ? { inChat, buildStep: stepInfo } : { inChat };
    const session = planSession(box.session, {
      current: input,
      ...(stepInfo
        ? {
            step: {
              index: stepInfo.index,
              total: stepInfo.total,
              remaining: stepInfo.total - stepInfo.index,
            },
          }
        : {}),
    });
    let plan: Plan;
    try {
      plan = await provider.plan(input, {
        config: base,
        registry,
        locale: c.locale,
        ...(c.about ? { about: c.about } : {}),
        ...(session ? { session } : {}),
      });
    } catch (e) {
      // In the real app, if this sentence fails, the user can continue speaking.
      if (INFRA.test(String(e))) throw e;
      turns.push({ input, plan: null, ok: false, failed: String(e), ...log });
      return String(e);
    }
    const itemId = stepInfo ? buildItemId(stepInfo.id) : undefined;
    const item = itemId ? { itemId } : {};
    if (plan.kind === 'build') {
      if (stepInfo) {
        turns.push({ input, plan, ok: false, issues: ['a plan inside a step'], ...log });
        return 'a plan inside a step';
      }
      turns.push({ input, plan, ok: true, ...log });
      // Automatically click "Start"; stop if any step fails (the user can choose retry or skip; here treated as skip, continuing to record subsequent ones).
      box.session = startBuildItems(box.session, plan.summary, plan.steps);
      for (const [i, step] of plan.steps.entries()) {
        const info = { index: i + 1, total: plan.steps.length, id: step.id };
        const stuck = await say(step.request, info);
        if (stuck) {
          box.session = setItemStatus(box.session, buildItemId(step.id), 'skipped', stuck);
          continue;
        }
        // Remaining looks in this sentence (`next`): still counted towards this step.
        if (box.next) {
          const next = box.next;
          box.next = null;
          await say(next, info);
        }
      }
      const planned = shown();
      box.session = recheckItems(box.session, planned, registry, c.locale, { all: true });
      return null;
    }
    if (plan.kind === 'restorePrevious') {
      const previous = box.draft ? null : parents.pop();
      if (box.draft) box.draft = null;
      else if (previous) head = previous;
      turns.push({ input, plan, ok: true, ...log });
      return null;
    }
    if (plan.kind !== 'ops') {
      note({ input, done: false, reply: plan.message, reason: plan.message, ...item }, base);
      turns.push({ input, plan, ok: false, issues: [plan.message], ...log });
      return plan.reason === 'noChange' ? null : plan.message;
    }
    const prepared = prepareOps(base, plan.ops, ctx);
    if (!prepared.ok) {
      const reply = prepared.issues.join('; ');
      note({ input, done: false, reply, reason: reply, ...item }, base);
      turns.push({ input, plan, ok: false, issues: prepared.issues, ...log });
      return reply;
    }
    const later = (stepInfo?.index ?? 0) < (stepInfo?.total ?? 0);
    const first = functionFirst(base, plan.ops, ctx);
    if (first.kind === 'function') {
      let wanted = first.ops;
      let cleanup: Op[] = [];
      let fn = prepareOps(head, wanted, ctx);
      if (!fn.ok && box.draft) {
        const split = splitDraftOnlyOps(head, wanted, ctx);
        const kept = split ? prepareOps(head, split.kept, ctx) : null;
        if (split && kept?.ok) {
          wanted = split.kept;
          cleanup = split.skipped;
          fn = kept;
        }
      }
      // Needs to use items from the draft (D-413): simulates user clicking "Apply draft and continue".
      let appliedDraftFirst = false;
      if (!fn.ok && box.draft) {
        applyDraft();
        appliedDraftFirst = true;
        fn = prepareOps(head, wanted, ctx);
      }
      if (!fn.ok) {
        const reply = fn.issues.join('; ');
        note({ input, done: false, reply, reason: reply, ...item }, base);
        turns.push({ input, plan, ok: false, issues: fn.issues, ...log });
        return reply;
      }
      parents.push(head);
      const scope = scopeOf(head, fn.after);
      head = fn.after;
      rebase(cleanup);
      // Looks enter draft (`ai-change.ts`'s `deferredIntoDraft`, D-419): no longer asks the model; only becomes the "Continue modifying" sentence if they fail to fit.
      const look = first.deferred.length > 0 ? prepareOps(shown(), first.deferred, ctx) : null;
      if (look?.ok)
        box.draft = {
          config: look.after,
          steps: [
            ...(box.draft?.steps ?? []),
            { ops: first.deferred, input, reply: look.lines.join('; ') },
          ],
        };
      const lookLines = look?.ok ? look.lines : [];
      turns.push({
        input,
        plan,
        ok: true,
        lines: [...fn.lines, ...lookLines],
        scope,
        ...log,
        ...(appliedDraftFirst ? { appliedDraftFirst } : {}),
        ...(look && !look.ok ? { lookNotDone: look.issues } : {}),
      });
      const next =
        plan.next ??
        (look && !look.ok ? deferredLookText(fn.after, first.deferred, ctx, input) : null);
      const after = shown();
      const verdict = toolVerdict(base, after, registry, { later: later || Boolean(next) });
      const issue = verdict.blockers[0];
      note(
        {
          input,
          reply: [...fn.lines, ...lookLines].join('; '),
          done: true,
          kind: workKindOfOps(plan.ops),
          verdict,
          ...(issue ? { reason: issueReason(issue, after, c.locale) } : {}),
          ...(next ? { next } : {}),
          ...item,
        },
        after,
      );
      box.next = next;
      return issue ? issue.message : null;
    }
    const reply = prepared.lines.join('; ');
    turns.push({
      input,
      plan,
      ok: true,
      lines: prepared.lines,
      scope: scopeOf(base, prepared.after),
      ...log,
    });
    box.draft = {
      config: prepared.after,
      steps: [...(box.draft?.steps ?? []), { ops: plan.ops, input, reply }],
    };
    const verdict = toolVerdict(base, prepared.after, registry, { later });
    const issue = verdict.blockers[0];
    note(
      {
        input,
        reply,
        done: true,
        kind: workKindOfOps(plan.ops),
        verdict,
        ...(issue ? { reason: issueReason(issue, prepared.after, c.locale) } : {}),
        ...item,
      },
      prepared.after,
    );
    box.next = plan.next ?? null;
    return issue ? issue.message : null;
  };

  const drain = async (inputs: readonly string[]) => {
    const queue = [...inputs];
    while (queue.length > 0 && turns.length < 40) {
      await say(queue.shift()!);
      // User taps "Continue modifying" (D-191).
      if (box.next) {
        queue.unshift(box.next);
        box.next = null;
      }
    }
  };
  await drain(c.turns ?? [c.input!]);
  await options.afterOpening?.({ config: shown, send: (input) => drain([input]) });
  // If there are still unusable items at the end, the user clicks "Fix these" once (maximum twice by default).
  const before = new Set(
    checkTools(initialConfig(c), registry).issues.map((i) => `${i.code}|${i.target}`),
  );
  for (let round = 0; round < (options.fixRounds ?? 2); round++) {
    const left = checkTools(shown(), registry).issues.filter(
      (i) => i.severity === 'blocker' && !before.has(`${i.code}|${i.target}`),
    );
    if (left.length === 0) break;
    await say(`Fix these so the app can be used:\n${left.map((i) => `- ${i.message}`).join('\n')}`);
    if (box.next) {
      const next = box.next;
      box.next = null;
      await say(next);
    }
  }
  applyDraft();
  return { turns, finalConfig: head, session: box.session };
}

/** Maximum number of turns the acceptance test can speak on behalf of the user (excluding the opening statement). */
const ACCEPTANCE_ROUNDS = 4;

/**
 * Personal record capability acceptance (`acceptance/`): runs `runAppFlow`, scores each round;
 * simulates user speaking one sentence in order for each failed core item, and finally clicks
 * "Fix these" once. Passing is judged solely by code scoring.
 */
async function runAcceptance(s: Scenario, calls: CallLog[]) {
  const roundLog = (said: string, score: ScenarioScore) => ({
    said,
    passed: score.passed,
    total: score.total,
    corePassed: score.corePassed,
    coreTotal: score.coreTotal,
    qualified: score.qualified,
    missingCore: score.missingCore,
    calls: calls.length,
  });
  const rounds: ReturnType<typeof roundLog>[] = [];
  const asked = new Set<string>();
  const { turns, finalConfig } = await runAppFlow(
    { id: s.id, input: openings[s.id] ?? s.opening, locale: s.locale, setup: s.setup },
    calls,
    {
      fixRounds: 1,
      afterOpening: async (flow) => {
        let score = scoreScenario(s, flow.config(), registry);
        rounds.push(roundLog(openings[s.id] ?? s.opening, score));
        for (let round = 0; round < ACCEPTANCE_ROUNDS; round++) {
          const ask = nextAsk(s, score, asked);
          if (!ask) break;
          asked.add(ask.id);
          await flow.send(ask.text);
          score = scoreScenario(s, flow.config(), registry);
          rounds.push(roundLog(ask.text, score));
        }
      },
    },
  );
  const final = scoreScenario(s, finalConfig, registry);
  const beforeFix = rounds.at(-1)!;
  // Counted as a separate round when "Fix these" has been clicked.
  if (calls.length > beforeFix.calls) rounds.push(roundLog('(fix these)', final));
  const firstQualified = rounds.findIndex((r) => r.qualified);
  return {
    input: openings[s.id] ?? s.opening,
    locale: s.locale,
    setup: s.setup,
    category: s.category,
    rounds,
    qualified: final.qualified,
    /** Round at which qualification was achieved: 0 = qualified on the opening statement alone. */
    qualifiedAtRound: final.qualified ? firstQualified : null,
    missingCore: final.missingCore,
    missing: final.requirements.filter((r) => !r.pass).map((r) => r.id),
    requirements: final.requirements,
    blockers: final.blockers,
    callCount: calls.length,
    usd: calls.reduce((sum, c) => sum + usdOf(c.usage), 0),
    pass: final.qualified,
    turns,
    calls,
    finalConfig,
  };
}

async function runEval(c: EvalCase, calls: CallLog[]) {
  const provider = createClaudePlanner({
    complete: logged(calls),
    registry,
    now: () => new Date(),
    route: values.route === true,
    maxRepairs: Number(values['max-repairs'] ?? 1),
  });
  const { outcome, plans } = await runEvalCase(c, provider, registry, new Date());
  // Replay once to get the change scope (`runEvalCase` does not return intermediate configs).
  const ctx = ctxFor(c.locale);
  let config = buildSetup(c.setup, c.locale, registry);
  for (const e of c.earlier ?? []) {
    if ('notDone' in e) continue;
    const done = prepareOps(config, e.ops, ctx);
    if (done.ok) config = done.after;
  }
  const turns: TurnLog[] = plans.map((plan) => {
    if (plan.kind !== 'ops') return { input: c.input, plan, ok: plan.kind === 'restorePrevious' };
    const prepared = prepareOps(config, plan.ops, { ...ctx, fromAI: true });
    if (!prepared.ok) return { input: c.input, plan, ok: false, issues: prepared.issues };
    const scope = scopeOf(config, prepared.after);
    config = prepared.after;
    return { input: c.input, plan, ok: true, lines: prepared.lines, scope };
  });
  return { outcome, turns };
}

const suite = values.suite ?? 'eval';
const selected = values.cases ? new Set(values.cases.split(',')) : null;
const fromFile: LabCase[] =
  values.acceptance || suite === 'eval'
    ? []
    : (JSON.parse(readFileSync(suite, 'utf8')) as LabCase[]);
const evalCases =
  !values.acceptance && suite === 'eval'
    ? EVAL_CASES.filter((c) => !selected || selected.has(c.id))
    : [];
const acceptanceIds = values['acceptance-ids']?.split(',');
const openings = values['acceptance-openings']
  ? (JSON.parse(readFileSync(values['acceptance-openings'], 'utf8')) as Record<string, string>)
  : {};
for (const id of acceptanceIds ?? [])
  if (!SCENARIOS.some((s) => s.id === id)) throw new Error(`没有场景 ${id}`);
const scenarios = values.acceptance
  ? SCENARIOS.filter((s) => !acceptanceIds || acceptanceIds.includes(s.id))
  : [];
const fileCases = fromFile.filter((c) => !selected || selected.has(c.id));
const repeat = Number(values.repeat ?? 1);
const concurrency = Number(values.concurrency ?? 16);

const done = new Set<string>();
if (values.resume && existsSync(out)) {
  for (const line of readFileSync(out, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as { id: string; rep: number };
    done.add(`${r.id}#${r.rep}`);
  }
}

type Job = { id: string; rep: number; run: () => Promise<Record<string, unknown>> };
const jobs: Job[] = [];
for (let rep = 0; rep < repeat; rep++) {
  for (const c of evalCases) {
    jobs.push({
      id: c.id,
      rep,
      run: async () => {
        const calls: CallLog[] = [];
        const base = { input: c.input, locale: c.locale, setup: c.setup, about: c.about };
        const ran = await runEval(c, calls).catch((e: unknown) => ({ crash: String(e) }));
        if ('crash' in ran) {
          totals.crashed++;
          return { ...base, pass: false, reason: ran.crash, ...ran, calls };
        }
        const { outcome, turns } = ran;
        const last = turns.at(-1)?.plan;
        return {
          input: c.input,
          locale: c.locale,
          setup: c.setup,
          about: c.about,
          pass: outcome.pass,
          reason: outcome.pass ? undefined : outcome.reason,
          turns,
          calls,
          flags: last ? flagsOf(last, c.locale, calls) : [],
        };
      },
    });
  }
  for (const s of scenarios) {
    jobs.push({
      id: s.id,
      rep,
      run: async () => {
        const calls: CallLog[] = [];
        return runAcceptance(s, calls).catch((e: unknown) => {
          totals.crashed++;
          return {
            input: openings[s.id] ?? s.opening,
            locale: s.locale,
            category: s.category,
            crash: String(e),
            qualified: false,
            calls,
          };
        });
      },
    });
  }
  for (const c of fileCases) {
    jobs.push({
      id: c.id,
      rep,
      run: async () => {
        const calls: CallLog[] = [];
        const ran = await (
          values['app-flow'] ? runAppFlow(c, calls) : runConversation(c, calls)
        ).catch((e: unknown) => ({ crash: String(e) }));
        if ('crash' in ran) {
          totals.crashed++;
          return {
            input: c.input ?? c.turns,
            locale: c.locale,
            setup: c.setup,
            about: c.about,
            expect: c.expect,
            rubric: c.rubric,
            tags: c.tags,
            ...ran,
            calls,
          };
        }
        const { turns, finalConfig } = ran;
        const health = checkTools(finalConfig, registry);
        return {
          input: c.input ?? c.turns,
          locale: c.locale,
          setup: c.setup,
          about: c.about,
          expect: c.expect,
          rubric: c.rubric,
          tags: c.tags,
          turns,
          calls,
          flags: turns.flatMap((t) => (t.plan ? flagsOf(t.plan, c.locale, calls) : [])),
          health: {
            tools: health.tools.length,
            toolsOk: health.tools.filter((x) => x.ok).length,
            issues: health.issues,
          },
        };
      },
    });
  }
}
const todo = jobs.filter((j) => !done.has(`${j.id}#${j.rep}`));
const model = runtime.model;
const price = MODELS.find((m) => m.id === model)?.price;
console.log(
  `模型 ${model}，提示词 ${promptHash}，任务 ${todo.length}/${jobs.length}，并发 ${concurrency}`,
);

const totals = { input: 0, cacheRead: 0, output: 0, calls: 0, crashed: 0, finished: 0, passed: 0 };

async function execute(job: Job) {
  if (spent() >= BUDGET) {
    console.log('已到预算上限，停止');
    process.exit(2);
  }
  const started = Date.now();
  let record: Record<string, unknown>;
  try {
    record = await job.run();
  } catch (e) {
    totals.crashed++;
    record = { crash: String(e) };
  }
  const calls = (record.calls ?? []) as CallLog[];
  for (const c of calls) {
    totals.calls++;
    totals.input += c.usage.inputTokens + c.usage.cacheWriteTokens;
    totals.cacheRead += c.usage.cacheReadTokens;
    totals.output += c.usage.outputTokens;
  }
  totals.finished++;
  if (record.pass) totals.passed++;
  appendFileSync(
    out!,
    `${JSON.stringify({ id: job.id, rep: job.rep, model, promptHash, ms: Date.now() - started, ...record })}\n`,
  );
  if (totals.finished % 50 === 0) console.log(`  ${totals.finished}/${todo.length}`);
}

// Run one test case first to write system prompts into cache so subsequent concurrent ones can read them.
const first = todo.shift();
if (first) await execute(first);
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < todo.length) await execute(todo[next++]!);
  }),
);

const cost = price
  ? (totals.input * price.input +
      totals.output * price.output +
      totals.cacheRead * price.cacheRead) /
    1_000_000
  : null;
console.log(JSON.stringify({ ...totals, usd: cost === null ? null : Number(cost.toFixed(3)) }));
