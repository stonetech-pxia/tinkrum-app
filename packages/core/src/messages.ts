// Copy entry points: t(), pluralization rules, pairText. Copy itself is organized by language in
// messages/en.ts, zh.ts, fr.ts; keys across all three files are strictly guaranteed to match by
// MessageTable. Static imports only: app runs on Hermes.
import { FRENCH_PAIRS } from './french-pairs';
import { en, enSingular, type MessageTable, type StringKey } from './messages/en';
import { fr, frSingular } from './messages/fr';
import { zh } from './messages/zh';
import type { Locale } from './schema';

export type { StringKey } from './messages/en';

const TABLES: Record<Locale, MessageTable> = { en, zh, fr };
// Chinese has no grammatical number distinction, so there is no singular table.
const SINGULAR_TABLES: Record<Locale, Partial<MessageTable>> = {
  en: enSingular,
  zh: {},
  fr: frSingular,
};

/** Check whether a message exists for this key (used when keys are dynamically constructed, e.g., runError_<code>). */
export function hasMessage(key: string): key is StringKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/** Which parameter determines singular/plural form (defaults to n). */
const PLURAL_COUNT_VARIABLE: Partial<Record<StringKey, string>> = {
  describe_Also_removes_card_s_that_ran_this_quic_5d29f: 'v0',
  describe_Also_removes_block_s_that_showed_a7a30: 'v0',
  describe_Also_removes_button_s_or_shortcut_s_th_d4dc1: 'v0',
  runDone: 'pages',
  runError_tooFew: 'min',
  runError_tooMany: 'max',
  runError_tooLong: 'seconds',
  packDeleteWithLanguages: 'count',
  recordCount: 'count',
  deleteForeverConfirm: 'count',
  editPageSummary: 'count',
  deleteGroupMessage: 'count',
  describe_Add_page_blocks_80d1f: 'v1',
  html_records_3f794: 'v0',
  ShareScreen_Needs_at_least_files_0ed9b: 'v0',
  ShareScreen_Takes_at_most_files_0fe59: 'v0',
  RedactScreen_boxes_4d76c: 'v0',
  FillFormScreen_has_fields_to_fill_in_Use_Latin_letter_e3442: 'v2',
  PagesScreen_Restore_removed_a7e1a: 'v0',
  io_taken_af2cf: 'v0',
  WorkflowsScreen_Needs_at_least_files_0ed9b: 'v0',
  WorkflowsScreen_Takes_at_most_files_0fe59: 'v0',
  runError_noneMatched: 'count',
  runItemImage: 'total',
  runItemFile: 'total',
  prefillMemoryCount: 'count',
  prefillMemoryPicks: 'count',
  prefillMemoryRestoreConfirm: 'count',
  prefillMemoryRestored: 'count',
};

/**
 * Whether to use singular form (CLDR 'one'). Handcrafted instead of using Intl.PluralRules: the
 * app's Hermes engine lacks it, and calling it would throw an error directly. In French, 0 and
 * numbers less than 2 are singular; English has 1 only; Chinese does not distinguish
 * singular/plural.
 */
export function isSingular(locale: Locale, n: number): boolean {
  if (locale === 'fr') return n >= 0 && n < 2;
  if (locale === 'en') return n === 1;
  return false;
}

export function t(
  locale: Locale,
  key: StringKey,
  vars: Record<string, string | number> = {},
): string {
  const count = vars[PLURAL_COUNT_VARIABLE[key] ?? 'n'];
  const table = TABLES[locale] ?? en;
  const text =
    (typeof count === 'number' && isSingular(locale, count)
      ? SINGULAR_TABLES[locale]?.[key]
      : undefined) ?? table[key];
  // No grouping: numbers like version numbers and years must not be formatted with separators like "12 345".
  return text.replace(/\{(\w+)\}/g, (_, name: string) =>
    typeof vars[name] === 'number' && locale === 'fr'
      ? FRENCH_NUMBER.format(vars[name] as number)
      : String(vars[name] ?? `{${name}}`),
  );
}

const FRENCH_NUMBER = new Intl.NumberFormat('fr-FR', {
  maximumFractionDigits: 4,
  useGrouping: false,
});

/** Maintain compatibility with existing English/Chinese name pairs in tool definitions; unified fallback here until migration is complete. */
export function pairText(locale: Locale, pair: readonly [string, string]): string {
  return locale === 'zh' ? pair[1] : locale === 'fr' ? (FRENCH_PAIRS[pair[0]] ?? pair[0]) : pair[0];
}
