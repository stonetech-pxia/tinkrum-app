import {
  createDefaultWorkspace,
  describePresetApply,
  describeRestore,
  homeEntryOps,
  importedPreset,
  migrateWorkspace,
  type Op,
  PlanSchema,
  keepChosenFiles,
  preparePreset,
  prepareOps,
  prepareSnapshot,
  RECORD_LIMITS,
  workflowsWithoutEntry,
  type WorkspaceConfig,
} from '@morph/core';

import { formatWhen } from '../../i18n';
import {
  RevisionConflictError,
  type RevisionRecord,
  type RevisionSource,
} from '../../storage/types';
import type { createDraft } from './draft';
import { focusPage, type Kernel } from './kernel';
import type { SessionStore } from './session';
import type { Proposal, ProposeResult, SetupFileResult, WorkspaceState } from './types';

// Revisions: Preview -> Confirm -> Atomic save -> Re-read and render -> Success only when rendering
// succeeds, automatic fallback on failure (§4, §7D); undo, restore historical version, traverse
// history for the last usable version on startup.

export function createRevisions(
  k: Kernel,
  { rebaseOpenDraft }: Pick<ReturnType<typeof createDraft>, 'rebaseOpenDraft'>,
  session: SessionStore,
) {
  const { deps, repo, registry, locale, set, get, msg, reload, commitFallback } = k;

  async function recordPreview(
    input: string,
    plan: unknown,
    base: RevisionRecord,
    fields: Omit<Proposal, 'changeRequestId' | 'baseRevisionId'>,
  ): Promise<ProposeResult> {
    const changeRequestId = await repo.createChangeRequest({
      input,
      plan,
      status: 'previewing',
      baseRevisionId: base.id,
    });
    const proposal: Proposal = { ...fields, changeRequestId, baseRevisionId: base.id };
    set({ proposal });
    return { kind: 'preview', proposal };
  }

  /**
   * Operations in the plan plus home entry (when checked) compute the content to be displayed in
   * the preview. When the home entry cannot be added (e.g., operation count reached the limit),
   * treat as unchecked.
   */
  function withHomeEntry(
    before: WorkspaceConfig,
    ops: Op[],
    base: { after: WorkspaceConfig; lines: string[] },
    workflowIds: string[],
    on: boolean,
  ): Pick<Proposal, 'after' | 'lines' | 'focusPageId' | 'focusWorkflowId' | 'homeEntry'> {
    if (on) {
      const full = prepareOps(before, [...ops, ...homeEntryOps(base.after, workflowIds)], {
        registry,
        locale,
        now: deps.now(),
      });
      if (full.ok)
        return {
          after: full.after,
          lines: base.lines,
          focusPageId: 'home',
          homeEntry: { workflowIds, on: true },
        };
    }
    return {
      after: base.after,
      lines: base.lines,
      focusPageId: focusPage(ops, base.after),
      focusWorkflowId: workflowIds[0],
      homeEntry: { workflowIds, on: false },
    };
  }

  async function opsProposal(
    input: string,
    ops: unknown,
    source: RevisionSource,
    summary: string,
    plan?: { homeEntry?: boolean; notes?: string[] },
    fromAppFile?: boolean,
  ): Promise<ProposeResult> {
    const { config, head } = get();
    if (!config || !head) throw new Error('workspace not loaded');
    const prepared = prepareOps(config, ops, {
      registry,
      locale,
      now: deps.now(),
      ...(fromAppFile ? { fromAppFile } : {}),
    });
    if (!prepared.ok) {
      await repo.createChangeRequest({
        input,
        plan: ops,
        status: 'failed',
        baseRevisionId: head.id,
        error: `${prepared.stage}: ${prepared.issues.join('; ')}`,
      });
      return { kind: 'invalid', issues: prepared.issues };
    }
    const parsed = ops as Op[];
    // When an AI-created workflow is not on any page, the user decides whether to place it on the home screen (D-109).
    const homeless = source === 'ai' ? workflowsWithoutEntry(parsed, prepared.after, registry) : [];
    return recordPreview(input, ops, head, {
      kind: 'ops',
      before: config,
      source,
      summary,
      ops: parsed,
      ...(plan?.notes?.length ? { notes: plan.notes } : {}),
      ...(homeless.length > 0
        ? withHomeEntry(config, parsed, prepared, homeless, plan?.homeEntry !== false)
        : {
            after: prepared.after,
            lines: prepared.lines,
            focusPageId: focusPage(parsed, prepared.after),
          }),
    });
  }

  /**
   * This configuration uses downloadable tools not present locally (device switched, downloaded
   * content deleted): must download first before restoring (D-177), returns prompt. Older
   * versions (schemaVersion < 34) upgrade first, then check packages.
   */
  function missingTools(raw: unknown): string | null {
    const migrated = migrateWorkspace(raw);
    const packages = migrated.ok
      ? ((migrated.config as { packages?: { id: string }[] }).packages ?? [])
      : [];
    const missing = packages.map((p) => p.id).filter((id) => !registry.tools.has(id));
    if (missing.length === 0) return null;
    const names = missing.map((id) => deps.toolName?.(id) ?? id).join(msg('listSeparator'));
    return msg('restoreNeedsTool', { names });
  }

  /** Switch to a saved preset (D-410): Same workflow as restoring a historical version, preview first, generate new version upon confirmation, undoable. */
  async function presetProposal(
    presetId: string,
    options?: { keepFiles?: boolean },
  ): Promise<ProposeResult> {
    const preset = await repo.getPreset(presetId);
    if (!preset) return { kind: 'invalid', issues: [msg('presetGone')] };
    return configProposal(
      preset.config,
      preset.name,
      `preset ${presetId}`,
      { kind: 'preset', presetId },
      options?.keepFiles === true,
    );
  }

  /**
   * The whole setup handed back from another AI app: previewed as an update of what is on the phone
   * and never saved as a preset. Same confirm and undo as every other change.
   */
  async function setupFileProposal(text: string): Promise<SetupFileResult> {
    const imported = importedPreset(text, '', [], msg('importAppConfigName'), registry);
    if (!imported.ok)
      return imported.problem === 'invalid'
        ? { kind: 'invalid', issues: imported.issues }
        : { kind: 'refused', problem: imported.problem };
    return configProposal(
      imported.config,
      imported.name,
      'setup from another AI app',
      { kind: 'setup' },
      true,
      true,
    );
  }

  async function configProposal(
    raw: unknown,
    name: string,
    input: string,
    plan: Record<string, unknown>,
    keepFiles = false,
    asUpdate = false,
  ): Promise<ProposeResult> {
    const { config, head } = get();
    if (!config || !head) throw new Error('workspace not loaded');
    const needsTool = missingTools(raw);
    if (needsTool) return { kind: 'invalid', issues: [needsTool] };
    const prepared = preparePreset(raw, registry);
    if (!prepared.ok) {
      await repo.createChangeRequest({
        input,
        plan,
        status: 'failed',
        baseRevisionId: head.id,
        error: prepared.issues.join('; '),
      });
      return { kind: 'invalid', issues: prepared.issues };
    }
    // When the full setup is handed back from another AI app: file references were cleared upon
    // export, and the user's selected files are restored to their original positions (invariant 3
    // unchanged). Clearing preset lists upon switching works as usual (D-410).
    const after = keepFiles ? keepChosenFiles(config, prepared.after) : prepared.after;
    return recordPreview(input, plan, head, {
      kind: 'restore',
      before: config,
      after,
      lines: asUpdate
        ? // Handed back from another AI app: an update of the app as it is now, not a switch to a saved preset.
          [
            msg('setupReturnIntro'),
            ...describePresetApply(config, after, name, { registry, locale }).slice(1),
          ]
        : describePresetApply(config, after, name, { registry, locale }),
      source: 'restore',
      summary: asUpdate ? msg('setupReturnSummary') : msg('presetApplySummary', { name }),
      focusPageId: 'home',
    });
  }

  async function restoreProposal(revisionId: number, input: string): Promise<ProposeResult> {
    const { config, head } = get();
    if (!config || !head) throw new Error('workspace not loaded');
    const target = await repo.getRevision(revisionId);
    const needsTool = target ? missingTools(target.config) : null;
    if (needsTool) return { kind: 'invalid', issues: [needsTool] };
    const prepared = target ? prepareSnapshot(target.config, registry) : null;
    if (!target || !prepared?.ok) {
      const issues =
        prepared && !prepared.ok ? prepared.issues : [`revision ${revisionId} not found`];
      await repo.createChangeRequest({
        input,
        plan: { kind: 'restore', revisionId },
        status: 'failed',
        baseRevisionId: head.id,
        error: issues.join('; '),
      });
      return { kind: 'invalid', issues };
    }
    return recordPreview(input, { kind: 'restore', revisionId }, head, {
      kind: 'restore',
      before: config,
      after: prepared.after,
      lines: describeRestore(config, prepared.after, target, { registry, locale }),
      source: 'restore',
      restoredTo: revisionId,
      summary: msg('restoreSummary', {
        when: formatWhen(locale, new Date(target.createdAt), deps.now()),
      }),
      focusPageId: 'home',
    });
  }

  /** Startup: Read current version, traverse history for the last usable one if broken. */
  async function bootHead() {
    try {
      // Soft-deleted records exceeding the retention period are permanently purged on startup (D-037).
      await repo.purgeDeletedRecords(
        deps.now().getTime() - RECORD_LIMITS.deletedRetentionDays * 24 * 60 * 60 * 1000,
      );
      const head = await repo.getHead();
      if (!head) {
        await repo.commitRevision({
          baseId: null,
          config: (deps.seed ?? createDefaultWorkspace)(locale, registry),
          source: 'seed',
          summary: msg('initialSummary'),
        });
        await reload();
        return;
      }
      // Traverse forward through history on startup to find the last valid version, ensuring no white screen (§4, §7E).
      for (
        let r: RevisionRecord | null = head;
        r;
        r = r.parentId ? await repo.getRevision(r.parentId) : null
      ) {
        const prepared = prepareSnapshot(r.config, registry);
        if (!prepared.ok) continue;
        if (r.id === head.id) {
          await reload();
        } else {
          await commitFallback(prepared.after, 'recovery', msg('recovered'));
          set({ banner: { kind: 'recovered', message: msg('recovered') } });
        }
        return;
      }
      await commitFallback(createDefaultWorkspace(locale), 'recovery', msg('recovered'));
      set({ banner: { kind: 'recovered', message: msg('recovered') } });
    } catch (e) {
      set({ status: 'error', error: String(e) });
    }
  }

  const actions: Pick<
    WorkspaceState,
    | 'propose'
    | 'proposeRestore'
    | 'proposePreset'
    | 'proposeSetupFile'
    | 'proposeOps'
    | 'setHomeEntry'
    | 'confirm'
    | 'cancel'
    | 'undo'
    | 'markRendered'
    | 'reportRenderError'
    | 'listRevisions'
  > = {
    async propose(input, planner = deps.provider, about) {
      const { config, head } = get();
      if (!config || !head) throw new Error('workspace not loaded');
      set({ busy: true });
      try {
        const raw = await planner.plan(input, {
          config,
          registry,
          locale,
          onProgress: (step) => set({ planProgress: step }),
          ...(about ? { about } : {}),
        });
        // Model output is always treated as untrusted data (§8).
        const parsed = PlanSchema.safeParse(raw);
        if (!parsed.success) {
          await repo.createChangeRequest({
            input,
            plan: raw,
            status: 'failed',
            baseRevisionId: head.id,
            error: 'plan did not match schema',
          });
          return { kind: 'invalid', issues: parsed.error.issues.map((i) => i.message) };
        }
        const plan = parsed.data;
        if (plan.kind === 'reject') {
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
        // Only onboarding tutorial here: sentences are single-sentence minor modifications, not going through build plans (Rule 53).
        if (plan.kind === 'build') return { kind: 'invalid', issues: [msg('buildFailedInvalid')] };
        if (plan.kind === 'restorePrevious') {
          if (head.parentId === null)
            return { kind: 'rejected', message: msg('noPrevious'), examples: [] };
          return await restoreProposal(head.parentId, input);
        }
        // Quick actions made for shared files run on the inbox page, home entry unchecked by default (D-124).
        const shaped =
          about?.kind === 'shared' || about?.kind === 'chain'
            ? { ...plan, homeEntry: plan.homeEntry ?? false }
            : plan;
        return await opsProposal(input, plan.ops, 'ai', input, shaped);
      } finally {
        set({ busy: false, planProgress: null });
      }
    },

    proposeRestore: (revisionId) => restoreProposal(revisionId, `restore #${revisionId}`),

    proposePreset: presetProposal,

    proposeSetupFile: setupFileProposal,

    proposeOps: (ops, summary, options) =>
      opsProposal(summary, ops, 'user', summary, undefined, options?.fromAppFile),

    setHomeEntry(on) {
      const proposal = get().proposal;
      if (!proposal?.homeEntry || !proposal.ops || proposal.homeEntry.on === on) return;
      const base = prepareOps(proposal.before, proposal.ops, {
        registry,
        locale,
        now: deps.now(),
      });
      if (!base.ok) return;
      const { focusWorkflowId: _, ...rest } = proposal;
      set({
        proposal: {
          ...rest,
          ...withHomeEntry(proposal.before, proposal.ops, base, proposal.homeEntry.workflowIds, on),
        },
      });
    },

    async confirm(options) {
      const proposal = get().proposal;
      if (!proposal) return false;
      set({ busy: true });
      try {
        const revision = await repo.commitRevision({
          baseId: proposal.baseRevisionId,
          config: proposal.after,
          source: proposal.source,
          summary: proposal.summary,
        });
        k.render.pending = {
          changeRequestId: proposal.changeRequestId,
          revisionId: revision.id,
          undoTo: proposal.baseRevisionId,
          summary: proposal.summary,
          ...(options?.quiet ? { quiet: true } : {}),
        };
        set({ proposal: null });
        // Removed tools lose file authorization; files themselves are retained (§7G).
        const remaining = new Set(proposal.after.packages.map((t) => t.id));
        for (const tool of proposal.before.packages) {
          if (!remaining.has(tool.id)) await repo.revokeToolGrants(tool.id);
        }
        await reload();
        await rebaseOpenDraft();
        if (proposal.kind === 'restore') {
          const { restoredTo } = proposal;
          await session.markUndone((rev) => restoredTo === undefined || rev > restoredTo);
        }
        return true;
      } catch (e) {
        if (!(e instanceof RevisionConflictError)) throw e;
        await repo.updateChangeRequest(proposal.changeRequestId, {
          status: 'failed',
          error: e.message,
        });
        set({ proposal: null, banner: { kind: 'conflict', message: msg('conflict') } });
        await reload();
        return false;
      } finally {
        set({ busy: false, planProgress: null });
      }
    },

    async cancel() {
      const proposal = get().proposal;
      if (!proposal) return;
      set({ proposal: null });
      await repo.updateChangeRequest(proposal.changeRequestId, { status: 'cancelled' });
    },

    async undo() {
      const undoTo = get().banner?.undoTo;
      if (undoTo === undefined) return;
      // Dismiss banner first: double-tapping will not undo twice (the second would hit a version conflict).
      set({ banner: null });
      const result = await restoreProposal(undoTo, msg('undoSummary'));
      // Failed to undo (e.g., required tool no longer exists): must report, cannot disappear quietly. Can still return via change history.
      if (result.kind !== 'preview') {
        set({ banner: { kind: 'conflict', message: msg('undoFailed') } });
        return;
      }
      // Undoing that feature modification means the remaining sentence can no longer be connected.
      await get().clearNext();
      await get().clearSuggest();
      set({ proposal: { ...result.proposal, summary: msg('undoSummary') } });
      await get().confirm();
    },

    async markRendered(revisionId) {
      const { head, config } = get();
      if (!head || head.id !== revisionId || !config) return;
      k.render.lastRendered = config;
      k.render.consecutiveRollbacks = 0;
      if (k.render.pending && k.render.pending.revisionId === revisionId) {
        const done = k.render.pending;
        k.render.pending = null;
        await repo.updateChangeRequest(done.changeRequestId, {
          status: 'committed',
          resultRevisionId: done.revisionId,
        });
        if (done.quiet) return;
        set({
          banner: {
            kind: 'applied',
            message:
              done.summary === msg('undoSummary')
                ? msg('undoneBanner')
                : msg('applied', { summary: done.summary }),
            undoTo: done.undoTo,
          },
        });
      }
    },

    async reportRenderError(error) {
      const { config } = get();
      const failed = k.render.pending;
      k.render.pending = null;
      if (++k.render.consecutiveRollbacks > 2) {
        set({ status: 'error', error: String(error) });
        return;
      }
      // Rollback target: configuration of the last successful render. The current configuration has
      // already displayed normally before, so the error is not in it (e.g., code error): do not
      // rollback, do not switch to default workspace (on 2026-11-06, such an error on the simulator
      // wiped out the user's app); consecutive errors exceeding twice still stop at the error page
      // as usual.
      const sameAsFailed =
        k.render.lastRendered && JSON.stringify(k.render.lastRendered) === JSON.stringify(config);
      if (sameAsFailed) {
        set((s) => ({ renderAttempt: s.renderAttempt + 1 }));
        return;
      }
      const fallback =
        k.render.lastRendered && !sameAsFailed
          ? k.render.lastRendered
          : createDefaultWorkspace(locale);
      // Descriptions shown to the user do not include raw error text; raw text is recorded in the change request's error.
      await commitFallback(fallback, 'rollback', msg('rolledBack'));
      if (failed) {
        await repo.updateChangeRequest(failed.changeRequestId, {
          status: 'rolled_back',
          resultRevisionId: failed.revisionId,
          error: String(error),
        });
      }
      set({ banner: { kind: 'rolledBack', message: msg('rolledBack') } });
    },

    listRevisions: (limit = 50, beforeId) => repo.listRevisions(limit, beforeId),
  };
  return { actions, opsProposal, restoreProposal, bootHead };
}
