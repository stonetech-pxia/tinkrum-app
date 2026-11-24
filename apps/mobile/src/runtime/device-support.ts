import type { Workflow } from '@morph/core';

import MorphDocs from '../../modules/morph-docs';

/**
 * Actions not supported by this device: hidden from entry points (PDF desk toolbar, quick action
 * list, inbox recommendations). PDF password protection is only implemented in iOS MorphDocs
 * (P-025), not available on Android, Expo Go, or tests.
 */
export const UNSUPPORTED_ACTIONS: ReadonlySet<string> = new Set(
  MorphDocs ? [] : ['pdf.protect', 'pdf.unlock'],
);

/** Whether every step of the quick action is supported on this device. */
export const runsHere = (wf: Workflow) => !wf.steps.some((s) => UNSUPPORTED_ACTIONS.has(s.action));
