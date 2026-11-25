import { scopeProblems, tagNewForApp } from './app-scope';
import { describeChange } from './describe';
import { newFileRefs, restoreFileRefs } from './file-refs';
import { addNewAppsToHomeScreen } from './home-screen';
import { migrateWorkspace } from './migrate';
import { AppFileOpListSchema, OpListSchema, applyOps } from './ops';
import type { Registry } from './registry';
import type { Locale, WorkspaceConfig } from './schema';
import { validateWorkspace } from './validate';
import { addMissingPageEntries } from './page-entries';
import { referenceProblems } from './reference-checks';
import { issueLines } from './zod-issues';

// Platform-agnostic portion of ChangeRequest -> Plan -> Validate -> Preview (§5.3). Handled
// uniformly whether the modification originates from the mock AI, the real model, or UI buttons.

export interface ChangeContext {
  registry: Registry;
  locale: Locale;
  now: Date;
  /**
   * Modification originates from the AI (invariant 3): prohibits introducing new references to
   * user files (file slots, images, and image backgrounds can only be chosen directly by the
   * user). User-initiated modifications from the UI omit this flag.
   */
  fromAI?: boolean;
  /**
   * Scoped modification within a specific app (D-485): restricted to modifying only that app's
   * own pages, tables, quick actions, tab bar, and styles; any out-of-scope changes are
   * completely rejected. Modifications originating from the home screen omit this scope (applying
   * to the entire workspace).
   */
  scope?: { appId: string };
  /**
   * Operation originates from an app file (import, factory reset, D-554): exempt from the 30-step
   * modification limit, governed instead by configuration-level caps. Ignored when combined with
   * fromAI (AI plans are always capped at a maximum of 30 steps).
   */
  fromAppFile?: boolean;
}

export type PreparedChange =
  | { ok: true; after: WorkspaceConfig; lines: string[] }
  | { ok: false; stage: 'parse' | 'apply' | 'validate' | 'migrate'; issues: string[] };

/** Validates a list of operations from any source (including untrusted model outputs) and generates the results required for previewing. */
export function prepareOps(
  before: WorkspaceConfig,
  rawOps: unknown,
  ctx: ChangeContext,
): PreparedChange {
  const schema = ctx.fromAppFile && !ctx.fromAI ? AppFileOpListSchema : OpListSchema;
  const parsed = schema.safeParse(rawOps);
  if (!parsed.success) {
    return { ok: false, stage: 'parse', issues: issueLines(parsed.error) };
  }
  const applied = applyOps(before, parsed.data, ctx);
  if (!applied.ok) return { ok: false, stage: 'apply', issues: [applied.error] };
  // File IDs seen by the AI are placeholders; they are mapped back to the original files when written back.
  const config = restoreFileRefs(before, applied.config);
  // Newly added pages, tables, and quick actions within an app that lack an explicit app ID are assigned to the current app (as models frequently omit them).
  if (ctx.scope) tagNewForApp(before, config, ctx.scope.appId);
  // When a newly added page in a modification has no entry point to open it, a fallback entry is added to the home screen (since the AI frequently forgets to add one).
  const notes = [
    ...applied.notes,
    ...addMissingPageEntries(before, config).map((page) => ({
      kind: 'addedPageEntry' as const,
      page,
    })),
    // A new app starts out in the menu of the Tinkrum icon on the phone (D-new-apphome-4).
    ...addNewAppsToHomeScreen(before, config).map((name) => ({
      kind: 'appOnHomeScreen' as const,
      name,
    })),
  ];
  if (ctx.fromAI) {
    const added = newFileRefs(before, config);
    if (added.length > 0)
      return {
        ok: false,
        stage: 'validate',
        issues: added.map(
          (place) =>
            `${place}: only the user picks a file (a file slot's opens.file, an image's show.asset, a backdrop's assetId); leave it as it is or null`,
        ),
      };
  }
  // Pre-existing components from older versions that are unrecognized by the current version (D-254) are preserved as-is; modifications cannot add or alter them.
  const valid = validateWorkspace(config, ctx.registry, { unknownComponents: before });
  if (!valid.ok)
    return { ok: false, stage: 'validate', issues: valid.issues.map((i) => i.message) };
  if (ctx.scope) {
    const out = scopeProblems(before, valid.config, ctx.scope.appId, ctx.registry);
    if (out.length > 0) return { ok: false, stage: 'validate', issues: out };
  }
  // References not checked by the validator (invariant 18): modifications cannot introduce new broken references, but pre-existing ones are permitted (invariant 12, allowing older configurations to be modified normally).
  const old = new Set(referenceProblems(before, ctx.registry));
  const added = referenceProblems(valid.config, ctx.registry).filter((p) => !old.has(p));
  if (added.length > 0) return { ok: false, stage: 'validate', issues: added };
  return {
    ok: true,
    after: valid.config,
    lines: describeChange(parsed.data, before, notes, ctx),
  };
}

/** Migrates and validates historical snapshots (potentially from older schema versions) into a current usable configuration (§7E). */
export function prepareSnapshot(raw: unknown, registry: Registry): PreparedChange {
  const migrated = migrateWorkspace(raw);
  if (!migrated.ok) return { ok: false, stage: 'migrate', issues: [migrated.error] };
  // Components added by updated apps (D-254) are preserved as-is and written back upon saving.
  const valid = validateWorkspace(migrated.config, registry, { unknownComponents: 'keep' });
  if (!valid.ok)
    return { ok: false, stage: 'validate', issues: valid.issues.map((i) => i.message) };
  return { ok: true, after: valid.config, lines: [] };
}
