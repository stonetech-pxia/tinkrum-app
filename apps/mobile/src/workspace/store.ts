import { emptySession, type WorkspaceConfig } from '@morph/core';
import { createStore } from 'zustand/vanilla';

import { NEXT_META_KEY, SUGGEST_META_KEY, createAIChange, parseSuggest } from './store/ai-change';
import { createBuild } from './store/build';
import { createDraft } from './store/draft';
import { createEditing } from './store/editing';
import { createKernel } from './store/kernel';
import { createPresets } from './store/presets';
import { createRevisions } from './store/revisions';
import { createSession } from './store/session';
import type { WorkspaceDeps, WorkspaceState, WorkspaceStore } from './store/types';
import { createUI } from './store/ui';

// App-side orchestration of change protocol (§7D): user request -> plan -> validate -> preview ->
// confirm -> atomic save -> re-read and render -> success only if rendering succeeds, automatic
// rollback on failure.
//
// A zustand store split across files in store/ by responsibility, accessed externally only from
// here (createWorkspaceStore, shownConfig, types):
// - store/types.ts: types for state, actions, and results. New actions must first be declared in
// WorkspaceState.
// - store/kernel.ts: shared dependencies, messages, re-reading head, commits (render) waiting for
// "render success" confirmation.
// - store/revisions.ts: versions - preview -> confirm -> render confirmation / failure rollback,
// undo, restore historical version, startup. Button-initiated modifications (proposeOps) also go
// here.
// - store/ai-change.ts: AI modification single sentence (D-191, feature direct apply, appearance
// into draft) and "continue editing" (next).
// - store/session.ts: tool checklist (D-414): storage and logging; rules are in core ai/session.ts.
// - store/build.ts: large project build plan (D-415): step-by-step calls to ai-change.ts single
// sentence.
// - store/draft.ts: AI draft (D-190) saving, re-applying, stepping back, applying, leaving, sample
// apps.
// - store/editing.ts: direct editing and long-press editing (D-054, D-235).
// - store/presets.ts: saved presets (D-410) saving, renaming, deletion; applying goes through
// revisions.ts preview -> confirm.
// - store/ui.ts: banners, record tips, nav items, refresh signal. Put new features into their
// respective files; when needing internal functions from other files, pass them in from that file's
// create... return value (e.g., opsProposal).

export type {
  Applied,
  Banner,
  BuildRun,
  BuildRunStep,
  ChangeResult,
  Draft,
  DraftChatReply,
  DraftOrigin,
  DraftResult,
  DraftStep,
  EditDraft,
  EditResult,
  Proposal,
  ProposeResult,
  SavePresetResult,
  WaitingForDraft,
  WorkspaceDeps,
  WorkspaceState,
  WorkspaceStore,
} from './store/types';

/** Config to be displayed by shell and pages: draft in draft mode, current version otherwise. */
export function shownConfig(s: Pick<WorkspaceState, 'config' | 'draft'>): WorkspaceConfig | null {
  return s.draft?.open ? (s.draft.steps.at(-1)?.config ?? s.config) : s.config;
}

export function createWorkspaceStore(deps: WorkspaceDeps): WorkspaceStore {
  const { repo } = deps;
  return createStore<WorkspaceState>()((set, get) => {
    const k = createKernel(deps, set, get);
    const session = createSession(k);
    const draft = createDraft(k, session);
    const revisions = createRevisions(k, draft, session);
    const build = createBuild(k, session);
    const ai = createAIChange(k, { ...revisions, ...draft }, session, build.showBuild);
    build.useTurn(ai.aiChange);

    return {
      status: 'loading',
      error: null,
      config: null,
      head: null,
      proposal: null,
      banner: null,
      busy: false,
      planProgress: null,
      assetsVersion: 0,
      renderAttempt: 0,
      tab: null,
      appId: null,
      appEnters: 0,
      recordsVersion: 0,
      tableVersions: {},
      recordsAll: 0,
      presetsVersion: 0,
      toast: null,
      editing: null,
      draft: null,
      draftNotice: null,
      next: null,
      suggest: [],
      session: emptySession(),
      build: null,

      async boot() {
        await revisions.bootHead();
        if (get().status !== 'ready') return;
        await draft.loadDraft();
        const old = get().draft;
        await session.load(old ? draft.earlierOf(old) : []);
        await build.loadBuild();
        set({
          next: (await repo.getMeta(NEXT_META_KEY)) || null,
          suggest: parseSuggest(await repo.getMeta(SUGGEST_META_KEY)),
        });
      },

      ...revisions.actions,
      ...createEditing(k, revisions),
      ...createUI(k),
      ...createPresets(k),
      ...ai.actions,
      ...draft.actions,
      ...session.actions,
      ...build.actions,
    };
  });
}
