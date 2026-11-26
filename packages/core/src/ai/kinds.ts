import { prepareOps, type ChangeContext } from '../change';
import { describeChange } from '../describe';
import { t } from '../messages';
import { applyOps, isFunctionOp, type Op } from '../ops';
import type { WorkspaceConfig } from '../schema';

// Separate feature and appearance changes (D-191). Feature changes: data (table schema, date
// settings), standalone tools (quick actions, reminders), packs, and home screen widgets take
// effect immediately (and are undoable), allowing immediate testing once ready. Appearance changes:
// themes, navigation bars, pages, and page blocks (including record blocks, forms, numbers, and
// inline quick action tools on blocks) go into a draft first to preview appearance (D-190). When a
// plan contains both, feature changes take effect immediately and remaining appearance changes go
// directly into the draft (D-419). Handled by the app based on operation types, not model
// discretion.

/** Quick actions newly created within the same batch of operations. */
function newQuickActionIds(ops: readonly Op[]): Set<string> {
  return new Set(
    ops.flatMap((op) =>
      op.op === 'addTool' && typeof op.tool !== 'string' && op.tool.kind === 'quickAction'
        ? [op.tool.id]
        : [],
    ),
  );
}

/** `setTheme` operations that only add, change, or remove drawn icons (D-625): classified under neither category, following other modifications in this batch. */
const onlyIcons = (op: Op): boolean =>
  op.op === 'setTheme' && Object.keys(op).every((k) => k === 'op' || k === 'app' || k === 'icons');

/**
 * Check whether an operation is a feature operation (`isFunctionOp` in `ops-schema.ts`: data,
 * standalone tools, packs, home screen). Buttons that run new quick actions
 * apply alongside them; otherwise, they would be created without being accessible. `setTheme`
 * operations modifying only the icon library follow feature operations when present (table and
 * quick action icons depend on them), or appearance operations otherwise.
 */
function goesWithFunction(op: Op, added: ReadonlySet<string>, withFunction: boolean): boolean {
  if (isFunctionOp(op)) return true;
  if (onlyIcons(op)) return withFunction;
  if (op.op !== 'addContainer' || op.block?.look !== 'button') return false;
  const use = op.block.tools?.[0];
  return use !== undefined && 'tool' in use && added.has(use.tool);
}

/** Split a batch of operations into feature and appearance parts, preserving their original relative orders. */
export function splitOps(ops: readonly Op[]): { function: Op[]; look: Op[] } {
  const added = newQuickActionIds(ops);
  const withFunction = ops.some(isFunctionOp);
  const result: { function: Op[]; look: Op[] } = { function: [], look: [] };
  for (const op of ops)
    result[goesWithFunction(op, added, withFunction) ? 'function' : 'look'].push(op);
  return result;
}

export const hasFunctionOps = (ops: readonly Op[]): boolean => splitOps(ops).function.length > 0;

export type FunctionFirst =
  | { kind: 'look' }
  /** `function`: operations applied immediately in this round; `deferred`: appearance operations deferred to the draft after feature changes apply (D-419). */
  | { kind: 'function'; ops: Op[]; deferred: Op[] };

/**
 * What to execute in this round (D-191): if there are no feature operations, it is an appearance
 * change; if there are feature operations, execute them first. When appearance operations cannot
 * apply independently and require feature operations alongside them (e.g., removing a field
 * requires removing it from forms and lists), these appearance operations act as cleanup for the
 * feature operations and run together.
 */
export function functionFirst(
  before: WorkspaceConfig,
  ops: readonly Op[],
  ctx: ChangeContext,
): FunctionFirst {
  const split = splitOps(ops);
  if (split.function.length === 0) return { kind: 'look' };
  if (split.look.length === 0) return { kind: 'function', ops: split.function, deferred: [] };
  if (prepareOps(before, split.function, ctx).ok || !prepareOps(before, ops, ctx).ok)
    return { kind: 'function', ops: split.function, deferred: split.look };
  return { kind: 'function', ops: [...ops], deferred: [] };
}

/**
 * A message shown to the user when appearance changes cannot be applied (D-419): state clearly
 * what is being done if possible, or fall back to the exact text. This message is sent back to
 * the model.
 */
export function deferredLookText(
  config: WorkspaceConfig,
  deferred: readonly Op[],
  ctx: ChangeContext,
  input: string,
): string {
  const lines = describeChange(deferred, config, [], ctx);
  return (lines.length > 0 ? lines.join(t(ctx.locale, 'separatorSemicolon')) : input).slice(0, 200);
}

/**
 * Feature modifications discussed in the context of draft previews that need to be applied to the
 * official version (D-413): when cleanup appearance operations target pages or blocks existing
 * only in the draft, skip them on the official version and defer them until the draft is applied
 * (`rebaseDraft` cleanup). Feature operations and execution blocks accompanying new quick actions
 * are not skipped; if they cannot apply, it indicates they truly require elements from the draft
 * (returning `null`).
 */
export function splitDraftOnlyOps(
  head: WorkspaceConfig,
  ops: readonly Op[],
  ctx: ChangeContext,
): { kept: Op[]; skipped: Op[] } | null {
  const added = newQuickActionIds(ops);
  const kept: Op[] = [];
  const skipped: Op[] = [];
  let config = head;
  for (const op of ops) {
    const applied = applyOps(config, [op], ctx);
    if (applied.ok) {
      config = applied.config;
      kept.push(op);
    } else if (goesWithFunction(op, added, true)) return null;
    else skipped.push(op);
  }
  return skipped.length > 0 ? { kept, skipped } : null;
}

/** The subset of deferred cleanup operations that can successfully apply to this configuration (in order, skipping any operation that fails). */
export function applicableOps(
  config: WorkspaceConfig,
  ops: readonly Op[],
  ctx: ChangeContext,
): Op[] {
  const kept: Op[] = [];
  let current = config;
  for (const op of ops) {
    const applied = applyOps(current, [op], ctx);
    if (!applied.ok) continue;
    current = applied.config;
    kept.push(op);
  }
  return kept;
}
