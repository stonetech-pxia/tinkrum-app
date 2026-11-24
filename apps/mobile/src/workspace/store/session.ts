import {
  commitDrafted,
  dropDrafted,
  emptySession,
  issueReason,
  markSessionStart,
  markUndone,
  parseSession,
  recheckItems,
  recordTurn,
  t,
  type SessionTurn,
  type ToolVerdict,
  type WorkSession,
  type WorkspaceConfig,
} from '@morph/core';

import type { Kernel } from './kernel';
import type { WorkspaceState } from './types';

// Tool list (D-414): A session on the device, stored in app_meta, retained across app restarts. Not
// in config, AI cannot change it (Invariant 8); only user words, a sentence in the plan, and config
// structure, no records (Invariants 1, 2, 14). Rules are all in core's ai/session.ts.

const SESSION_META_KEY = 'session';

export function createSession(k: Kernel) {
  const { repo, registry, locale, set, get } = k;

  async function update(change: (s: WorkSession) => WorkSession) {
    const next = change(get().session);
    set({ session: next });
    await repo.setMeta(SESSION_META_KEY, JSON.stringify(next));
  }

  /** Record a sentence, then check whether previously unfinished items are now fixed. config: What the user sees after modification. */
  async function record(
    turn: Omit<SessionTurn, 'reason'> & { reason?: string; verdict?: ToolVerdict },
    config: WorkspaceConfig,
  ) {
    const first = turn.verdict?.blockers[0];
    const reason = turn.reason ?? (first ? issueReason(first, config, locale) : undefined);
    // "Fill these in" does not count as an item (D-418): calculate missing buttons yourself, and filling this sentence back into the input box does not include the issue checklist.
    const { kind, ...rest } = turn;
    const said = turn.input === t(locale, 'fixProblems') ? rest : turn;
    await update((s) =>
      recheckItems(
        recordTurn(s, { ...said, ...(reason ? { reason } : {}) }),
        config,
        registry,
        locale,
      ),
    );
  }

  /** Older app versions have no session: when a draft exists, connect words spoken in the draft chat box (earlier), rest are empty (Invariant 12). */
  async function load(earlier: WorkSession['said']) {
    const stored = await repo.getMeta(SESSION_META_KEY);
    set({ session: stored ? parseSession(stored) : { ...emptySession(), said: earlier } });
  }

  /** Record starting point before the first sentence (D-418): existing issues at this time do not count towards this session. */
  async function markStart(config: WorkspaceConfig) {
    const old = get().session;
    if (markSessionStart(old, config, registry) !== old)
      await update((s) => markSessionStart(s, config, registry));
  }

  const actions: Pick<WorkspaceState, 'clearSession'> = {
    clearSession: () => update(emptySession),
  };

  return {
    actions,
    update,
    record,
    load,
    markStart,
    commitDrafted: (crs: readonly number[], rev: number) =>
      update((s) => commitDrafted(s, crs, rev)),
    dropDrafted: (crs: readonly number[]) => update((s) => dropDrafted(s, crs)),
    markUndone: (undone: (rev: number) => boolean) => update((s) => markUndone(s, undone)),
  };
}

export type SessionStore = ReturnType<typeof createSession>;
