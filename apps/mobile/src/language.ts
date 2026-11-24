import type { Locale } from '@morph/core';
import { create } from 'zustand';

import { getDeviceLocale } from './i18n';

// UI language (Settings → Language): follows system, or fixed to English, Simplified Chinese, or
// French. A device-level preference stored in local app_meta, not part of the workspace config, and
// excluded from version history. When changed, the shell rebuilds the workspace using the new
// language (see _layout).

export type LanguagePreference = 'system' | Locale;

export const LANGUAGE_META_KEY = 'language';
export const LANGUAGE_CHOICES: readonly LanguagePreference[] = ['system', 'zh', 'en', 'fr'];

export const parseLanguage = (value: string | null): LanguagePreference =>
  LANGUAGE_CHOICES.includes(value as LanguagePreference) ? (value as LanguagePreference) : 'system';

export const resolveLocale = (preference: LanguagePreference): Locale =>
  preference === 'system' ? getDeviceLocale() : preference;

export const useLanguage = create<{
  preference: LanguagePreference;
  set(preference: LanguagePreference): void;
}>()((set) => ({
  preference: 'system',
  set: (preference) => set({ preference }),
}));
