import { MAX_APP_CONFIG_SIZE, type AppConfigFileProblem, type Locale } from '@morph/core';

import { t } from '@/i18n';
import type { FilePlatform } from '../runtime/platform';

// Used by "My presets -> Import from file" (D-485): selects a JSON file, reads text, and translates
// unreadability reasons into plain language. Entirely on-device, offline, file contents never sent
// to AI (invariants 1, 2).

/** Reason why this file cannot be read, in user-friendly terms. */
export function configFileProblemText(locale: Locale, problem: AppConfigFileProblem): string {
  switch (problem) {
    case 'tooLarge':
      return t(locale, 'importAppConfigTooLarge', { max: MAX_APP_CONFIG_SIZE / 1_000_000 });
    case 'notJson':
      return t(locale, 'importAppConfigNotJson');
    case 'newerApp':
      return t(locale, 'importAppConfigNewer');
    case 'wrongFormat':
      return t(locale, 'importAppConfigInvalid');
  }
}

export type PickedConfigText =
  /** User did not select. */
  | { kind: 'cancelled' }
  /** Selected, but unreadable: `problem` describes the reason. */
  | { kind: 'refused'; problem: AppConfigFileProblem }
  | { kind: 'text'; text: string; fileName: string };

/**
 * Uses system file picker to select a configuration file and reads its text. Skips reading files
 * that are too large into memory (compares sizes beforehand if known); deletes the cached picker
 * copy whether read or not; user's original file is untouched (AGENTS.md file ownership).
 */
export async function pickConfigText(files: FilePlatform): Promise<PickedConfigText> {
  const picked = await files.pickDocuments(['application/json', 'text/plain'], false);
  const file = picked?.[0];
  if (!file) return { kind: 'cancelled' };
  if (file.size !== null && file.size > MAX_APP_CONFIG_SIZE) {
    await files.removePickedCopies([file.uri]);
    return { kind: 'refused', problem: 'tooLarge' };
  }
  try {
    return { kind: 'text', text: await files.readPickedText(file.uri), fileName: file.name };
  } catch {
    await files.removePickedCopies([file.uri]);
    return { kind: 'refused', problem: 'wrongFormat' };
  }
}
