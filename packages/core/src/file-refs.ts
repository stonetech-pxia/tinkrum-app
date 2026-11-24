import { allComponents, childrenOf, type Component, type WorkspaceConfig } from './schema';

// Invariant 3 (Founder 2026-10-31, conversation): Config references to user files can only be
// chosen by the user themselves. In v34 there are only four places (D-377): file slot opens.file,
// image block show.asset, card style.backdrop.assetId, and page backdrop.assetId. When sent to the
// AI, file IDs are replaced with placeholders; AI modifications cannot add any new file references.

/** Placeholder used to replace user file IDs in configurations sent to the AI. */
export const REDACTED_FILE = '<user file>';

const FILE_KEYS = new Set(['assetId', 'asset', 'file']);

interface FileRef {
  /** Location identifier: block ID (page-agnostic, moving a block does not count as a new reference) or page ID, combined with the path within the block. */
  place: string;
  id: string;
  holder: Record<string, unknown>;
  key: string;
}

function refsIn(value: unknown, place: string, path: string, into: FileRef[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => refsIn(v, place, `${path}.${i}`, into));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FILE_KEYS.has(k) && typeof v === 'string')
        into.push({
          place: `${place}${path}.${k}`,
          id: v,
          holder: value as Record<string, unknown>,
          key: k,
        });
      else refsIn(v, place, `${path}.${k}`, into);
    }
  }
}

/** Every file reference in the config (nested sub-blocks are counted separately, not aggregated at the group level). */
function fileRefs(config: WorkspaceConfig): FileRef[] {
  const out: FileRef[] = [];
  for (const page of config.containers.pages) {
    if (page.backdrop) refsIn(page.backdrop, `page:${page.id}`, '.backdrop', out);
    for (const c of allComponents(page)) {
      const own: Component = childrenOf(c).length > 0 ? ({ ...c, children: [] } as Component) : c;
      refsIn(own, `block:${c.id}`, '', out);
    }
  }
  return out;
}

/** Before sending to AI: Replace file IDs with placeholders (the AI only knows that a user file is placed here). */
export function redactFileRefs(config: WorkspaceConfig): WorkspaceConfig {
  if (fileRefs(config).length === 0) return config;
  const copy = JSON.parse(JSON.stringify(config)) as WorkspaceConfig;
  for (const ref of fileRefs(copy)) ref.holder[ref.key] = REDACTED_FILE;
  return copy;
}

/** Number of places in the config pointing to user files. */
export const countFileRefs = (config: WorkspaceConfig): number => fileRefs(config).length;

/**
 * Remove every file reference (presets, D-410): Keep file slots and images as empty placeholders,
 * and keep image backgrounds without images. Changing devices or deleting files will not result
 * in pointing to non-existent files (Invariant 18).
 */
export function clearFileRefs(config: WorkspaceConfig): WorkspaceConfig {
  const copy = JSON.parse(JSON.stringify(config)) as WorkspaceConfig;
  for (const ref of fileRefs(copy)) {
    if (ref.key === 'assetId') delete ref.holder[ref.key];
    else ref.holder[ref.key] = null;
  }
  return copy;
}

/**
 * After the full setup is returned from another AI app (D-637): every file reference was cleared
 * upon export (invariant 3), so those positions are empty in the returned configuration. If a
 * specific location (the same position in the same block, or the same page background) had a
 * user-selected file in the current configuration but is empty in the returned configuration,
 * that file is restored: no new file references are added (newFileRefs is empty), meaning the AI
 * can neither select a file nor substitute a different one; locations previously empty, already
 * containing other values, or previously pointing to multiple files are left untouched.
 */
export function keepChosenFiles(before: WorkspaceConfig, after: WorkspaceConfig): WorkspaceConfig {
  const old = new Map<string, FileRef>();
  const ambiguous = new Set<string>();
  for (const r of fileRefs(before)) {
    if (old.has(r.place) && old.get(r.place)!.id !== r.id) ambiguous.add(r.place);
    old.set(r.place, r);
  }
  for (const place of ambiguous) old.delete(place);
  if (old.size === 0) return after;
  const copy = JSON.parse(JSON.stringify(after)) as WorkspaceConfig;
  const roots = new Map<string, unknown>();
  for (const page of copy.containers.pages) {
    roots.set(`page:${page.id}`, page);
    for (const c of allComponents(page)) {
      const own: Component = childrenOf(c).length > 0 ? ({ ...c, children: [] } as Component) : c;
      if (!roots.has(`block:${c.id}`)) roots.set(`block:${c.id}`, { own, original: c });
    }
  }
  for (const [place, ref] of old) {
    const m = /^(page:[^.]+|block:[^.]+)(\..*)$/.exec(place);
    if (!m) continue;
    const root = roots.get(m[1]!);
    if (!root) continue;
    // Block: path starts from the block itself, excluding children (grouped child blocks are counted separately).
    let node: unknown = m[1]!.startsWith('block:')
      ? (root as { original: unknown }).original
      : root;
    const path = m[2]!.slice(1).split('.');
    const key = path.pop()!;
    for (const seg of path) {
      node = node && typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined;
    }
    if (!node || typeof node !== 'object') continue;
    const holder = node as Record<string, unknown>;
    if (holder[key] === undefined || holder[key] === null) holder[key] = ref.id;
  }
  return copy;
}

/**
 * When the AI writes placeholders back verbatim (e.g. rewriting an entire block opens), restore
 * the file ID from the same location prior to the modification. If that location originally had
 * no file or more than one, retain the placeholder (subsequent checks will reject it).
 */
export function restoreFileRefs(before: WorkspaceConfig, after: WorkspaceConfig): WorkspaceConfig {
  if (!fileRefs(after).some((r) => r.id === REDACTED_FILE)) return after;
  const old = new Map<string, Set<string>>();
  for (const r of fileRefs(before)) old.set(r.place, (old.get(r.place) ?? new Set()).add(r.id));
  const copy = JSON.parse(JSON.stringify(after)) as WorkspaceConfig;
  for (const ref of fileRefs(copy)) {
    const ids = old.get(ref.place);
    if (ref.id === REDACTED_FILE && ids?.size === 1) ref.holder[ref.key] = [...ids][0];
  }
  return copy;
}

/**
 * File references added after modification compared to before (by location). Clearing, removing,
 * moving, or changing other attributes do not count; newly added, swapped, or duplicated files
 * are counted.
 */
export function newFileRefs(before: WorkspaceConfig, after: WorkspaceConfig): string[] {
  const count = new Map<string, number>();
  for (const r of fileRefs(before)) {
    const key = `${r.place}=${r.id}`;
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const r of fileRefs(after)) {
    const key = `${r.place}=${r.id}`;
    const left = count.get(key) ?? 0;
    if (left > 0) count.set(key, left - 1);
    else added.push(r.place.replace(/^(block|page):/, ''));
  }
  return added;
}
