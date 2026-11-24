import { create } from 'zustand';

import type { WorkspaceRepo } from '../storage/types';
import type { PlacedWidget } from './types';

// User-placed widgets on the home screen (D-325): recorded exclusively in local app_meta, excluded
// from config, invisible and unmodifiable by AI. Preserved even after component deletion and
// displayed as "removed" on widgets until removed by the user in the app or cleared from the home
// screen.

const META_KEY = 'widgets.placed';
/** Maximum number of recorded items (to keep iOS "Edit Widgets" list concise). */
export const MAX_PLACED = 20;

interface PlacedState {
  /** null: Not yet read. */
  placed: PlacedWidget[] | null;
  repo: Pick<WorkspaceRepo, 'getMeta' | 'setMeta'> | null;
  load(repo: Pick<WorkspaceRepo, 'getMeta' | 'setMeta'>): Promise<void>;
  /** Place on home screen: moves previously placed items to the end (serving as the fallback displayed by widgets without a selected component). */
  add(componentId: string, now: number): Promise<void>;
  remove(componentId: string): Promise<void>;
}

function parse(text: string | null): PlacedWidget[] {
  try {
    const list = JSON.parse(text ?? '[]') as unknown;
    return Array.isArray(list)
      ? list.filter(
          (p): p is PlacedWidget =>
            typeof p?.componentId === 'string' && typeof p?.placedAt === 'number',
        )
      : [];
  } catch {
    return [];
  }
}

export const useWidgetPlacement = create<PlacedState>()((set, get) => {
  const save = async (placed: PlacedWidget[]) => {
    set({ placed });
    await get().repo?.setMeta(META_KEY, JSON.stringify(placed));
  };
  return {
    placed: null,
    repo: null,
    async load(repo) {
      set({ repo, placed: parse(await repo.getMeta(META_KEY)) });
    },
    async add(componentId, now) {
      const rest = (get().placed ?? []).filter((p) => p.componentId !== componentId);
      await save([...rest, { componentId, placedAt: now }].slice(-MAX_PLACED));
    },
    async remove(componentId) {
      await save((get().placed ?? []).filter((p) => p.componentId !== componentId));
    },
  };
});
