import { prepareSnapshot, type PreparedChange } from './change';
import { parseAppConfigFile, type AppConfigFileProblem } from './config-file';
import { clearFileRefs } from './file-refs';
import type { Registry } from './registry';
import type { WorkspaceConfig } from './schema';

// "Settings → My Presets" (D-410): Stores the entire app (table structure, pages, tools, styles) as
// a kernel configuration so it can be restored later. Does not include records (records are not
// part of configuration, invariant 14) or references to user files (invariants 3 and 18). Presets
// are stored in the local database, not in WorkspaceConfig: configs are sent to the cloud AI every
// time, but presets are not sent along (invariants 1 and 2).

export const MAX_SAVED_PRESETS = 50;
export const MAX_PRESET_NAME = 40;

export const canSavePreset = (count: number): boolean => count < MAX_SAVED_PRESETS;

/** Formatted user-entered name; returns null if empty. Truncated by character without splitting emojis. */
export function presetName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  return name ? Array.from(name).slice(0, MAX_PRESET_NAME).join('') : null;
}

/** Save: A copy of the current configuration with all file references cleared. */
export const presetSnapshot = (config: WorkspaceConfig): WorkspaceConfig => clearFileRefs(config);

/** Apply: Stored presets might be from older versions, so first migrate and validate them (invariant 12), then clear file references again. */
export function preparePreset(raw: unknown, registry: Registry): PreparedChange {
  const prepared = prepareSnapshot(raw, registry);
  return prepared.ok ? { ...prepared, after: clearFileRefs(prepared.after) } : prepared;
}

/**
 * Name given to a preset when importing a file: removes extension from file name, formats and
 * truncates to 40 characters; uses fallback if empty; appends a sequence number like "name 2" if
 * there is a case-insensitive name clash, ensuring the result with the sequence number does not
 * exceed 40 characters.
 */
export function importedPresetName(
  fileName: string,
  existing: readonly string[],
  fallback: string,
): string {
  const base = presetName(fileName.replace(/\.[^./\\]*$/, '')) ?? presetName(fallback) ?? fallback;
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const room = MAX_PRESET_NAME - Array.from(suffix).length;
    const name = `${Array.from(base).slice(0, room).join('')}${suffix}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export type ImportedPreset =
  | { ok: true; name: string; config: WorkspaceConfig }
  /** The file itself cannot be read. */
  | { ok: false; problem: AppConfigFileProblem }
  /** Is an app config file, but migration or validation failed: issues list the specific reasons (invariant 18). */
  | { ok: false; problem: 'invalid'; issues: string[] };

/**
 * "My Presets → Import from File" (presets downloaded from the portal are loaded this way): reads
 * the file, migrates to the current version, validates, and clears file references (invariants 3,
 * 12, and 18). Returns the name to store and the configuration if passed; nothing is modified
 * here—saving it to the preset list is up to the caller, and the current app only changes when
 * the user taps "Apply" in the list. The configuration contains no records by design (invariant
 * 14).
 */
export function importedPreset(
  text: string,
  fileName: string,
  existingNames: readonly string[],
  fallbackName: string,
  registry: Registry,
): ImportedPreset {
  const parsed = parseAppConfigFile(text);
  if (!parsed.ok) return parsed;
  const prepared = preparePreset(parsed.config, registry);
  if (!prepared.ok) return { ok: false, problem: 'invalid', issues: prepared.issues };
  return {
    ok: true,
    name: importedPresetName(fileName, existingNames, fallbackName),
    config: prepared.after,
  };
}
