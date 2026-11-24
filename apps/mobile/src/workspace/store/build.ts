import {
  buildItemId,
  recheckItems,
  setItemStatus,
  startBuildItems,
  type PlanSession,
} from '@morph/core';

import { StepStopped, type createAIChange } from './ai-change';
import type { Kernel } from './kernel';
import type { SessionStore } from './session';
import type { BuildRun, BuildRunStep, ChangeResult, WorkspaceState } from './types';

// Large engineering build plan (AGENT_PLAN §3.9, D-415). The model returns the plan first, the user
// reviews it, can delete a few steps, and taps "Start". This click counts as one user action
// (interpretation of Invariant 16, D-416): one step per planner.plan, with tool list and current
// configuration; features take effect directly, appearances enter the draft (Invariant 7 remains
// unchanged); stops if a step fails, and the user chooses to retry, skip, or stop. App stays at the
// unfinished step after entering the background or restarting, and the user continues only after
// tapping.

const BUILD_META_KEY = 'build';

/** After completing the feature in this step, at most how many subsequent sentences (next) to continue executing. */
const NEXT_TURNS = 1;

function parseBuild(stored: string | null): BuildRun | null {
  if (!stored) return null;
  try {
    const run = JSON.parse(stored) as BuildRun;
    return Array.isArray(run.steps) && run.steps.length > 0 ? run : null;
  } catch {
    return null;
  }
}

type Turn = ReturnType<typeof createAIChange>['aiChange'];

export function createBuild(k: Kernel, session: SessionStore) {
  const { deps, repo, registry, locale, set, get, msg } = k;
  let turn: Turn;
  /** User tapped stop (or app entered background): Stop after finishing the current step on hand, and do not apply even if the model returns. */
  let stopRequested = false;
  let looping = false;

  async function save(build: BuildRun | null) {
    set({ build });
    await repo.setMeta(BUILD_META_KEY, build ? JSON.stringify(build) : '');
  }

  async function patchStep(id: string, patch: Partial<BuildRunStep>, phase?: BuildRun['phase']) {
    const build = get().build;
    if (!build) return;
    await save({
      ...build,
      ...(phase ? { phase } : {}),
      steps: build.steps.map((s) => {
        if (s.id !== id) return s;
        const { reason: _, needsDraft: _n, ...rest } = s;
        return { ...rest, ...patch };
      }),
    });
  }

  type StepOutcome =
    | { kind: 'done'; already?: boolean }
    | { kind: 'stopped' }
    | { kind: 'failed'; reason: string; needsDraft?: boolean };

  async function doStep(
    build: BuildRun,
    step: BuildRunStep,
    position: NonNullable<PlanSession['step']>,
  ): Promise<StepOutcome> {
    let input = step.current ?? step.request;
    let isNext = step.current !== undefined;
    for (let extra = 0; extra <= NEXT_TURNS; extra++) {
      const itemId = isNext ? undefined : buildItemId(step.id);
      let result: ChangeResult;
      try {
        result = await turn(input, deps.provider, build.origin, false, {
          step: position,
          ...(itemId ? { itemId } : {}),
          stillWanted: () => !stopRequested,
        });
      } catch (e) {
        if (e instanceof StepStopped) return { kind: 'stopped' };
        return { kind: 'failed', reason: msg('buildFailedModel') };
      }
      if (result.kind === 'needsDraft')
        return { kind: 'failed', reason: result.message, needsDraft: true };
      if (result.kind === 'invalid') return { kind: 'failed', reason: msg('buildFailedInvalid') };
      if (result.kind === 'rejected') {
        // Configuration is already like this: This step does not need to be executed.
        if (result.reason === 'noChange') {
          if (itemId) await session.update((s) => setItemStatus(s, itemId, 'done'));
          // This step's own sentence did not modify anything: It was already done previously. Not counted when subsequently executing remaining appearances.
          return { kind: 'done', ...(isNext ? {} : { already: true }) };
        }
        return { kind: 'failed', reason: result.message };
      }
      // Code determines whether it is done (D-414), regardless of what the model says.
      const item = get().session.items.find((i) =>
        itemId ? i.id === itemId : i.text === input && i.status !== 'todo',
      );
      if (item?.status === 'failed')
        return { kind: 'failed', reason: item.reason ?? msg('buildFailedInvalid') };
      // Remaining appearances in this sentence (next): Still counts as this step, without requiring the user to tap again (same "Start"). Remaining items stay in the checklist.
      const next = get().next;
      if (!next || next === input || extra === NEXT_TURNS) return { kind: 'done' };
      await patchStep(step.id, { status: 'running', current: next });
      input = next;
      isNext = true;
    }
    return { kind: 'done' };
  }

  async function finish() {
    const planned = get().draft?.steps.at(-1)?.config ?? get().config!;
    // Overall check: Deferred "page in next" items are evaluated at this point.
    await session.update((s) => recheckItems(s, planned, registry, locale, { all: true }));
    const build = get().build;
    if (build) await save({ ...build, phase: 'finished' });
  }

  /** Continue from the first unfinished step until completed, failed, or stopped. */
  async function run() {
    if (looping) return;
    looping = true;
    stopRequested = false;
    try {
      for (;;) {
        const build = get().build;
        if (!build) return;
        if (stopRequested) {
          await save({ ...build, phase: 'paused' });
          return;
        }
        const active = build.steps.filter((s) => s.status !== 'skipped');
        const step = active.find((s) => s.status !== 'done');
        if (!step) {
          await finish();
          return;
        }
        await patchStep(step.id, { status: 'running' }, 'running');
        const index = active.indexOf(step);
        const outcome = await doStep(get().build ?? build, step, {
          index: index + 1,
          total: active.length,
          remaining: active.length - index - 1,
        });
        if (outcome.kind === 'stopped') {
          await patchStep(step.id, { status: 'todo' }, 'paused');
          return;
        }
        if (outcome.kind === 'failed') {
          await patchStep(
            step.id,
            {
              status: 'failed',
              reason: outcome.reason,
              ...(outcome.needsDraft ? { needsDraft: true } : {}),
            },
            'failed',
          );
          await session.update((s) =>
            setItemStatus(s, buildItemId(step.id), 'failed', outcome.reason),
          );
          return;
        }
        await patchStep(step.id, { status: 'done', ...(outcome.already ? { already: true } : {}) });
      }
    } finally {
      looping = false;
    }
  }

  const actions: Pick<
    WorkspaceState,
    | 'removeBuildStep'
    | 'startBuild'
    | 'stopBuild'
    | 'resumeBuild'
    | 'skipBuildStep'
    | 'applyDraftForBuild'
    | 'endBuild'
  > = {
    async removeBuildStep(stepId) {
      const build = get().build;
      if (!build || build.phase !== 'review') return;
      const steps = build.steps.filter((s) => s.id !== stepId);
      await save(steps.length > 0 ? { ...build, steps } : null);
    },

    async startBuild() {
      const build = get().build;
      if (!build || build.phase !== 'review') return;
      await session.update((s) => startBuildItems(s, build.summary, build.steps));
      await save({ ...build, phase: 'running' });
      await run();
    },

    async stopBuild() {
      const build = get().build;
      if (!build) return;
      if (build.phase === 'running' && looping) stopRequested = true;
      else if (build.phase === 'failed' || build.phase === 'running')
        await save({ ...build, phase: 'paused' });
    },

    async resumeBuild() {
      const build = get().build;
      if (!build || (build.phase !== 'paused' && build.phase !== 'failed')) return;
      await save({ ...build, phase: 'running' });
      await run();
    },

    async skipBuildStep() {
      const build = get().build;
      const step = build?.steps.find((s) => s.status === 'failed');
      if (!build || build.phase !== 'failed' || !step) return;
      await patchStep(step.id, { status: 'skipped' }, 'running');
      await session.update((s) => setItemStatus(s, buildItemId(step.id), 'skipped'));
      await run();
    },

    async applyDraftForBuild() {
      const build = get().build;
      if (!build || build.phase !== 'failed') return;
      if (!(await get().applyDraft())) return;
      await actions.resumeBuild();
    },

    async endBuild() {
      const build = get().build;
      if (!build || (looping && build.phase === 'running')) return;
      await save(null);
    },
  };

  return {
    actions,
    /** ai-change.ts needs showBuild, and it needs its sentence here: reconnect after building is complete. */
    useTurn(fn: Turn) {
      turn = fn;
    },
    async showBuild({ summary, steps, origin }: Pick<BuildRun, 'summary' | 'steps' | 'origin'>) {
      await save({ summary, steps, origin, phase: 'review' });
    },
    /** Startup: What was being done last time is considered stopped, and the user continues only after tapping (Invariant 16). */
    async loadBuild() {
      const build = parseBuild(await repo.getMeta(BUILD_META_KEY));
      if (!build) return;
      if (build.phase !== 'running') {
        set({ build });
        return;
      }
      await save({
        ...build,
        phase: 'paused',
        steps: build.steps.map((s) => (s.status === 'running' ? { ...s, status: 'todo' } : s)),
      });
    },
  };
}
