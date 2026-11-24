import { localDate } from './field-values';
import { usesOf } from './file-uses';
import { CURRENT_SCHEMA_VERSION, type WorkspaceConfig } from './schema';

// "Settings → Data → Export App Config": Saves the app's design (pages, data table structures,
// quick actions, reminders, theme) into a file. Does not include records, user files, or prefill
// memory; photos in the config are just random file IDs (D-046), and the files themselves are not
// stored inside.

export const APP_CONFIG_FILE_FORMAT = 'morph-app-config';
const FILE_VERSION = 1;

/** Includes "uses what" metadata at the outer layer (D-556): the read version can report what it lacks; this is not part of config and is not stored in local configuration. */
export function appConfigFile(config: WorkspaceConfig, now: Date): string {
  return JSON.stringify(
    {
      format: APP_CONFIG_FILE_FORMAT,
      version: FILE_VERSION,
      exportedAt: now.toISOString(),
      uses: usesOf(config),
      config,
    },
    null,
    2,
  );
}

/** Filename includes date (local time); multiple exports will not overwrite each other. */
export function appConfigFileName(now: Date): string {
  return `tinkrum-config-${localDate(now)}.json`;
}

/**
 * Maximum configuration file size: a real app config is only tens of KB; anything exceeding this
 * is not a config file and is not read into memory. File selection compares byte counts, while
 * the read text compares character counts (since each character is at least one byte, this is
 * never stricter than the file size limit).
 */
export const MAX_APP_CONFIG_SIZE = 2_000_000;

/** Reason for unreadability; callers translate these into user-facing messages (messages). */
export type AppConfigFileProblem =
  /** too large. */
  | 'tooLarge'
  /** not JSON. */
  | 'notJson'
  /** Valid JSON, but not an app configuration file (different format, missing format / version / config). */
  | 'wrongFormat'
  /** The file or its configuration was created by a newer version of Tinkrum and cannot be read by this version. */
  | 'newerApp';

export type ParsedAppConfigFile =
  { ok: true; config: Record<string, unknown> } | { ok: false; problem: AppConfigFileProblem };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read imported app configuration file: exported files (format, version, config; preset downloads
 * from portal also use this format), or directly a configuration object (with schemaVersion).
 * Only recognizes file shape and version; migration, validation, and clearing of file references
 * for older version configs are handled subsequently by prepareSnapshot / preparePreset
 * (invariants 3, 12, 18).
 */
export function parseAppConfigFile(text: string): ParsedAppConfigFile {
  if (text.length > MAX_APP_CONFIG_SIZE) return { ok: false, problem: 'tooLarge' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'notJson' };
  }
  const wrongFormat = { ok: false, problem: 'wrongFormat' } as const;
  if (!isObject(data)) return wrongFormat;
  let config: unknown = data;
  if (data.format !== undefined) {
    if (data.format !== APP_CONFIG_FILE_FORMAT) return wrongFormat;
    const version = data.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
      return wrongFormat;
    if (version > FILE_VERSION) return { ok: false, problem: 'newerApp' };
    config = data.config;
  }
  if (!isObject(config) || !Number.isInteger(config.schemaVersion)) return wrongFormat;
  if ((config.schemaVersion as number) > CURRENT_SCHEMA_VERSION)
    return { ok: false, problem: 'newerApp' };
  return { ok: true, config };
}
