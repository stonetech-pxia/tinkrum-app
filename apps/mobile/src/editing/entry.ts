/**
 * D-235: re-enable direct editing of single components via long press; full-page "Edit" button
 * continues to disable it. Both entry points are controlled separately, and the full-page editing
 * view is retained for testing and future use.
 */
export const directEditEntry = { longPress: true, pageButton: false };

/** Duration of long press required to select a component and start dragging. */
export const LONG_PRESS_MS = 450;
