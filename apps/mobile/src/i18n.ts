import { hasMessage, localize, t, type Locale, type Localized } from '@morph/core';

import { getLocales } from 'expo-localization';
export { t, type StringKey } from '@morph/core';

// UI copy is located in core/messages/ (en.ts, zh.ts, fr.ts); English, Simplified Chinese, and
// French follow the system language. User content (page titles, etc.) is stored in the workspace
// config and does not pass through here.

export function getDeviceLocale(): Locale {
  const [primary] = getLocales();
  return primary?.languageCode === 'zh' ? 'zh' : primary?.languageCode === 'fr' ? 'fr' : 'en';
}

/** Languages in phone settings (BCP 47, in user order), e.g., ['zh-Hant-TW', 'en-US']. */
export function deviceLanguageTags(): string[] {
  return getLocales().map((l) => l.languageTag);
}

const PERMISSION_NAMES: Record<string, Localized> = {
  photos: { en: 'Photos', zh: '相册', fr: 'Photos' },
  camera: { en: 'Camera', zh: '相机', fr: 'Appareil photo' },
  microphone: { en: 'Microphone', zh: '麦克风', fr: 'Microphone' },
  speech: { en: 'Speech recognition', zh: '语音识别', fr: 'Reconnaissance vocale' },
};

const FILE_KIND_NAMES: Record<string, Localized> = {
  image: { en: 'image', zh: '图片', fr: 'image' },
  video: { en: 'video', zh: '视频', fr: 'vidéo' },
  audio: { en: 'audio', zh: '音频', fr: 'audio' },
  file: { en: 'file', zh: '文件', fr: 'fichier' },
  documents: { en: 'Office document', zh: '办公文档', fr: 'document Office' },
};

/** Runtime error prompts (internal terms such as permission names in detail are replaced with user-friendly wording). */
export function runErrorText(
  locale: Locale,
  code: string,
  detail: Record<string, string | number> = {},
): string {
  const what =
    typeof detail.what === 'string' ? localize(PERMISSION_NAMES[detail.what], locale) : undefined;
  const kind =
    typeof detail.kind === 'string' ? localize(FILE_KIND_NAMES[detail.kind], locale) : undefined;
  const key = `runError_${code}`;
  if (!hasMessage(key)) return t(locale, 'runError_unexpected', { detail: code });
  return t(locale, key, {
    ...detail,
    ...(what ? { what } : {}),
    ...(kind && locale === 'fr' ? { kind } : {}),
  });
}

/** Timestamps in change history (D-112): today / yesterday 13:51, earlier entries show dates without seconds. */
export function formatWhen(locale: Locale, at: Date, now: Date): string {
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return t(locale, 'dateToday', { time });
  if (days === 1) return t(locale, 'dateYesterday', { time });
  const sameYear = at.getFullYear() === now.getFullYear();
  if (locale === 'zh')
    return `${sameYear ? '' : `${at.getFullYear()}年`}${at.getMonth() + 1}月${at.getDate()}日 ${time}`;
  const date = at.toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  // French formats as "25 oct. à 13:51".
  return locale === 'fr' ? `${date} à ${time}` : `${date}, ${time}`;
}

/**
 * Folder display name when saved to the phone (D-583): iOS "On My iPhone" and iCloud Drive
 * top-level folders have different names in the file system (File Provider Storage,
 * com~apple~CloudDocs), displayed according to the "Files" app naming; other folders use their
 * own names.
 */
export function folderName(locale: Locale, name: string): string {
  if (name === 'File Provider Storage') return t(locale, 'folderOnMyIPhone');
  if (name === 'com~apple~CloudDocs') return t(locale, 'folderICloudDrive');
  return name;
}
