import { PAPER_APP_REQUEST, localize, type Locale, type Localized } from '@morph/core';

import { create } from 'zustand';

import type { WorkspaceRepo } from '../storage/types';

// Newcomer guidance (D-149, D-231, D-260, D-new-apphome-2): onboarding slider -> step 1 sends a
// sentence that builds the Paper app (takes effect immediately) -> step 2 says it is on the home
// page -> step 3 picks a sample app to apply entirely (enters draft first). Progress is stored in local app_meta; no
// records means first launch. "Settings -> Re-watch onboarding guide" starts over.

/** intro: onboarding slider to be displayed; look: step 1; goal: step 2; samples: step 3 (D-260); done: finished watching or closed. */
export type GuideStage = 'intro' | 'look' | 'goal' | 'samples' | 'done';

const STAGES: readonly GuideStage[] = ['intro', 'look', 'goal', 'samples', 'done'];
const META_KEY = 'guide';

interface GuideState {
  /** null: not read yet (not read in tests, guidance doesn't appear). */
  stage: GuideStage | null;
  repo: Pick<WorkspaceRepo, 'getMeta' | 'setMeta'> | null;
  /** Onboarding slider has been pushed and not closed (not persisted): shell doesn't push it again when remounting for a new version (discovered on real device in D-392). */
  introOpen: boolean;
  load(repo: Pick<WorkspaceRepo, 'getMeta' | 'setMeta'>): Promise<void>;
  setStage(stage: GuideStage): Promise<void>;
}

export const useGuide = create<GuideState>()((set, get) => ({
  stage: null,
  repo: null,
  introOpen: false,
  async load(repo) {
    const saved = await repo.getMeta(META_KEY);
    // Previous "Newcomer Tasks" small card (later) has been removed (D-231): treated as finished.
    const stage = saved === 'later' ? 'done' : saved;
    set({ repo, stage: STAGES.includes(stage as GuideStage) ? (stage as GuideStage) : 'intro' });
  },
  async setStage(stage) {
    set({ stage });
    await get().repo?.setMeta(META_KEY, stage);
  },
}));

/**
 * Sentences for step 1 (D-231, D-new-apphome-2): the home page lists no app yet, the sentence
 * builds the Paper app. All three languages are recognized by built-in rules, guidance uses
 * built-in rules fixedly without calling settings AI: results are stable and immediate, and no key
 * is needed (revision of D-228: previously French was delegated to settings AI).
 */
export const LOOK_PROMPTS: readonly Localized[] = [PAPER_APP_REQUEST];

/** Opens the sentence for step 1 of the guide (D-447: tapping either the speech bubble or Tink in the top right goes here). */
export function openLookGuide(router: {
  push(href: { pathname: '/change'; params: { guide: string } }): void;
}) {
  router.push({ pathname: '/change', params: { guide: 'look-0' } });
}

/** Sentence corresponding to the parameter carried when opening AI modification from the guide (step 1 sentences like `look-0`). */
export function guideText(param: string | undefined, locale: Locale): string | null {
  const look = /^look-(\d+)$/.exec(param ?? '');
  return look ? (localize(LOOK_PROMPTS[Number(look[1])], locale) ?? null) : null;
}
