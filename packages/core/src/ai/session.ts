import { z } from 'zod';

import { t } from '../messages';
import type { Op } from '../ops';
import type { Registry } from '../registry';
import { quickActionsOf, remindersOf, type Locale, type WorkspaceConfig } from '../schema';
import { FIXED_BY_A_LATER_STEP, checkTools, type ToolIssue } from '../tool-check';
import {
  WORK_KINDS,
  type BuildStep,
  type PlanEarlier,
  type PlanSession,
  type WorkKind,
} from './types';

// Tool list (AGENT_PLAN §3.5, D-414): a local "session", preserved across app restarts, replacing
// history that was previously confined to the draft chat box. Contents include only user
// utterances, a single sentence from the plan, and config structure, with no records (invariants 1,
// 2, 14); stored in app_meta, not in config, so the AI cannot modify it (invariant 8). "Done" is
// determined by code: this round of operations applied successfully, and tool checks have no
// blockers for related tables or tools. The model's own word does not count. Everything here
// consists of pure functions: the app's store and the lab test bench use the same copy.

export type SessionItemStatus = 'todo' | 'done' | 'skipped' | 'failed';

export interface SessionItem {
  id: string;
  kind: WorkKind;
  text: string;
  status: SessionItemStatus;
  reason?: string;
  /** Tools encountered by this item (table:<id>, quickAction:<id>, etc.): structure only, used later to re-evaluate whether it is done. */
  targets?: string[];
  /** Which step it was when still in the draft (changeRequestId); replaced with version number rev after taking effect. Used to adjust status on undo or step back. */
  cr?: number;
  rev?: number;
}

export interface SessionSaid extends PlanEarlier {
  cr?: number;
  rev?: number;
}

export interface WorkSession {
  goal?: string;
  items: SessionItem[];
  /** Most recent utterances, oldest first, including those said outside the draft (relaxed D-207). */
  said: SessionSaid[];
  /** Pre-existing issues in the config when the session started (code|target): starters or old issues are not the user's fault, "patch these up" does not count them (D-418). */
  startIssues?: string[];
}

export const SESSION_MAX_ITEMS = 12;
/** Number of recent utterances to pass to the AI. */
export const SESSION_RECENT = 5;
/** Maximum total length of the <session> block; oldest ones are dropped if exceeded (describeSession in prompt.ts). */
export const SESSION_CHAR_LIMIT = 1500;
const TEXT_MAX = 300;
const REPLY_MAX = 160;

const cut = (text: string, max: number) => text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');

const SessionSchema = z.object({
  goal: z.string().optional(),
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(WORK_KINDS),
      text: z.string(),
      status: z.enum(['todo', 'done', 'skipped', 'failed']),
      reason: z.string().optional(),
      targets: z.array(z.string()).optional(),
      cr: z.number().optional(),
      rev: z.number().optional(),
    }),
  ),
  said: z.array(
    z.object({
      input: z.string(),
      done: z.boolean(),
      reply: z.string(),
      cr: z.number().optional(),
      rev: z.number().optional(),
    }),
  ),
  startIssues: z.array(z.string()).optional(),
});

export const emptySession = (): WorkSession => ({ items: [], said: [] });

/** Stored session; missing or corrupted storage in older apps is treated as empty (invariant 12). */
export function parseSession(stored: string | null): WorkSession {
  if (!stored) return emptySession();
  try {
    const parsed = SessionSchema.safeParse(JSON.parse(stored));
    return parsed.success ? (parsed.data as WorkSession) : emptySession();
  } catch {
    return emptySession();
  }
}

export const sessionIsEmpty = (s: WorkSession): boolean =>
  !s.goal && s.items.length === 0 && s.said.length === 0;

/** Remaining work: unfinished and not-yet-completed items. */
export const openItems = (s: WorkSession): SessionItem[] =>
  s.items.filter((i) => i.status === 'todo' || i.status === 'failed');

/** When exceeding the limit, drop completed items first; if still not enough, drop the oldest ones. */
function trimItems(items: SessionItem[]): SessionItem[] {
  const kept = [...items];
  while (kept.length > SESSION_MAX_ITEMS) {
    const finished = kept.findIndex((i) => i.status === 'done' || i.status === 'skipped');
    kept.splice(finished >= 0 ? finished : 0, 1);
  }
  return kept;
}

function newItemId(items: readonly SessionItem[]): string {
  const used = items.map((i) => parseInt(i.id.slice(1), 10)).filter((n) => !Number.isNaN(n));
  return `i${Math.max(0, ...used) + 1}`;
}

/** What is sent to the model. current: the utterance currently being processed, no need to list again. */
export function planSession(
  s: WorkSession,
  options: { current?: string; step?: PlanSession['step'] } = {},
): PlanSession | undefined {
  const open = openItems(s)
    .filter((i) => i.text !== options.current)
    .map((i) => ({
      kind: i.kind,
      text: i.text,
      status: i.status as 'todo' | 'failed',
      ...(i.reason ? { reason: i.reason } : {}),
    }));
  const recent = s.said
    .slice(-SESSION_RECENT)
    .map(({ input, done, reply }) => ({ input, done, reply }));
  if (!s.goal && open.length === 0 && recent.length === 0 && !options.step) return undefined;
  return {
    ...(s.goal ? { goal: s.goal } : {}),
    open,
    recent,
    ...(options.step ? { step: options.step } : {}),
  };
}

/** Determine what kind of work this utterance is from operations: files go to records, files, records, everything else is appearance. */
export function workKindOfOps(ops: readonly Op[]): WorkKind {
  const quickActions = ops.flatMap((op) =>
    (op.op === 'addTool' || op.op === 'updateTool') &&
    typeof op.tool !== 'string' &&
    op.tool.kind === 'quickAction'
      ? [op.tool]
      : [],
  );
  if (quickActions.some((w) => JSON.stringify(w).includes('addRecord'))) return 'fileToRecord';
  if (quickActions.length > 0 || ops.some((op) => op.op === 'setPackage')) return 'file';
  if (ops.some((op) => ['addData', 'updateData', 'removeData', 'moveData'].includes(op.op)))
    return 'record';
  if (ops.some((op) => op.op === 'addTool' || op.op === 'updateTool')) return 'record';
  return 'look';
}

// ---- Code determines "is done" ----

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Tools and pages encountered in this change. */
function changedTargets(before: WorkspaceConfig, after: WorkspaceConfig): string[] {
  const diff = <T extends { id: string }>(prefix: string, was: readonly T[], now: readonly T[]) => {
    const old = new Map(was.map((x) => [x.id, x]));
    return now.filter((x) => !same(old.get(x.id), x)).map((x) => `${prefix}:${x.id}`);
  };
  return [
    ...diff('table', before.data.tables, after.data.tables),
    ...diff('quickAction', quickActionsOf(before), quickActionsOf(after)),
    ...diff('reminder', remindersOf(before), remindersOf(after)),
    ...diff('page', before.containers.pages, after.containers.pages),
  ];
}

/** Whether an issue belongs to these tools: blocks belong to pages, fields belong to tables. */
function concerns(issue: ToolIssue, targets: ReadonlySet<string>): boolean {
  if (targets.has(issue.target)) return true;
  const [prefix, rest = ''] = issue.target.split(/:(.*)/s);
  if (prefix === 'block') return targets.has(`page:${rest.split('/')[0]}`);
  if (prefix === 'field') return targets.has(`table:${rest.split('.')[0]}`);
  return false;
}

export interface ToolVerdict {
  targets: string[];
  blockers: ToolIssue[];
}

/**
 * After this round of changes, whether related tools can be used: blockers that are new compared
 * to before changes, plus blockers on encountered tools. later: a subsequent step (next, next
 * step of plan) will create the page, so a new table temporarily without an entry point is
 * expected.
 */
export function toolVerdict(
  before: WorkspaceConfig,
  after: WorkspaceConfig,
  registry: Registry,
  options: { later?: boolean } = {},
): ToolVerdict {
  const targets = changedTargets(before, after);
  const blockers = (config: WorkspaceConfig) =>
    checkTools(config, registry).issues.filter((i) => i.severity === 'blocker');
  const keyOf = (i: ToolIssue) => `${i.code}|${i.target}`;
  const old = new Map<string, number>();
  for (const i of blockers(before)) old.set(keyOf(i), (old.get(keyOf(i)) ?? 0) + 1);
  const set = new Set(targets);
  const found = blockers(after).filter((i) => {
    const left = old.get(keyOf(i)) ?? 0;
    if (left > 0) old.set(keyOf(i), left - 1);
    if (left === 0 || concerns(i, set))
      return !(options.later && FIXED_BY_A_LATER_STEP.has(i.code));
    return false;
  });
  // Must be recorded even when an issue occurs on an untouched table (page added a button, table unchanged) so it can be determined later whether it was patched.
  return { targets: [...new Set([...targets, ...found.map((i) => i.target)])], blockers: found };
}

function nameOf(target: string, config: WorkspaceConfig): string {
  const [prefix, rest = ''] = target.split(/:(.*)/s);
  const id =
    prefix === 'field' ? rest.split('.')[0]! : prefix === 'block' ? rest.split('/')[0]! : rest;
  if (prefix === 'table' || prefix === 'field')
    return config.data.tables.find((x) => x.id === id)?.name ?? id;
  if (prefix === 'quickAction') return quickActionsOf(config).find((x) => x.id === id)?.name ?? id;
  if (prefix === 'reminder') return remindersOf(config).find((x) => x.id === id)?.title ?? id;
  return config.containers.pages.find((x) => x.id === id)?.title ?? id;
}

/** Reason shown to the user (tool check messages are English for the model). */
export function issueReason(issue: ToolIssue, config: WorkspaceConfig, locale: Locale): string {
  const name = nameOf(issue.target, config);
  if (issue.code.startsWith('add-')) return t(locale, 'sessionWhyAdd', { name });
  if (issue.code.startsWith('view-') || issue.code === 'page-unreachable')
    return t(locale, 'sessionWhyView', { name });
  if (issue.target.startsWith('quickAction:')) return t(locale, 'sessionWhyFile', { name });
  if (issue.code.startsWith('reminder-')) return t(locale, 'sessionWhyReminder', { name });
  return t(locale, 'sessionWhyOther', { name });
}

// ---- Patch these up (D-418) ----

const blockerKey = (i: ToolIssue) => `${i.code}|${i.target}`;
const blockersOf = (config: WorkspaceConfig, registry: Registry) =>
  checkTools(config, registry).issues.filter((i) => i.severity === 'blocker');

/**
 * Record the start point of this session. Unstarted sessions (empty) are re-recorded every time;
 * sessions stored by older apps without a start point calculate from now. Returns the original
 * object if unchanged, avoiding writes to storage.
 */
export function markSessionStart(
  s: WorkSession,
  config: WorkspaceConfig,
  registry: Registry,
): WorkSession {
  if (s.startIssues && !sessionIsEmpty(s)) return s;
  const startIssues = blockersOf(config, registry).map(blockerKey);
  return same(s.startIssues, startIssues) ? s : { ...s, startIssues };
}

/**
 * New issues introduced in this session: blockers not present at the start, compared by count of
 * code + target. None when nothing was done in the session (no entries, or all undone). later:
 * the next utterance (next) will create the page, so a new table temporarily without an entry
 * point is expected.
 */
export function sessionProblems(
  s: WorkSession,
  config: WorkspaceConfig,
  registry: Registry,
  options: { later?: boolean } = {},
): ToolIssue[] {
  if (!s.startIssues || !s.items.some((i) => i.status !== 'skipped')) return [];
  const old = new Map<string, number>();
  for (const key of s.startIssues) old.set(key, (old.get(key) ?? 0) + 1);
  return blockersOf(config, registry).filter((i) => {
    const left = old.get(blockerKey(i)) ?? 0;
    if (left > 0) {
      old.set(blockerKey(i), left - 1);
      return false;
    }
    return !(options.later && FIXED_BY_A_LATER_STEP.has(i.code));
  });
}

/** Maximum number of items per request, the rest are handled by the user clicking again. */
const FIX_REQUEST_MAX = 10;
export const FIX_REQUEST_PREFIX = 'Fix these so the app can be used:';

/** Sentence sent to the model (English, config structure only). Users see "patch these up" in their own language. */
export function fixRequest(issues: readonly ToolIssue[]): string {
  const lines = issues.slice(0, FIX_REQUEST_MAX).map((i) => `- ${i.message}`);
  return [FIX_REQUEST_PREFIX, ...lines].join('\n');
}

// ---- Modify session ----

export interface SessionTurn {
  input: string;
  /** A single model reply or what was changed; stores only config structure and descriptions. */
  reply: string;
  done: boolean;
  /** What kind of work this utterance performed; no new item added when nothing was done (reason for refusal already told to the user). */
  kind?: WorkKind;
  verdict?: ToolVerdict;
  /** Which item of the plan this utterance performed. */
  itemId?: string;
  /** Reason shown to the user when not successfully completed. */
  reason?: string;
  /** Next utterance left by the model (next): enter the list. */
  next?: string | null;
  cr?: number;
  rev?: number;
}

/** Record an utterance: update the corresponding item (add a new one if none exists, do not add if nothing was done), and record it in recent utterances. */
export function recordTurn(s: WorkSession, turn: SessionTurn): WorkSession {
  const failed = (turn.verdict?.blockers.length ?? 0) > 0 || !turn.done;
  const status: SessionItemStatus = failed ? 'failed' : 'done';
  const refs = {
    ...(turn.cr !== undefined ? { cr: turn.cr } : {}),
    ...(turn.rev !== undefined ? { rev: turn.rev } : {}),
  };
  const update = (item: SessionItem): SessionItem => {
    const { reason: _, cr: _c, rev: _r, ...rest } = item;
    return {
      ...rest,
      status,
      ...(failed && turn.reason ? { reason: cut(turn.reason, REPLY_MAX) } : {}),
      ...(turn.verdict ? { targets: turn.verdict.targets } : {}),
      ...refs,
    };
  };
  const index = s.items.findIndex((i) =>
    turn.itemId
      ? i.id === turn.itemId
      : i.text === turn.input && (i.status === 'todo' || i.status === 'failed'),
  );
  let items = s.items;
  if (index >= 0) items = items.map((i, n) => (n === index ? update(i) : i));
  else if (turn.done && turn.kind) {
    items = [
      ...items,
      update({
        id: newItemId(items),
        kind: turn.kind,
        text: cut(turn.input, TEXT_MAX),
        status,
      }),
    ];
  }
  if (turn.next && !items.some((i) => i.text === turn.next && i.status === 'todo')) {
    items = [
      ...items,
      { id: newItemId(items), kind: 'look', text: cut(turn.next, TEXT_MAX), status: 'todo' },
    ];
  }
  return {
    ...s,
    items: trimItems(items),
    said: [
      ...s.said,
      {
        input: cut(turn.input, TEXT_MAX),
        done: turn.done,
        reply: cut(turn.reply, REPLY_MAX),
        ...refs,
      },
    ].slice(-SESSION_RECENT),
  };
}

/** User clicked "Start": target and unfinished steps enter the list. */
export function startBuildItems(
  s: WorkSession,
  summary: string,
  steps: readonly Pick<BuildStep, 'id' | 'kind' | 'request'>[],
): WorkSession {
  const ids = new Set(steps.map((step) => buildItemId(step.id)));
  return {
    ...s,
    goal: summary,
    items: trimItems([
      ...s.items.filter((i) => !ids.has(i.id)),
      ...steps.map((step) => ({
        id: buildItemId(step.id),
        kind: step.kind,
        text: cut(step.request, TEXT_MAX),
        status: 'todo' as const,
      })),
    ]),
  };
}

export const buildItemId = (stepId: string): string => `b-${stepId}`;

export function setItemStatus(
  s: WorkSession,
  id: string,
  status: SessionItemStatus,
  reason?: string,
): WorkSession {
  return {
    ...s,
    items: s.items.map((i) => {
      if (i.id !== id) return i;
      const { reason: _, ...rest } = i;
      return { ...rest, status, ...(reason ? { reason: cut(reason, REPLY_MAX) } : {}) };
    }),
  };
}

/**
 * Re-evaluate the list: items that were not well done are now considered done if they have no
 * issues (user said another utterance and patched it). all: re-evaluate completed items as well
 * (overall check at the end of building, intermediate skipped "page in next step" must be counted
 * now).
 */
export function recheckItems(
  s: WorkSession,
  config: WorkspaceConfig,
  registry: Registry,
  locale: Locale,
  options: { all?: boolean } = {},
): WorkSession {
  const issues = checkTools(config, registry).issues.filter((i) => i.severity === 'blocker');
  return {
    ...s,
    items: s.items.map((item) => {
      if (!item.targets?.length) return item;
      if (item.status !== 'failed' && !(options.all && item.status === 'done')) return item;
      const set = new Set(item.targets);
      const left = issues.find((i) => concerns(i, set));
      const { reason: _, ...rest } = item;
      return left
        ? {
            ...rest,
            status: 'failed' as const,
            reason: cut(item.reason ?? issueReason(left, config, locale), REPLY_MAX),
          }
        : { ...rest, status: 'done' as const };
    }),
  };
}

/** Draft applied: utterances and items for these steps take effect, version number recorded. */
export function commitDrafted(s: WorkSession, crs: readonly number[], rev: number): WorkSession {
  const set = new Set(crs);
  const move = <T extends { cr?: number; rev?: number }>(x: T): T => {
    if (x.cr === undefined || !set.has(x.cr)) return x;
    const { cr: _, ...rest } = x;
    return { ...rest, rev } as T;
  };
  return { ...s, items: s.items.map(move), said: s.said.map(move) };
}

/** These steps in the draft are removed (step back, discard draft, failed to apply): those utterances no longer count as said, and items no longer count as done. */
export function dropDrafted(s: WorkSession, crs: readonly number[]): WorkSession {
  const set = new Set(crs);
  const gone = (x: { cr?: number }) => x.cr !== undefined && set.has(x.cr);
  return {
    ...s,
    items: s.items.map((i) => {
      if (!gone(i)) return i;
      const { cr: _, ...rest } = i;
      return { ...rest, status: 'skipped' as const };
    }),
    said: s.said.filter((x) => !gone(x)),
  };
}

/** After undo, restore old version, or change preset: work done in these versions is no longer in the config. */
export function markUndone(s: WorkSession, undone: (rev: number) => boolean): WorkSession {
  const hit = (x: { rev?: number }) => x.rev !== undefined && undone(x.rev);
  return {
    ...s,
    items: s.items.map((i) => {
      if (!hit(i)) return i;
      const { rev: _, ...rest } = i;
      return { ...rest, status: 'skipped' as const };
    }),
    said: s.said.map((x) => {
      if (!hit(x)) return x;
      const { rev: _, ...rest } = x;
      return { ...rest, done: false, reply: 'undone by the user' };
    }),
  };
}
