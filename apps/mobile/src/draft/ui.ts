import type { PlanAbout } from '@morph/core';
import { create } from 'zustand';

// UI state for draft mode (D-190), shared by the shell and the pushed page: whether the chat box is open and whether the latest step's reply is collapsed.

interface DraftUiState {
  chatOpen: boolean;
  /** The top-right entry point of the page from which the chat box was opened (D-406): speech in this chat session defaults to modifying it. */
  chatAbout: PlanAbout | null;
  /** The step (changeRequestId) where the reply is collapsed; displays the latest step's reply when the latest step is not this one. null = reopen. */
  seenStep: number | null;
  setChatOpen(open: boolean, about?: PlanAbout): void;
  markSeen(changeRequestId: number | null): void;
}

export const useDraftUi = create<DraftUiState>()((set) => ({
  chatOpen: false,
  chatAbout: null,
  seenStep: null,
  setChatOpen: (chatOpen, about) => set({ chatOpen, chatAbout: about ?? null }),
  markSeen: (seenStep) => set({ seenStep }),
}));
