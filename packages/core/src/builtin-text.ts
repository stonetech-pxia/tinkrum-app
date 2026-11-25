import { applyOps } from './ops';
import { registryRevision, type Registry } from './registry';
import type { Locale, WorkspaceConfig } from './schema';
import { createStarterWorkspace, paperAppOps } from './starter';

// Built-in text follows the interface language: the home page, toolbox, tool pages, and built-in
// quick action texts for new users are written into the configuration according to the language at
// the time of creation. When the language is changed in settings, built-in text matching a specific
// language is replaced character-for-character with the new language; user-modified text is left
// untouched. Replaced only at render time, not written to the configuration (language is a device
// preference, excluded from configuration and version history, D-459; invariant 15).

const LOCALES: readonly Locale[] = ['en', 'zh', 'fr'];

type Variants = Record<Locale, string>;

/** Aligns the same content across three languages by position; strings at the same position with different spellings in the three languages form a single built-in text entry. */
function pairStrings(versions: readonly unknown[], out: Map<string, Variants | null>) {
  const [first] = versions;
  if (typeof first === 'string') {
    if (!versions.every((v) => typeof v === 'string')) return;
    const texts = versions as string[];
    if (texts.every((s) => s === first)) return;
    const variants = Object.fromEntries(LOCALES.map((l, i) => [l, texts[i]])) as Variants;
    for (const s of new Set(texts)) {
      const known = out.get(s);
      // When the same phrase has different translations in different contexts and it is unclear which one to use, skip replacement altogether.
      if (known === undefined) out.set(s, variants);
      else if (known && LOCALES.some((l) => known[l] !== variants[l])) out.set(s, null);
    }
    return;
  }
  if (Array.isArray(first)) {
    if (!versions.every((v) => Array.isArray(v) && v.length === first.length)) return;
    first.forEach((_, i) =>
      pairStrings(
        versions.map((v) => (v as unknown[])[i]),
        out,
      ),
    );
    return;
  }
  if (first && typeof first === 'object') {
    if (!versions.every((v) => v && typeof v === 'object' && !Array.isArray(v))) return;
    for (const key of Object.keys(first)) {
      pairStrings(
        versions.map((v) => (v as Record<string, unknown>)[key]),
        out,
      );
    }
  }
}

function starterWithPaper(locale: Locale, registry: Registry): WorkspaceConfig {
  const config = createStarterWorkspace(locale, registry);
  const applied = applyOps(config, paperAppOps(config, locale, registry), { registry, locale });
  return applied.ok ? applied.config : config;
}

const cache = new WeakMap<Registry, { revision: number; index: Map<string, Variants | null> }>();

function builtinIndex(registry: Registry): Map<string, Variants | null> {
  const cached = cache.get(registry);
  if (cached && cached.revision === registryRevision(registry)) return cached.index;
  const index = new Map<string, Variants | null>();
  pairStrings(
    LOCALES.map((l) => starterWithPaper(l, registry)),
    index,
  );
  for (const tool of registry.tools.values()) {
    pairStrings(
      LOCALES.map((l) => tool.name[l] ?? tool.name.en),
      index,
    );
    pairStrings(
      LOCALES.map((l) => tool.createPage(l)),
      index,
    );
    pairStrings(
      LOCALES.map((l) => tool.createWorkflows(l)),
      index,
    );
  }
  cache.set(registry, { revision: registryRevision(registry), index });
  return index;
}

/** A segment of text in the configuration displayed according to the interface language: replaced with the localized variant if it is built-in text, otherwise returned as-is. */
export function builtinText(text: string, locale: Locale, registry: Registry): string;
export function builtinText(
  text: string | undefined,
  locale: Locale,
  registry: Registry,
): string | undefined;
export function builtinText(
  text: string | undefined,
  locale: Locale,
  registry: Registry,
): string | undefined {
  if (!text) return text;
  return builtinIndex(registry).get(text)?.[locale] ?? text;
}
