import {
  PlanSchema,
  deferredLookText,
  fixRequest,
  functionFirst,
  homeEntryOps,
  opsForApp,
  planSession,
  prepareOps,
  splitDraftOnlyOps,
  sessionProblems,
  toolVerdict,
  workKindOfOps,
  workflowsWithoutEntry,
  type AIProvider,
  type FunctionFirst,
  type Op,
  type Plan,
  type PlanAbout,
  type PlanSession,
  type PreparedChange,
  type WorkKind,
  type WorkspaceConfig,
} from '@morph/core';

import { RevisionConflictError } from '../../storage/types';
import type { createDraft } from './draft';
import { focusPage, type Kernel } from './kernel';
import type { createRevisions } from './revisions';
import type { SessionStore } from './session';
import type {
  BuildRun,
  ChangeResult,
  Draft,
  DraftChatReply,
  DraftOrigin,
  DraftStep,
  WaitingForDraft,
  WorkspaceState,
} from './types';

// A single sentence from AI modification page and draft chat box (D-191, D-411): feature category
// saved directly as an AI version, appearance category enters draft, when a plan has both they each
// follow their own path (D-419); each sentence includes tool checklist (D-414); "continue editing"
// preset (next); large projects produce a plan first (D-415, step execution in build.ts).

export const NEXT_META_KEY = 'next';
export const SUGGEST_META_KEY = 'suggest';

/** A step in the build plan (D-415). */
export interface StepTurn {
  step: NonNullable<PlanSession['step']>;
  /** Corresponding item in checklist; when omitted, find by sentence. */
  itemId?: string;
  /** User clicked stop when model returns: do not apply, treat as if it never happened. */
  stillWanted: () => boolean;
}

/** Error thrown when user clicks stop while model returns. */
export class StepStopped extends Error {}

/** Stored suggestions (JSON array); empty if corrupted or missing. */
export function parseSuggest(stored: string | null): string[] {
  try {
    const v: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function createAIChange(
  k: Kernel,
  {
    restoreProposal,
    rebaseDraft,
    rebaseOpenDraft,
    saveDraft,
  }: Pick<ReturnType<typeof createRevisions>, 'restoreProposal'> &
    Pick<ReturnType<typeof createDraft>, 'rebaseDraft' | 'rebaseOpenDraft' | 'saveDraft'>,
  session: SessionStore,
  showBuild: (run: Pick<BuildRun, 'summary' | 'steps' | 'origin'>) => Promise<void>,
) {
  const { deps, repo, registry, locale, set, get, msg, reload, failedPlan, addedBy } = k;

  /** New quick actions place their entry point on the home screen by default; if the user says not to place it, or if it's made for files shared into the app (D-124), it is not placed. */
  /** Editing in app (D-485): check scope. Do not re-check already checked operations when replaying in draft. */
  const scopeOf = (origin: { appId?: string }) =>
    origin.appId ? { scope: { appId: origin.appId } } : {};

  function withHomeEntries(
    before: WorkspaceConfig,
    ops: Op[],
    prepared: Extract<PreparedChange, { ok: true }>,
    plan: { homeEntry?: boolean },
    about: PlanAbout | undefined,
    scope: { appId?: string } = {},
  ): { ops: Op[]; prepared: Extract<PreparedChange, { ok: true }> } {
    const wantHome =
      (about?.kind === 'shared' || about?.kind === 'chain'
        ? (plan.homeEntry ?? false)
        : plan.homeEntry) !== false;
    const homeless = wantHome ? workflowsWithoutEntry(ops, prepared.after, registry) : [];
    if (homeless.length === 0) return { ops, prepared };
    const withEntry = [...ops, ...homeEntryOps(prepared.after, homeless)];
    const full = prepareOps(before, withEntry, {
      registry,
      locale,
      now: deps.now(),
      fromAI: true,
      ...scopeOf(scope),
    });
    return full.ok ? { ops: withEntry, prepared: full } : { ops, prepared };
  }

  /** Results in chat box that did not turn into a step are recorded as a reply (D-207). */
  function replyFor(
    input: string,
    result: ChangeResult,
  ): Omit<DraftChatReply, 'afterSteps'> | null {
    switch (result.kind) {
      case 'rejected':
        return {
          input,
          kind: 'rejected',
          message: result.message,
          examples: result.examples,
          ...(result.reason ? { reason: result.reason } : {}),
        };
      case 'invalid':
        return {
          input,
          kind: 'invalid',
          message: `${msg('invalidPlan')} ${result.issues.join('；')}`,
          examples: [],
        };
      case 'applied':
        // This sentence has taken effect (D-411): explains what was done, remaining appearance items (next) can be clicked to continue.
        return {
          input,
          kind: 'functionApplied',
          message: [
            ...result.lines,
            ...(result.applied.notes ?? []),
            ...(result.lookNotDone ? [] : [msg('draftFunctionApplied')]),
          ].join('\n'),
          examples: get().next ? [get().next!] : [],
        };
      case 'steppedBack':
        return { input, kind: 'steppedBack', message: msg('draftSteppedBack'), examples: [] };
      case 'needsDraft':
        return {
          input,
          kind: 'needsDraft',
          message: result.message,
          examples: [],
          waiting: result.waiting,
        };
      default:
        return null;
    }
  }

  async function aiChange(
    input: string,
    planner: AIProvider,
    originIn: DraftOrigin,
    inChat: boolean,
    stepTurn?: StepTurn,
    /** When the sentence sent to the model differs from the recorded one ("fill these in", D-418). */
    forModel?: string,
  ): Promise<ChangeResult> {
    const { config, head } = get();
    if (!config || !head) throw new Error('workspace not loaded');
    set({ busy: true });
    try {
      let current = get().draft;
      if (current && !current.open) current = rebaseDraft(current);
      const base = current?.steps.at(-1)?.config ?? config;
      // Which app the modification is in (D-485): drafts inherit existing ones; new starts check current app.
      const appId = current ? current.origin.appId : (originIn.appId ?? get().appId ?? undefined);
      const origin: DraftOrigin = { ...originIn, ...(appId ? { appId } : {}) };
      // Follow starting context for subsequent sentences in draft: "this" still refers to that quick action (D-124).
      const about = origin.about ?? current?.origin.about;
      await session.markStart(base);
      // Include tool checklist together (D-414): goal, remaining gaps, recent conversation, so the user doesn't have to repeat from scratch every time.
      const planned = planSession(get().session, {
        current: input,
        ...(stepTurn ? { step: stepTurn.step } : {}),
      });
      const raw = await planner.plan(forModel ?? input, {
        config: base,
        registry,
        locale,
        onProgress: (step) => set({ planProgress: step }),
        ...(about ? { about } : {}),
        ...(appId ? { scope: { appId } } : {}),
        ...(planned ? { session: planned } : {}),
      });
      if (stepTurn && !stepTurn.stillWanted()) throw new StepStopped();
      /** This sentence failed: recorded in checklist (next sentence from model sees previous round's talk, that item in checklist marked failed). */
      const notDone = (reply: string, reason: string) =>
        session.record(
          {
            input,
            reply,
            done: false,
            reason,
            ...(stepTurn?.itemId ? { itemId: stepTurn.itemId } : {}),
          },
          base,
        );
      const parsed = PlanSchema.safeParse(raw);
      if (!parsed.success) {
        await failedPlan(input, raw, 'plan did not match schema');
        await notDone('the reply was not valid', msg('sessionInvalid'));
        return { kind: 'invalid', issues: parsed.error.issues.map((i) => i.message) };
      }
      // In-app (D-485): unassigned app styles, new pages, tables, and quick actions all belong to this app, written into operations (draft re-application does not carry scope).
      const plan =
        appId && parsed.data.kind === 'ops'
          ? { ...parsed.data, ops: opsForApp(parsed.data.ops, appId) }
          : parsed.data;
      if (plan.kind === 'build') {
        // Already executing a plan step: cannot output another one (planner already sent back once, other AIs might do this too).
        if (stepTurn) {
          await failedPlan(input, plan, 'a plan inside a step');
          await notDone('a plan inside a step', msg('sessionInvalid'));
          return { kind: 'invalid', issues: [msg('buildFailedInvalid')] };
        }
        // Show to user first, execute only when "Start" is clicked (invariant 16).
        await showBuild({
          summary: plan.summary,
          steps: plan.steps.map((step) => ({ ...step, status: 'todo' })),
          origin: { ...origin, ...(about ? { about } : {}) },
        });
        return { kind: 'build' };
      }
      if (plan.kind === 'reject') {
        await notDone(plan.message, plan.message);
        await repo.createChangeRequest({
          input,
          plan,
          status: 'rejected',
          baseRevisionId: head.id,
          error: plan.reason,
        });
        return {
          kind: 'rejected',
          message: plan.message,
          examples: plan.examples,
          reason: plan.reason,
        };
      }
      if (plan.kind === 'restorePrevious') {
        // A plan step cannot be "undo": what gets undone is something the user did not say to undo.
        if (stepTurn) return { kind: 'invalid', issues: [msg('buildFailedInvalid')] };
        if (current && current.steps.length > 1) {
          set({ draft: current });
          await get().stepBack();
          return { kind: 'steppedBack' };
        }
        if (current || head.parentId === null) {
          const message = msg(current ? 'draftFirstStep' : 'noPrevious');
          await notDone(message, message);
          return { kind: 'rejected', message, examples: [] };
        }
        const result = await restoreProposal(head.parentId, input);
        if (result.kind !== 'preview') return result;
        await get().confirm();
        return { kind: 'restored' };
      }
      const ctx = { registry, locale, now: deps.now(), fromAI: true, ...scopeOf(origin) };
      const prepared = prepareOps(base, plan.ops, ctx);
      if (!prepared.ok) {
        await failedPlan(input, plan.ops, `${prepared.stage}: ${prepared.issues.join('; ')}`);
        await notDone(prepared.issues.join('; '), msg('sessionInvalid'));
        return { kind: 'invalid', issues: prepared.issues };
      }
      // Suggested next step (D-355): Replace if a new one is given; if none is given, remove only the newly mentioned sentence (the tapped one) and keep the rest.
      await saveSuggest(plan.suggest ?? get().suggest.filter((x) => x !== input));
      // Feature first (D-191): Apply directly to the official version without entering the draft;
      // only modify the appearance in the draft. The same applies to what is said in the draft chat
      // box: after the draft is completed, apply it to the new version and keep it open (D-411).
      const first = functionFirst(base, plan.ops, ctx);
      if (first.kind === 'function') {
        return await applyFunction(
          input,
          plan,
          first,
          { ...origin, ...(about ? { about } : {}) },
          inChat,
          stepTurn,
        );
      }
      // Appearance: Create new or continue modifying the draft (D-190).
      const { ops, prepared: after } = withHomeEntries(
        base,
        plan.ops,
        prepared,
        plan,
        about,
        origin,
      );
      const changeRequestId = await repo.createChangeRequest({
        input,
        plan: ops,
        status: 'previewing',
        baseRevisionId: head.id,
      });
      const step: DraftStep = {
        input,
        ops,
        lines: after.lines,
        ...(plan.notes?.length ? { notes: plan.notes } : {}),
        changeRequestId,
        config: after.after,
      };
      const draft: Draft = {
        steps: [...(current?.steps ?? []), step],
        replies: current?.replies ?? [],
        origin: current?.origin ?? origin,
        // Do not open the draft during building (D-415): After completion, the user taps "View appearance" to view it, avoiding flashing back and forth in the middle.
        open: !stepTurn,
      };
      set({ draft, editing: null });
      await saveDraft(draft);
      if (input === get().next) await get().clearNext();
      await recordDone({
        input,
        lines: after.lines,
        kind: workKindOfOps(ops),
        before: base,
        after: after.after,
        later: (stepTurn?.step.remaining ?? 0) > 0,
        refs: { cr: changeRequestId },
        stepTurn,
      });
      return { kind: 'drafted', step, focusPageId: focusPage(ops, after.after) };
    } finally {
      set({ busy: false, planProgress: null });
    }
  }

  /** This sentence is done: Code determines whether related tools can be used (D-414), the model does not have the final say. */
  async function recordDone({
    input,
    lines,
    kind,
    before,
    after,
    later,
    refs,
    next,
    stepTurn,
  }: {
    input: string;
    lines: string[];
    kind: WorkKind;
    before: WorkspaceConfig;
    after: WorkspaceConfig;
    later: boolean;
    /** Both in one plan (D-419): Record both the feature version number and the appearance step so that both undo and step-back can locate this sentence. */
    refs: { cr: number } | { rev: number } | { cr: number; rev: number };
    next?: string | null;
    stepTurn: StepTurn | undefined;
  }) {
    await session.record(
      {
        input,
        reply: lines.join('; '),
        done: true,
        kind,
        verdict: toolVerdict(before, after, registry, { later }),
        ...(next ? { next } : {}),
        ...(stepTurn?.itemId ? { itemId: stepTurn.itemId } : {}),
        ...refs,
      },
      after,
    );
  }

  /**
   * Appearance enters draft (D-419): First apply the existing draft to the newly active version,
   * and if this batch of appearances is valid on top of it, connect them into a single step
   * (without asking the model again); if invalid, return null and add nothing. Do not open the
   * draft during building (D-415); after completion, the user taps "View appearance" to view it.
   */
  async function deferredIntoDraft(
    input: string,
    deferred: Op[],
    notes: string[],
    cleanup: readonly Op[],
    origin: DraftOrigin,
    stayInDraft: boolean,
    stepTurn: StepTurn | undefined,
  ): Promise<DraftStep | null> {
    const { draft, head, config } = get();
    const current = draft && rebaseDraft(draft, cleanup);
    const ctx = { registry, locale, now: deps.now(), fromAI: true, ...scopeOf(origin) };
    const prepared = prepareOps(current?.steps.at(-1)?.config ?? config!, deferred, ctx);
    if (!prepared.ok) {
      await failedPlan(input, deferred, `${prepared.stage}: ${prepared.issues.join('; ')}`);
      const kept = current && !stayInDraft && current.open ? { ...current, open: false } : current;
      set({ draft: kept, ...(kept !== current ? { toast: null } : {}) });
      await saveDraft(kept);
      return null;
    }
    const changeRequestId = await repo.createChangeRequest({
      input,
      plan: deferred,
      status: 'previewing',
      baseRevisionId: head!.id,
    });
    const step: DraftStep = {
      input,
      ops: deferred,
      lines: prepared.lines,
      ...(notes.length ? { notes } : {}),
      changeRequestId,
      config: prepared.after,
    };
    const next: Draft = {
      steps: [...(current?.steps ?? []), step],
      replies: current?.replies ?? [],
      origin: current?.origin ?? origin,
      open: !stepTurn,
    };
    set({ draft: next, editing: null });
    await saveDraft(next);
    return step;
  }

  /**
   * Feature-class modifications are saved directly as an AI version (D-191), with "Modified ·
   * Undo" at the top as usual. The remaining appearances in this sentence directly enter the
   * draft (D-419, without asking the model again); only when they cannot be applied do they turn
   * into a preset for "Continue editing", and inform the user that this part was not done. The
   * model's given next remains as usual. Draft remains: When spoken from the AI modification
   * page, the draft is left first and reapplied upon opening; when spoken from the draft chat box
   * (stayInDraft), it is applied immediately and the draft remains open (D-411).
   */
  async function applyFunction(
    input: string,
    plan: Extract<Plan, { kind: 'ops' }>,
    first: Extract<FunctionFirst, { kind: 'function' }>,
    origin: DraftOrigin,
    stayInDraft: boolean,
    stepTurn?: StepTurn,
  ): Promise<ChangeResult> {
    const { config, head, draft } = get();
    const ctx = { registry, locale, now: deps.now(), fromAI: true, ...scopeOf(origin) };
    const before = draft?.steps.at(-1)?.config ?? config!;
    let wanted = first.ops;
    let cleanup: Op[] = [];
    let prepared = prepareOps(config!, wanted, ctx);
    // The pages and blocks modified by cleanup operations are only in the draft (D-413): skipped on the official version, and performed when the draft is applied.
    if (!prepared.ok && draft) {
      const split = splitDraftOnlyOps(config!, wanted, ctx);
      const kept = split ? prepareOps(config!, split.kept, ctx) : null;
      if (split && kept?.ok) {
        wanted = split.kept;
        cleanup = split.skipped;
        prepared = kept;
      }
    }
    if (!prepared.ok) {
      await failedPlan(input, first.ops, `${prepared.stage}: ${prepared.issues.join('; ')}`);
      // Spoken on the appearance of the draft: Needs to use items in the draft (D-413). The user must tap to apply the draft (Invariants 7, 16).
      if (draft)
        return {
          kind: 'needsDraft',
          message: msg('functionNeedsDraft'),
          waiting: { input, plan, origin },
        };
      await session.record(
        {
          input,
          reply: prepared.issues.join('; '),
          done: false,
          reason: msg('sessionInvalid'),
          ...(stepTurn?.itemId ? { itemId: stepTurn.itemId } : {}),
        },
        config!,
      );
      return { kind: 'invalid', issues: prepared.issues };
    }
    const { ops, prepared: after } = withHomeEntries(
      config!,
      wanted,
      prepared,
      plan,
      origin.about,
      origin,
    );
    const hasDeferred = first.deferred.length > 0;
    const changeRequestId = await repo.createChangeRequest({
      input,
      plan: ops,
      status: 'previewing',
      baseRevisionId: head!.id,
    });
    const summary = input.slice(0, 200);
    let revisionId: number;
    try {
      const revision = await repo.commitRevision({
        baseId: head!.id,
        config: after.after,
        source: 'ai',
        summary,
      });
      revisionId = revision.id;
      // Another one comes before the previous one waits for render confirmation (step-by-step building, apply draft and continue): The previous one is already in history and considered successfully saved.
      const waiting = k.render.pending;
      if (waiting)
        await repo.updateChangeRequest(waiting.changeRequestId, {
          status: 'committed',
          resultRevisionId: waiting.revisionId,
        });
      k.render.pending = {
        changeRequestId,
        revisionId: revision.id,
        undoTo: head!.id,
        summary,
        // Do not pop up "Modified · Undo" at every step during building (D-415): State it on the plan when finished.
        ...(stepTurn ? { quiet: true } : {}),
      };
    } catch (e) {
      if (!(e instanceof RevisionConflictError)) throw e;
      await repo.updateChangeRequest(changeRequestId, { status: 'failed', error: e.message });
      await reload();
      return { kind: 'rejected', message: msg('conflict'), examples: [] };
    }
    if (draft?.open && !stayInDraft && !hasDeferred)
      set({ draft: { ...draft, open: false }, toast: null });
    // Removed tools lose file authorization; files themselves are retained (§7G).
    const remaining = new Set(after.after.packages.map((t) => t.id));
    for (const tool of config!.packages) {
      if (!remaining.has(tool.id)) await repo.revokeToolGrants(tool.id);
    }
    await reload();
    // The user sees that the feature has taken effect in the response at this draft step; the AI's explanation is also placed here (referring to the whole sentence).
    const lookStep = hasDeferred
      ? await deferredIntoDraft(
          input,
          first.deferred,
          [...after.lines, msg('draftFunctionApplied'), ...(plan.notes ?? [])],
          cleanup,
          origin,
          stayInDraft,
          stepTurn,
        )
      : null;
    if (!hasDeferred && (stayInDraft || cleanup.length > 0)) await rebaseOpenDraft(cleanup);
    const lookNotDone = hasDeferred && !lookStep;
    const next =
      plan.next ?? (lookNotDone ? deferredLookText(after.after, first.deferred, ctx, input) : null);
    set({ next });
    await repo.setMeta(NEXT_META_KEY, next ?? '');
    const notDoneNote = msg('deferredLookNotDone');
    // During building, the checklist and next will continue to execute, so an extra prompt is not needed; the chat reply already states it.
    if (lookNotDone && !stepTurn && !stayInDraft) set({ draftNotice: notDoneNote });
    const shown = get().draft?.steps.at(-1)?.config ?? after.after;
    await recordDone({
      input,
      lines: [...after.lines, ...(lookStep?.lines ?? []), ...(lookNotDone ? [notDoneNote] : [])],
      kind: workKindOfOps(ops),
      before,
      after: shown,
      later: Boolean(next) || (stepTurn?.step.remaining ?? 0) > 0,
      refs: lookStep ? { rev: revisionId, cr: lookStep.changeRequestId } : { rev: revisionId },
      next,
      stepTurn,
    });
    if (lookStep)
      return {
        kind: 'drafted',
        step: lookStep,
        focusPageId: focusPage(first.deferred, lookStep.config),
      };
    const applied = addedBy(config!, after.after, origin);
    // When not successfully completed, the AI's explanation cannot be kept: it might state that the appearance is already ready.
    const notes = lookNotDone ? [notDoneNote] : plan.notes;
    return {
      kind: 'applied',
      lines: after.lines,
      applied: notes?.length ? { ...applied, notes } : applied,
      focusPageId: focusPage(ops, after.after),
      ...(lookNotDone ? { lookNotDone: true } : {}),
    };
  }

  async function saveSuggest(suggest: string[]) {
    const old = get().suggest;
    if (suggest.length === old.length && suggest.every((x, i) => x === old[i])) return;
    set({ suggest });
    await repo.setMeta(SUGGEST_META_KEY, suggest.length ? JSON.stringify(suggest) : '');
  }

  const actions: Pick<
    WorkspaceState,
    'change' | 'draftChange' | 'clearNext' | 'clearSuggest' | 'continueWithDraft' | 'fixProblems'
  > = {
    change: (input, planner = deps.provider, origin = {}) =>
      aiChange(input, planner, origin, false),

    // Sent once per user tap (Invariant 16); nothing is sent when there are no issues or while in progress, nor does it loop.
    async fixProblems() {
      const { session: s, draft, config, next, busy } = get();
      const shown = draft?.steps.at(-1)?.config ?? config;
      if (!shown || busy) return null;
      const left = sessionProblems(s, shown, registry, { later: Boolean(next) });
      if (left.length === 0) return null;
      return aiChange(msg('fixProblems'), deps.provider, {}, false, undefined, fixRequest(left));
    },

    async draftChange(input, about) {
      const result = await aiChange(input, deps.provider, about ? { about } : {}, true);
      const draft = get().draft;
      const reply = draft && replyFor(input, result);
      if (draft && reply) {
        const next = {
          ...draft,
          replies: [...draft.replies, { ...reply, afterSteps: draft.steps.length }],
        };
        set({ draft: next });
        await saveDraft(next);
      }
      return result;
    },

    async clearNext() {
      if (get().next === null) return;
      set({ next: null });
      await repo.setMeta(NEXT_META_KEY, '');
    },

    clearSuggest: () => saveSuggest([]),

    async continueWithDraft({ input, plan, origin }: WaitingForDraft) {
      set({ busy: true });
      try {
        const applied = await get().applyDraft();
        const { config } = get();
        if (!applied || !config) return { kind: 'invalid', issues: [msg('invalidPlan')] };
        const ctx = { registry, locale, now: deps.now(), fromAI: true, ...scopeOf(origin) };
        const first = functionFirst(config, plan.ops, ctx);
        if (first.kind !== 'function') return { kind: 'invalid', issues: [msg('invalidPlan')] };
        return await applyFunction(input, plan, first, origin, false);
      } finally {
        set({ busy: false, planProgress: null });
      }
    },
  };
  return { actions, aiChange };
}
