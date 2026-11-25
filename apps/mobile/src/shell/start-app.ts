import { startAppOf } from '@morph/core';

import { useAiReturn } from '../ai/return';
import { useGuide } from '../guide/store';
import type { WorkspaceStore } from '../workspace/store/types';

/**
 * Cold start (D-new-apphome-6): with a single app, Tinkrum opens in it. Not while the guide runs,
 * nor while something handed to another AI app is waited for: both speak on the home page. Opening
 * from the phone's home screen or a link still goes where it says, after this. Writes nothing
 * (invariant 15).
 */
export function openStartApp(store: WorkspaceStore): void {
  if (useGuide.getState().stage !== 'done' || useAiReturn.getState().pending) return;
  const { config, enterApp } = store.getState();
  const app = config && startAppOf(config);
  if (app) enterApp(app);
}
