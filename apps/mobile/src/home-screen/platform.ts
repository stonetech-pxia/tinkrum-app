import type { DrawnIcon, IconValue } from '@morph/core';

// Mobile desktop (D-271): long-press menu on Morph icon and separate icon on Android desktop.
// Implemented by local module MorphShortcuts in the app (native.ts), replaced with mock in tests.

/** Things drawn on the desktop icon (D-606): this icon drawn on this background color. */
export interface HomeScreenArt {
  icon: IconValue;
  background: string;
  foreground: string;
  /** Path when icon is my:<id> (D-625); omitted if not in icon library, drawing only the background color. */
  drawn?: DrawnIcon;
}

export interface HomeScreenEntry {
  /** Quick action ID, or app:<id>. */
  id: string;
  title: string;
  /** SF Symbol name in iOS menu. */
  symbol?: string;
  /** App-only (D-606): drawn by Android's long-press menu and standalone desktop icon; falls back to Tinkrum's icon when absent. */
  art?: HomeScreenArt;
}

export interface HomeScreenPlatform {
  /** Replaces the menu entirely; pinned icons missing from the menu on Android are disabled, tapping them shows disabledMessage. */
  setItems(items: readonly HomeScreenEntry[], disabledMessage: string): Promise<void>;
  /** Whether a separate icon can be placed on the desktop (Android only). */
  canPin(): boolean;
  /** Pops up the system confirmation dialog, can only be called after the user taps the button. Returns whether the request was sent. */
  pin(item: HomeScreenEntry): Promise<boolean>;
  /** Which quick action opened the app on cold start; returned only once. */
  takeLaunched(): string | null;
  /** Desktop menu or icon tapped while app is open; returns unsubscribe function. */
  onOpen(listener: (workflowId: string) => void): () => void;
}
