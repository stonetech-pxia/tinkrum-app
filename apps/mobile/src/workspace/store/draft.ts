import {
  applicableOps,
  applyOps,
  prepareOps,
  sampleInfo,
  sampleOps,
  type Op,
  type PlanEarlier,
} from '@morph/core';

import { t } from '../../i18n';
import type { Kernel } from './kernel';
import type { SessionStore } from './session';
import type { Draft, DraftChatReply, DraftStep, WorkspaceState } from './types';

// AI modification draft (D-190): Reapply on the latest version upon saving, startup, or returning
// to draft, step back, apply (synthesize into an undoable version), leave, delete, step back when
// display error occurs; sample apps also serve as a draft step (D-260, D-262).

const DRAFT_META_KEY = 'draft';

/** Recent sentences brought to the AI (D-207). */
const EARLIER_LIMIT = 5;

/**
 * Previously spoken words in the draft chat box, in the order spoken, up to EARLIER_LIMIT
 * sentences; stepping back does not count as a sentence. Spoken words are now all in the tool
 * list (D-414): here it is only kept for connecting drafts left by older app versions to the
 * list.
 */
function earlierOf(draft: Draft): PlanEarlier[] {
  const all: PlanEarlier[] = [];
  const said = (after: number) => {
    for (const r of draft.replies) {
      if (r.afterSteps === after && r.kind !== 'steppedBack')
        all.push({ input: r.input, done: r.kind === 'functionApplied', reply: r.message });
    }
  };
  said(0);
  draft.steps.forEach((step, i) => {
    all.push({ input: step.input, done: true, reply: step.lines.join('; ') });
    said(i + 1);
  });
  return all.slice(-EARLIER_LIMIT);
}

/** When the draft retains only the first few steps, replies located after the removed steps are also removed. */
function keepSteps(draft: Draft, steps: DraftStep[]): Draft {
  return {
    ...draft,
    steps,
    replies: draft.replies.filter((r) => r.afterSteps <= steps.length),
  };
}

export function createDraft(k: Kernel, session: SessionStore) {
  const { deps, repo, registry, locale, set, get, msg, reload, failedPlan, addedBy } = k;

  async function saveDraft(draft: Draft | null) {
    const stored = draft && {
      origin: draft.origin,
      steps: draft.steps.map(({ config: _, ...step }) => step),
      replies: draft.replies,
    };
    await repo.setMeta(DRAFT_META_KEY, stored ? JSON.stringify(stored) : '');
  }

  /**
   * Reapply each step of the draft onto the latest version (undone or tools added may have
   * occurred while leaving the draft). The un-applyable step and subsequent ones are removed, and
   * the user is notified. cleanup: Those skipped on the official version among the cleanup
   * operations of this feature modification (D-413): modified blocks are only in the draft,
   * reapplied here accordingly, written into that step's operations, and no longer computed upon
   * future reapplication (configuration self-consistency, Invariant 18).
   */
  function rebaseDraft(
    draft: Pick<Draft, 'origin' | 'open' | 'replies'> & { steps: Omit<DraftStep, 'config'>[] },
    cleanup: readonly Op[] = [],
  ): Draft | null {
    const { config } = get();
    if (!config) return null;
    const ctx = { registry, locale, now: deps.now() };
    const steps: DraftStep[] = [];
    let base = config;
    let left = [...cleanup];
    /** This step itself cannot be reapplied (added block read a just-deleted field): Computed together with still-applyable cleanup operations. */
    const withCleanup = (ops: readonly Op[]) => {
      const applied = applyOps(base, ops, ctx);
      if (!applied.ok) return null;
      const usable = applicableOps(applied.config, left, ctx);
      if (usable.length === 0) return null;
      const all = [...ops, ...usable];
      const prepared = prepareOps(base, all, ctx);
      return prepared.ok ? { all, after: prepared.after, usable } : null;
    };
    for (const step of draft.steps) {
      const prepared = prepareOps(base, step.ops, ctx);
      if (prepared.ok) {
        base = prepared.after;
        steps.push({ ...step, config: base });
        continue;
      }
      const fixed = withCleanup(step.ops);
      if (!fixed) break;
      left = left.filter((op) => !fixed.usable.includes(op));
      base = fixed.after;
      steps.push({ ...step, ops: fixed.all, config: base });
    }
    const dropped = draft.steps.length - steps.length;
    // When every step can be reapplied, remaining cleanup operations are performed in the final step (what the model wants to clean up might not necessarily be verifiable).
    const last = steps.at(-1);
    if (dropped === 0 && last && left.length > 0) {
      const usable = applicableOps(last.config, left, ctx);
      const prepared = usable.length > 0 ? prepareOps(last.config, usable, ctx) : null;
      if (prepared?.ok)
        steps[steps.length - 1] = {
          ...last,
          ops: [...last.ops, ...usable],
          config: prepared.after,
        };
    }
    if (dropped > 0) set({ draftNotice: msg('draftDropped', { n: dropped }) });
    const gone = draft.steps.slice(steps.length);
    for (const step of gone) {
      void repo.updateChangeRequest(step.changeRequestId, {
        status: 'failed',
        error: 'no longer applies',
      });
    }
    if (gone.length > 0) void session.dropDrafted(gone.map((step) => step.changeRequestId));
    if (steps.length === 0) return null;
    return {
      ...draft,
      steps,
      replies: draft.replies.filter((r) => r.afterSteps <= steps.length),
    };
  }

  /**
   * Official version changed (features take effect directly, undo, D-411): Open draft immediately
   * reapplies to the new version. If not reapplied, applying the draft would overwrite this
   * change with the old configuration. The draft is discarded if not a single step can be applied
   * (rebaseDraft has already notified). When accompanied by cleanup operations (D-413), left
   * drafts are also reapplied immediately; these operations are not persisted and will not wait
   * for the next open.
   */
  async function rebaseOpenDraft(cleanup: readonly Op[] = []) {
    const draft = get().draft;
    if (!draft || (!draft.open && cleanup.length === 0)) return;
    const rebased = rebaseDraft(draft, cleanup);
    set({ draft: rebased });
    await saveDraft(rebased);
  }

  async function loadDraft() {
    const raw = await repo.getMeta(DRAFT_META_KEY);
    if (!raw) return;
    try {
      const stored = JSON.parse(raw) as Pick<Draft, 'origin'> & {
        steps: Omit<DraftStep, 'config'>[];
        /** Drafts saved prior to D-207 do not have this. */
        replies?: DraftChatReply[];
      };
      const draft = rebaseDraft({ ...stored, replies: stored.replies ?? [], open: false });
      set({ draft });
      if (!draft || draft.steps.length !== stored.steps.length) await saveDraft(draft);
    } catch {
      await saveDraft(null);
    }
  }

  const actions: Pick<
    WorkspaceState,
    | 'stepBack'
    | 'openDraft'
    | 'closeDraft'
    | 'draftSample'
    | 'applyDraft'
    | 'deleteDraft'
    | 'draftRenderFailed'
    | 'dismissDraftNotice'
  > = {
    async stepBack() {
      const draft = get().draft;
      if (!draft || draft.steps.length < 2) return;
      const removed = draft.steps.at(-1)!;
      const next = keepSteps(draft, draft.steps.slice(0, -1));
      set({ draft: next });
      await saveDraft(next);
      await repo.updateChangeRequest(removed.changeRequestId, { status: 'cancelled' });
      await session.dropDrafted([removed.changeRequestId]);
    },

    openDraft() {
      const draft = get().draft;
      if (!draft || draft.open) return;
      const rebased = rebaseDraft({ ...draft, open: true });
      set({ draft: rebased, editing: null });
      if (!rebased || rebased.steps.length !== draft.steps.length) void saveDraft(rebased);
    },

    closeDraft() {
      const draft = get().draft;
      // The only prompt in the draft is "Available after applying", which is cleared together upon leaving.
      if (draft?.open) set({ draft: { ...draft, open: false }, toast: null });
    },

    async draftSample(sample) {
      const { config, head } = get();
      if (!config || !head) throw new Error('workspace not loaded');
      let current = get().draft;
      if (current && !current.open) current = rebaseDraft(current);
      const base = current?.steps.at(-1)?.config ?? config;
      const result = sampleOps(sample, base, locale);
      if (!result.ok) return { kind: 'rejected', message: result.message, examples: [] };
      const input = msg('sampleDraftInput', { name: sampleInfo(sample, locale).name });
      const prepared = prepareOps(base, result.ops, { registry, locale, now: deps.now() });
      if (!prepared.ok) {
        await failedPlan(input, result.ops, `${prepared.stage}: ${prepared.issues.join('; ')}`);
        return { kind: 'invalid', issues: prepared.issues };
      }
      const changeRequestId = await repo.createChangeRequest({
        input,
        plan: result.ops,
        status: 'previewing',
        baseRevisionId: head.id,
      });
      const step: DraftStep = {
        input,
        ops: result.ops,
        lines: prepared.lines,
        changeRequestId,
        config: prepared.after,
      };
      const draft: Draft = {
        steps: [...(current?.steps ?? []), step],
        replies: current?.replies ?? [],
        origin: { ...current?.origin, sample: { id: sample, pageId: result.mainPageId } },
        open: true,
      };
      set({ draft, editing: null });
      await saveDraft(draft);
      return { kind: 'drafted', step, focusPageId: result.mainPageId };
    },

    async applyDraft() {
      const { head, config } = get();
      let { draft } = get();
      // The left draft is first reapplied to the latest version, otherwise changes during this period would be overwritten ("Apply draft and continue" comes from the AI modification page, D-413).
      if (draft && !draft.open) {
        draft = rebaseDraft(draft);
        set({ draft });
        if (!draft) await saveDraft(null);
      }
      if (!draft || !head || !config) return null;
      const after = draft.steps.at(-1)!.config;
      set({ busy: true });
      try {
        const summary = draft.steps
          .map((s) => s.input)
          .join(t(locale, 'separatorSemicolon'))
          .slice(0, 200);
        const revision = await repo.commitRevision({
          baseId: head.id,
          config: after,
          source: 'ai',
          summary,
        });
        const last = draft.steps.at(-1)!;
        for (const step of draft.steps.slice(0, -1)) {
          await repo.updateChangeRequest(step.changeRequestId, {
            status: 'committed',
            resultRevisionId: revision.id,
          });
        }
        k.render.pending = {
          changeRequestId: last.changeRequestId,
          revisionId: revision.id,
          undoTo: head.id,
          summary,
        };
        set({ draft: null, toast: null });
        await saveDraft(null);
        await session.commitDrafted(
          draft.steps.map((step) => step.changeRequestId),
          revision.id,
        );
        // Removed tools lose file authorization; files themselves are retained (§7G).
        const remaining = new Set(after.packages.map((t) => t.id));
        for (const tool of config.packages) {
          if (!remaining.has(tool.id)) await repo.revokeToolGrants(tool.id);
        }
        await reload();
        return addedBy(config, after, draft.origin);
      } finally {
        set({ busy: false });
      }
    },

    async deleteDraft() {
      const draft = get().draft;
      if (!draft) return;
      set({ draft: null });
      await saveDraft(null);
      for (const step of draft.steps) {
        await repo.updateChangeRequest(step.changeRequestId, { status: 'cancelled' });
      }
      await session.dropDrafted(draft.steps.map((step) => step.changeRequestId));
    },

    async draftRenderFailed(error) {
      const draft = get().draft;
      if (!draft) return;
      const last = draft.steps.at(-1)!;
      await repo.updateChangeRequest(last.changeRequestId, {
        status: 'rolled_back',
        error: String(error).slice(0, 300),
      });
      const next = draft.steps.length > 1 ? keepSteps(draft, draft.steps.slice(0, -1)) : null;
      set({ draft: next, draftNotice: msg('draftRenderFailed') });
      await saveDraft(next);
      await session.dropDrafted([last.changeRequestId]);
    },

    dismissDraftNotice: () => set({ draftNotice: null }),
  };
  return { actions, saveDraft, rebaseDraft, rebaseOpenDraft, loadDraft, earlierOf };
}
