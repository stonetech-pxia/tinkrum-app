import { z } from 'zod';

import { APP_FILE_FORMAT, appFileOps, readAppFile, type AppFile } from './app-file';
import { explainProblems } from './app-file-explain';
import { designHints } from './design-hints';
import { DrawnIconsSchema } from './drawn-icons';
import { prepareOps } from './change';
import type { Registry } from './registry';
import {
  CURRENT_SCHEMA_VERSION,
  PageSchema,
  ToolSchema,
  quickActionsOf,
  remindersOf,
  type Locale,
  type WorkspaceConfig,
} from './schema';
import { AppSchema, CollectionSchema } from './schema-base';
import { createStarterWorkspace } from './starter';
import { checkTools, type ToolIssue } from './tool-check';
import { issueLines } from './zod-issues';

// Check whether an app file (tinkrum-app, D-485) can be imported, clearly explaining what is wrong
// (D-593): for users writing app files with other AIs (Claude, ChatGPT); the website check page and
// app import failure messages use the same set of checks. Follows the app import path: reads file
// (migration from older versions), creates import operations, calls prepareOps on the new user's
// workspace (same as "Import from file" with fromAppFile). Inspects structure only, does not touch
// records or files.

/**
 * App file shape (current version), used to generate JSON schema for other AIs to view, and to
 * itemize errors before import. Outer exportedAt and uses are optional: import ignores them (uses
 * is only used to indicate missing dependencies, D-556).
 */
export const AppFileSchema = z.object({
  format: z.literal(APP_FILE_FORMAT),
  version: z.literal(1),
  exportedAt: z.string().optional(),
  schemaVersion: z.number().int().min(1).max(CURRENT_SCHEMA_VERSION),
  uses: z.unknown().optional(),
  app: AppSchema,
  pages: z.array(PageSchema).min(1),
  tables: z.array(CollectionSchema),
  tools: z.array(ToolSchema),
  /** Drawn icons (D-625): items containing "my:<id>" in their content are defined here. */
  icons: DrawnIconsSchema.optional(),
});

export interface AppFileSummary {
  name: string;
  pages: number;
  tables: number;
  quickActions: number;
  reminders: number;
}

export type AppFileCheck =
  | {
      ok: true;
      file: AppFile;
      summary: AppFileSummary;
      warnings: string[];
      /** Design hints (D-602): places where functionality works, but can be made smoother. Does not block import. */
      hints: string[];
    }
  | { ok: false; problems: string[] };

/** Maximum number of issues to report: reporting more does not help fix the file; fix the earlier ones first. */
const MAX_PROBLEMS = 20;

/** Other AIs often wrap JSON in code blocks or add surrounding text: extracts from the first { to the last }. */
export function appFileJsonText(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

export function checkAppFileText(
  text: string,
  ctx: { registry: Registry; locale: Locale; now: Date },
): AppFileCheck {
  const fail = (problems: string[]): AppFileCheck => ({
    ok: false,
    problems:
      problems.length > MAX_PROBLEMS
        ? [...problems.slice(0, MAX_PROBLEMS), `…and ${problems.length - MAX_PROBLEMS} more`]
        : problems,
  });
  let data: unknown;
  try {
    data = JSON.parse(appFileJsonText(text));
  } catch (e) {
    return fail([`not valid JSON: ${e instanceof Error ? e.message : String(e)}`]);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return fail(['the file must be one JSON object']);
  const raw = data as Record<string, unknown>;
  if (raw.format !== APP_FILE_FORMAT)
    return fail([`format must be "${APP_FILE_FORMAT}" (got ${JSON.stringify(raw.format)})`]);
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > CURRENT_SCHEMA_VERSION)
    return fail([
      `schemaVersion ${raw.schemaVersion} is newer than this checker knows (${CURRENT_SCHEMA_VERSION}); write schemaVersion ${CURRENT_SCHEMA_VERSION}`,
    ]);
  // First check item by item according to the current version's shape (paths counted from the
  // file's top level); older version files are migrated first, and their shape is handled by import
  // validation. Files migrated only by updating their version number (subsequent versions only
  // added new optional values, e.g., 39 → 40, D-607) are checked item by item against the current
  // version.
  const older = typeof raw.schemaVersion === 'number' && raw.schemaVersion < CURRENT_SCHEMA_VERSION;
  const file = readAppFile(JSON.stringify(raw));
  if (!older || (file && onlyVersionMoved(raw, file))) {
    const shape = AppFileSchema.safeParse(
      older ? { ...raw, schemaVersion: CURRENT_SCHEMA_VERSION } : raw,
    );
    if (!shape.success) return fail(issueLines(shape.error, { value: raw }));
  }
  if (!file)
    return fail([
      'cannot read the file: it needs format, version, schemaVersion, app {id, name, bar, theme}, pages, tables and tools',
    ]);

  const starter = createStarterWorkspace(ctx.locale, ctx.registry);
  const plan = appFileOps(file, starter);
  if (!plan.ok) return fail(explainProblems([plan.error], file, ctx.registry));
  const prepared = prepareOps(starter, plan.ops, { ...ctx, fromAppFile: true });
  if (!prepared.ok) return fail(explainProblems(prepared.issues, file, ctx.registry));

  // Importable. The following are reminders only (similar to completion percentage on "My Presets", D-417): unusable features that only exist post-import.
  const after = prepared.after;
  const issueText = (i: ToolIssue) => `${i.target}: ${i.message}`;
  const blockers = (config: WorkspaceConfig) =>
    checkTools(config, ctx.registry)
      .issues.filter((i) => i.severity === 'blocker')
      .map(issueText);
  const before = new Set(blockers(starter));
  const warnings = blockers(after).filter((line) => !before.has(line));
  const mine = <T extends { app?: string | undefined }>(items: T[]) =>
    items.filter((x) => x.app === file.app.id).length;
  return {
    ok: true,
    file,
    summary: {
      name: file.app.name,
      pages: mine(after.containers.pages),
      tables: mine(after.data.tables),
      quickActions: mine(quickActionsOf(after)),
      reminders: mine(remindersOf(after)),
    },
    warnings,
    hints: designHints(file),
  };
}

/** After migrating to the current version, themes, pages, tables, and quick actions in the file remain completely unchanged. */
function onlyVersionMoved(raw: Record<string, unknown>, file: AppFile): boolean {
  const app = raw.app as { theme?: unknown } | undefined;
  return (
    JSON.stringify([app?.theme, raw.pages, raw.tables, raw.tools]) ===
    JSON.stringify([file.app.theme, file.pages, file.tables, file.tools])
  );
}
