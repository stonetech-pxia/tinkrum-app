import type { NativeDataMatch } from '../../modules/morph-vision';
import type { SystemDataMatch } from './platform';

// JS part of VisionPlatform.detectData: system text recognition only serves as a supplement to
// rules (D-244), so any issues (missing model, offline, system error, incorrect result) do not
// affect prefilling; it returns empty directly, letting rules work normally. Does not download
// models.

export async function detectDataWith(
  detect: (text: string, language: string, allowDownload: boolean) => Promise<NativeDataMatch[]>,
  text: string,
  language: string,
): Promise<SystemDataMatch[]> {
  let found: NativeDataMatch[];
  try {
    found = await detect(text, language, false);
  } catch {
    return [];
  }
  return found.filter(
    (m) =>
      (m.kind === 'amount' || m.kind === 'date') &&
      Number.isInteger(m.start) &&
      Number.isInteger(m.end) &&
      m.start >= 0 &&
      m.end > m.start &&
      m.end <= text.length &&
      (m.kind === 'amount' || /^\d{4}-\d{2}-\d{2}$/.test(m.value ?? '')),
  );
}

/** Languages for which the user declined downloading are recorded in app_meta to avoid prompting again. */
const declinedKey = (language: string) => `prefill:model-declined:${language}`;

/**
 * Before using system recognition: if the system reports that a model must be downloaded first
 * (Android ML Kit), prompt the user and only download upon consent (D-244). If the user declines,
 * remember it and never ask again, using only rules; if status cannot be queried or download
 * fails, also fall back to rules only. Returns whether system recognition is available.
 */
export async function prepareDataDetection(
  vision: {
    dataDetectionStatus?(language: string): Promise<'ready' | 'download' | 'unsupported'>;
    downloadDataModel?(language: string): Promise<void>;
  },
  language: string,
  ask: () => Promise<boolean>,
  meta: {
    getMeta(key: string): Promise<string | null>;
    setMeta(key: string, value: string): Promise<void>;
  },
): Promise<boolean> {
  if (!vision.dataDetectionStatus) return false;
  let status: 'ready' | 'download' | 'unsupported';
  try {
    status = await vision.dataDetectionStatus(language);
  } catch {
    return false;
  }
  if (status === 'ready') return true;
  if (status !== 'download' || !vision.downloadDataModel) return false;
  if ((await meta.getMeta(declinedKey(language))) === 'yes') return false;
  if (!(await ask())) {
    await meta.setMeta(declinedKey(language), 'yes');
    return false;
  }
  try {
    await vision.downloadDataModel(language);
    return true;
  } catch {
    return false;
  }
}
