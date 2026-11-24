import {
  RunError,
  commitVersion,
  sealEdit,
  currentFiles,
  decodeUtf8,
  isFileValue,
  isStaleDesk,
  deskBytes,
  newDesk,
  parseDesk,
  placeOutputs,
  redoDesk,
  undoDesk,
  type Desk,
  type DeskBlob,
  type DeskFile,
  type DeskSource,
  type DeskStep,
  type RunItem,
  type RunValue,
} from '@morph/core';
import {
  importOffice,
  isImportableOffice,
  leafBlocks,
  pagesWithoutTables,
  parseDocDoc,
  parseTableDoc,
  writeDocx,
  writeXlsx,
  type Box,
  type DocDoc,
  type DocxImage,
  type TableDoc,
} from '@morph/tool-office';

import { baseName, extOf, extOfMime, mimeOf } from '../runtime/actions/helpers';
import type { FilePlatform, PickedFile } from '../runtime/platform';

// Workspace storage (file-room DESIGN §3, §11.1, D-357): version stack logic is in @morph/core's
// desk/model.ts, where files are copied, moved, and deleted based on its calculated results, and
// workspaces are written as desk/<deskId>/desk.json. File ownership (AGENTS.md): originals are only
// copied when placed on the desk; tool results are temporary files in the runtime directory and are
// moved in directly; images referenced by intermediate formats (TableDoc / DocDoc) are placed in
// assets/, with relative paths in the JSON, shared across versions.

type Files = Pick<FilePlatform, 'desk' | 'readUri' | 'freeDiskBytes' | 'imageSize'>;

const JSON_NAME = 'desk.json';
/** An ongoing editing session (for crash prevention, §11.2): written on every modification, deleted when closed. */
const DRAFT_NAME = 'editing.json';

/** Relative path in workspace -> path under desk/. */
const inDesk = (desk: Pick<Desk, 'id'>, path: string) => `${desk.id}/${path}`;

/** Keep only letters and numbers in file extensions (for use as filenames). */
const cleanExt = (ext: string) => ext.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';

export function newDeskId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Current URI of a file on the desk. */
export const deskFileUri = (files: Files, desk: Desk, path: string) =>
  files.desk.uri(inDesk(desk, path));

// Manifests (desk.json) and ongoing edits (editing.json) are not overwritten directly (if
// interrupted midway, the file gets truncated, destroying the version entry point for this
// workspace, R08): first write completely to <file>.tmp, read back to verify, then rename the old
// file to <file>.bak, and finally rename .tmp to the official file. When reading, if the official
// file cannot be read, fall back to .tmp (fully written, not yet swapped), and then to .bak (the
// last good copy).

const tmpOf = (path: string) => `${path}.tmp`;
const bakOf = (path: string) => `${path}.bak`;

/** Read a manifest: the first valid one among the official file, .tmp, and .bak. */
async function readManifest(
  fs: Files['desk'],
  path: string,
  valid: (text: string) => boolean,
): Promise<string | null> {
  for (const candidate of [path, tmpOf(path), bakOf(path)]) {
    const text = await fs.readText(candidate);
    if (text !== null && valid(text)) return text;
  }
  return null;
}

/** Write a manifest: throw an error if incomplete or read-back verification fails, leaving the official file untouched. */
async function writeManifest(
  fs: Files['desk'],
  path: string,
  text: string,
  valid: (text: string) => boolean,
): Promise<void> {
  const tmp = tmpOf(path);
  await fs.writeText(tmp, text);
  if ((await fs.readText(tmp)) !== text) {
    await fs.remove([tmp]);
    throw new Error(`desk manifest was not written completely: ${path}`);
  }
  // Keep the current official file as .bak only if it is valid; replace bad ones directly without overwriting the last good .bak with a corrupted one.
  const current = await fs.readText(path);
  if (current !== null && valid(current)) {
    await fs.remove([bakOf(path)]);
    await fs.rename(path, bakOf(path));
  } else {
    await fs.remove([path]);
  }
  await fs.rename(tmp, path);
}

const removeManifest = (fs: Files['desk'], path: string) =>
  fs.remove([path, tmpOf(path), bakOf(path)]);

const deskValid = (deskId: string) => (text: string) => parseDesk(text)?.id === deskId;
const isJson = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

export async function saveDesk(files: Files, desk: Desk): Promise<void> {
  await writeManifest(
    files.desk,
    inDesk(desk, JSON_NAME),
    JSON.stringify(desk),
    deskValid(desk.id),
  );
}

export async function loadDesk(files: Files, deskId: string): Promise<Desk | null> {
  const text = await readManifest(files.desk, `${deskId}/${JSON_NAME}`, deskValid(deskId));
  return text === null ? null : parseDesk(text);
}

/** All workspaces (listed on storage page, cleanup prompts); directories that cannot be read are excluded. */
export async function listDesks(files: Files): Promise<Desk[]> {
  const out: Desk[] = [];
  for (const id of await files.desk.list()) {
    const desk = await loadDesk(files, id);
    if (desk) out.push(desk);
  }
  return out.sort((a, b) => b.touchedAt - a.touchedAt);
}

export const deskSummary = (desk: Desk, now: number) => ({
  id: desk.id,
  names: currentFiles(desk).map((f) => `${f.name}.${f.ext}`),
  bytes: deskBytes(desk),
  touchedAt: desk.touchedAt,
  stale: isStaleDesk(desk, now),
});

/** Do not start copying when disk space is insufficient (large videos). */
function checkSpace(files: Files, bytes: number) {
  const free = files.freeDiskBytes();
  if (free !== null && bytes * 1.1 > free) {
    throw new RunError('notEnoughSpace', {
      gb: Math.ceil(((bytes * 1.1 - free) / 1024 ** 3) * 10) / 10,
    });
  }
}

/**
 * Place on desk ("Place on desk" on the inbox page): create a working copy for each, originals
 * are never touched. The inbox batch (shares, picker copies) is released by the inbox page as
 * usual. External docx / xlsx are read into intermediate formats (D-509).
 */
export async function placeOnDesk(
  files: Files,
  picked: readonly PickedFile[],
  now: number,
  deskId = newDeskId(),
): Promise<Desk> {
  checkSpace(
    files,
    picked.reduce((n, f) => n + (f.size ?? 0), 0),
  );
  const placed: DeskFile[] = [];
  try {
    for (const [i, f] of picked.entries()) {
      // If the name lacks an extension (common when shared from other Android apps), supply one based on MIME type: format-recognizing tools like PDF converters rely on extensions.
      const ext = cleanExt(extOf(f.name) || extOfMime(f.mimeType));
      const path = `v1-${i}.${ext}`;
      const size = await files.desk.copyIn(f.uri, `${deskId}/${path}`);
      const source = await importedSource(files, deskId, path, ext, `v1-${i}`);
      placed.push({
        id: `f1-${i}`,
        name: baseName(f.name) || f.name,
        ext,
        mimeType: mimeOf(f.name, f.mimeType),
        size,
        path,
        ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
        ...(f.durationMs ? { durationMs: f.durationMs } : {}),
        ...(source ? { source } : {}),
      });
    }
    const desk = newDesk(deskId, placed, now);
    await saveDesk(files, desk);
    return desk;
  } catch (error) {
    await files.desk.removeDesk(deskId);
    throw error;
  }
}

/**
 * External docx / xlsx (D-509): read the intermediate format from the desk copy, making the desk
 * function as a Word / spreadsheet editor (identical to exported ones); write images into
 * assets/. Unreadable ones (password-protected, corrupted, too large) remain plain files
 * (viewable, convertible to PDF). Desk files remain copies of the originals and are regenerated
 * only when modified.
 */
async function importedSource(
  files: Files,
  deskId: string,
  path: string,
  ext: string,
  tag: string,
): Promise<DeskSource | undefined> {
  if (!isImportableOffice(ext)) return undefined;
  let result;
  try {
    result = importOffice(await files.readUri(files.desk.uri(`${deskId}/${path}`)), ext);
  } catch {
    return undefined;
  }
  if (!result?.ok) return undefined;
  const assets: DeskBlob[] = [];
  let doc: TableDoc | DocDoc = result.doc;
  if (result.kind === 'doc') {
    const paths = new Map<string, string>();
    for (const [k, [src, image]] of [...result.images].entries()) {
      const rel = `assets/${tag}-${k}.${image.ext}`;
      assets.push({
        path: rel,
        size: await files.desk.writeBytes(`${deskId}/${rel}`, image.bytes),
      });
      paths.set(src, rel);
    }
    doc = mapSourcePaths({ kind: 'doc', doc: result.doc }, (p) => paths.get(p) ?? '').doc;
  }
  const json = `${tag}.json`;
  const size = await files.desk.writeText(`${deskId}/${json}`, JSON.stringify(doc));
  return { kind: result.kind, path: json, size, assets, imported: 'original' };
}

/** Adopt files returned from the runtime into the workspace: use existing workspace files directly, move runtime directory files in, and copy others. */
async function adopt(
  files: Files,
  desk: Desk,
  uri: string,
  path: string,
  copy = false,
): Promise<DeskBlob> {
  const own = files.desk.pathOf(uri);
  const prefix = `${desk.id}/`;
  if (own?.startsWith(prefix)) {
    const rel = own.slice(prefix.length);
    const known = desk.versions
      .flatMap((v) => v.files)
      .flatMap((f) => [f, ...(f.source ? [f.source, ...f.source.assets] : [])])
      .find((b) => b.path === rel);
    if (known) return { path: rel, size: known.size };
  }
  const size =
    !copy && files.desk.isRunFile(uri)
      ? await files.desk.moveIn(uri, inDesk(desk, path))
      : await files.desk.copyIn(uri, inDesk(desk, path));
  return { path, size };
}

/** Images referenced by intermediate formats: move into assets/, moving each unique image only once; update JSON with relative paths inside the workspace. */
async function adoptSource(
  files: Files,
  desk: Desk,
  item: RunItem,
  path: string,
  tag: string,
  copy = false,
): Promise<DeskSource | undefined> {
  const kind =
    item.tableDoc?.for === item.uri ? 'table' : item.docDoc?.for === item.uri ? 'doc' : null;
  if (!kind) return undefined;
  const ref = kind === 'table' ? item.tableDoc! : item.docDoc!;
  let doc: TableDoc | DocDoc | null;
  try {
    const text = decodeUtf8(await files.readUri(ref.uri));
    doc = kind === 'table' ? parseTableDoc(text) : parseDocDoc(text);
  } catch {
    doc = null;
  }
  // Discard unreadable intermediate formats: this version becomes a regular xlsx / docx (viewable, convertible to PDF, but uneditable).
  if (!doc) return undefined;
  const assets = new Map<string, DeskBlob>();
  const asset = async (uri: string) => {
    const seen = assets.get(uri);
    if (seen) return seen.path;
    const blob = await adopt(
      files,
      desk,
      uri,
      `assets/${tag}-${assets.size}.${cleanExt(extOf(uri.split('?')[0]!)) || 'jpg'}`,
      copy,
    );
    assets.set(uri, blob);
    return blob.path;
  };
  for (const page of doc.pages) {
    if (page.source) page.source = await asset(page.source);
  }
  if (kind === 'table') {
    // Images cropped during Excel conversion (D-520).
    for (const page of (doc as TableDoc).pages) {
      for (const block of page.blocks) {
        if (block.kind === 'image' && block.src) block.src = await asset(block.src);
      }
    }
  }
  if (kind === 'doc') {
    for (const page of (doc as DocDoc).pages) {
      for (const block of leafBlocks(page)) {
        if (block.kind === 'image' && block.src) block.src = await asset(block.src);
      }
    }
  }
  const size = await files.desk.writeText(inDesk(desk, path), JSON.stringify(doc));
  return {
    kind,
    path,
    size,
    ...(kind === 'table' && item.tableDoc?.pagesWithoutTables?.length
      ? { pagesWithoutTables: item.tableDoc.pagesWithoutTables }
      : {}),
    assets: [...assets.values()],
  };
}

export interface DeskCommit {
  desk: Desk;
  /** When there is no file output (text recognition, QR code reading): output is shown to the user only, workspace remains unchanged. */
  text?: string;
}

/**
 * Commit the results of a run (a tool or quick action) back to the workspace, generating a new
 * version (§3.1). `selected` is the ID of the desk file passed to this run. The caller deletes
 * the runtime directory afterward (moved-in files are no longer there).
 */
export async function commitRun(
  files: Files,
  desk: Desk,
  selected: readonly string[],
  value: RunValue | null,
  by: DeskStep,
  now: number,
): Promise<DeskCommit> {
  if (value?.type === 'text') return { desk, text: value.text };
  if (!isFileValue(value) || value.items.length === 0) return { desk };
  const n = desk.nextN;
  const outputs: DeskFile[] = [];
  for (const [i, item] of value.items.entries()) {
    const ext = cleanExt(item.ext);
    const blob = await adopt(files, desk, item.uri, `v${n}-${i}.${ext}`);
    const same = desk.versions.flatMap((v) => v.files).find((f) => f.path === blob.path);
    // Files returned unchanged by the tool (e.g., if the final step of a quick action is sharing): remains the original desk file.
    if (same) {
      outputs.push(same);
      continue;
    }
    const source = await adoptSource(files, desk, item, `v${n}-${i}.json`, `v${n}-${i}`);
    outputs.push({
      id: `f${n}-${i}`,
      name: item.name,
      ext,
      mimeType: item.mimeType,
      size: blob.size,
      path: blob.path,
      ...(item.width && item.height ? { width: item.width, height: item.height } : {}),
      ...(item.pageCount ? { pageCount: item.pageCount } : {}),
      ...(item.durationMs ? { durationMs: item.durationMs } : {}),
      ...(source ? { source } : {}),
    });
  }
  const next = placeOutputs(currentFiles(desk), selected, outputs);
  if (!next) return { desk };
  // Results are identical to current desk contents (tool changed nothing): do not generate a new version.
  const before = currentFiles(desk);
  if (next.length === before.length && next.every((f, i) => f === before[i])) return { desk };
  const change = commitVersion(desk, next, by, now);
  await saveDesk(files, change.desk);
  await files.desk.remove(change.drop.map((p) => inDesk(desk, p)));
  return { desk: change.desk };
}

export async function undo(files: Files, desk: Desk, now: number): Promise<Desk> {
  const next = undoDesk(desk, now);
  if (next !== desk) await saveDesk(files, next);
  return next;
}

export async function redo(files: Files, desk: Desk, now: number): Promise<Desk> {
  const next = redoDesk(desk, now);
  if (next !== desk) await saveDesk(files, next);
  return next;
}

/** Clear workspace (triggered by user): delete the entire directory; those already saved as user files are unaffected. */
export const clearDesk = (files: Files, deskId: string) => files.desk.removeDesk(deskId);

/** Load a file's intermediate format, replacing relative image paths with current URIs (for display). Returns null if unreadable. */
export async function loadDeskSource(
  files: Files,
  desk: Desk,
  file: DeskFile,
): Promise<{ kind: 'table'; doc: TableDoc } | { kind: 'doc'; doc: DocDoc } | null> {
  if (!file.source) return null;
  const text = await files.desk.readText(inDesk(desk, file.source.path));
  if (text === null) return null;
  const uri = (path: string) => (path ? deskFileUri(files, desk, path) : path);
  if (file.source.kind === 'table') {
    const doc = parseTableDoc(text);
    if (!doc) return null;
    for (const page of doc.pages) {
      page.source = uri(page.source);
      for (const block of page.blocks) {
        if (block.kind === 'image' && block.src) block.src = uri(block.src);
      }
    }
    return { kind: 'table', doc };
  }
  const doc = parseDocDoc(text);
  if (!doc) return null;
  for (const page of doc.pages) {
    page.source = uri(page.source);
    for (const block of leafBlocks(page)) {
      if (block.kind === 'image' && block.src) block.src = uri(block.src);
    }
  }
  return { kind: 'doc', doc };
}

/**
 * When passing to tools, desk Word files carry their intermediate format (D-466, with images
 * replaced by readable URIs): document-to-PDF conversion formats according to editor layout.
 * Unreadable ones are passed as files as usual.
 */
export async function deskPickedWithSources(
  files: Files,
  desk: Desk,
  list: readonly DeskFile[],
): Promise<PickedFile[]> {
  const picked = deskPicked(files, desk, list);
  return Promise.all(
    picked.map(async (p, i) => {
      const file = list[i]!;
      // Unmodified external Word documents (D-509): convert from the original without applying editor layout.
      if (file.source?.kind !== 'doc' || file.source.imported === 'original') return p;
      const source = await loadDeskSource(files, desk, file).catch(() => null);
      return source?.kind === 'doc' ? { ...p, docDoc: source.doc } : p;
    }),
  );
}

/** Format of desk files when passed to runtime (same as files shared in, D-115). */
export function deskPicked(files: Files, desk: Desk, list: readonly DeskFile[]): PickedFile[] {
  return list.map((f) => ({
    uri: deskFileUri(files, desk, f.path),
    name: `${f.name}.${f.ext}`,
    size: f.size,
    mimeType: f.mimeType,
    ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
    ...(f.durationMs ? { durationMs: f.durationMs } : {}),
  }));
}

/**
 * "Place on desk" on result pages (D-366, replacing former "View and edit"): copy these results
 * into a new workspace along with intermediate formats and images. Copy only, do not move: result
 * pages still display them (runtime directory is deleted only when the runtime page closes).
 */
export async function placeResultsOnDesk(
  files: Files,
  items: readonly RunItem[],
  now: number,
  deskId = newDeskId(),
): Promise<Desk> {
  checkSpace(
    files,
    items.reduce((n, i) => n + i.size, 0),
  );
  const empty = newDesk(deskId, [], now);
  const placed: DeskFile[] = [];
  try {
    for (const [i, item] of items.entries()) {
      const ext = cleanExt(item.ext);
      const blob = await adopt(files, empty, item.uri, `v1-${i}.${ext}`, true);
      const source = await adoptSource(files, empty, item, `v1-${i}.json`, `v1-${i}`, true);
      placed.push({
        id: `f1-${i}`,
        name: item.name,
        ext,
        mimeType: item.mimeType,
        size: blob.size,
        path: blob.path,
        ...(item.width && item.height ? { width: item.width, height: item.height } : {}),
        ...(item.pageCount ? { pageCount: item.pageCount } : {}),
        ...(source ? { source } : {}),
      });
    }
    const desk = newDesk(deskId, placed, now);
    await saveDesk(files, desk);
    return desk;
  } catch (error) {
    await files.desk.removeDesk(deskId);
    throw error;
  }
}

/** A file's intermediate format (images use current URIs when displayed, and relative workspace paths when saved back). */
export type DeskSourceDoc = { kind: 'table'; doc: TableDoc } | { kind: 'doc'; doc: DocDoc };

/** Remap image paths in the intermediate format (without modifying the original). */
export function mapSourcePaths(source: DeskSourceDoc, fn: (path: string) => string): DeskSourceDoc {
  if (source.kind === 'table') {
    return {
      kind: 'table',
      doc: {
        ...source.doc,
        pages: source.doc.pages.map((p) => ({
          ...p,
          source: fn(p.source),
          // Images cropped during Excel conversion (D-520).
          blocks: p.blocks.map((b) => (b.kind === 'image' && b.src ? { ...b, src: fn(b.src) } : b)),
        })),
      },
    };
  }
  const doc = JSON.parse(JSON.stringify(source.doc)) as DocDoc;
  for (const page of doc.pages) {
    page.source = fn(page.source);
    for (const block of leafBlocks(page)) {
      if (block.kind === 'image' && block.src) block.src = fn(block.src);
    }
  }
  return { kind: 'doc', doc };
}

/** Images used by the intermediate format (source screenshot pages, cropped images). */
export function sourcePaths(source: DeskSourceDoc): Set<string> {
  const out = new Set<string>();
  mapSourcePaths(source, (path) => {
    if (path) out.add(path);
    return path;
  });
  return out;
}

/** Convert display URIs back to relative paths within the workspace. */
const relativeSource = (files: Files, desk: Desk, source: DeskSourceDoc) =>
  mapSourcePaths(source, (path) => {
    const own = files.desk.pathOf(path);
    return own?.startsWith(`${desk.id}/`) ? own.slice(desk.id.length + 1) : path;
  });

/** Images embedded in docx or xlsx (those cropped): read according to paths specified in the intermediate format. */
async function embeddedImages(
  files: Files,
  desk: Desk,
  pictures: Iterable<{ src?: string; box: Box }>,
) {
  const out = new Map<string, DocxImage>();
  for (const block of pictures) {
    if (!block.src || out.has(block.src)) continue;
    try {
      const uri = deskFileUri(files, desk, block.src);
      const bytes = await files.readUri(uri);
      // When size cannot be determined (external docx with GIFs or BMPs, D-509), determine aspect ratio based on its size in the document, writing the image as usual.
      const size = await files
        .imageSize(uri)
        .catch(() => ({ width: block.box.width, height: block.box.height }));
      out.set(block.src, { bytes, ...size });
    } catch {
      // Unreadable images are not written to the file.
    }
  }
  return out;
}

const docxImages = (files: Files, desk: Desk, doc: DocDoc) =>
  embeddedImages(
    files,
    desk,
    doc.pages.flatMap((page) => leafBlocks(page).filter((b) => b.kind === 'image')),
  );

const xlsxImages = (files: Files, desk: Desk, doc: TableDoc) =>
  embeddedImages(
    files,
    desk,
    doc.pages.flatMap((page) => page.blocks.filter((b) => b.kind === 'image')),
  );

/**
 * Close an editing session (file-room §11.2, D-366): write the modified intermediate format as
 * this version's JSON, generate an xlsx / docx from it, replace the desk file with a new one (new
 * ID), treating the entire edit session as a single version (reverted together on undo).
 * Unchanged if no intermediate format exists. Returns the new workspace and the new file ID.
 */
export async function commitEdit(
  files: Files,
  desk: Desk,
  fileId: string,
  edited: DeskSourceDoc,
  now: number,
): Promise<{ desk: Desk; fileId: string; doc?: TableDoc | DocDoc }> {
  const list = currentFiles(desk);
  const file = list.find((f) => f.id === fileId);
  if (!file?.source) return { desk, fileId };
  const n = desk.nextN;
  // Newly cropped images during editing ("Use original image", D-467) not yet in the workspace: move into assets/ and record in this file.
  const known = new Set(file.source.assets.map((a) => a.path));
  const added: DeskBlob[] = [];
  const relative = relativeSource(files, desk, edited);
  const outside = [...sourcePaths(relative)].filter(
    (p) => !known.has(p) && files.desk.pathOf(p) === null && /^(file:|content:|runs\/)/.test(p),
  );
  const moved = new Map<string, string>();
  for (const [k, uri] of outside.entries()) {
    const blob = await adopt(
      files,
      desk,
      uri,
      `assets/e${n}-${k}.${cleanExt(extOf(uri)) || 'jpg'}`,
    );
    moved.set(uri, blob.path);
    added.push(blob);
  }
  const source = moved.size ? mapSourcePaths(relative, (p) => moved.get(p) ?? p) : relative;
  const path = `v${n}-0.${file.ext}`;
  const json = `v${n}-0.json`;
  const bytes =
    source.kind === 'table'
      ? writeXlsx(source.doc, await xlsxImages(files, desk, source.doc))
      : writeDocx(source.doc, await docxImages(files, desk, source.doc));
  const size = await files.desk.writeBytes(inDesk(desk, path), bytes);
  const jsonSize = await files.desk.writeText(inDesk(desk, json), JSON.stringify(source.doc));
  const used = sourcePaths(source);
  const missing = source.kind === 'table' ? pagesWithoutTables(source.doc) : [];
  const next: DeskFile = {
    ...file,
    id: `f${n}-0`,
    path,
    size,
    source: {
      kind: source.kind,
      path: json,
      size: jsonSize,
      assets: [...file.source.assets, ...added].filter((a) => used.has(a.path)),
      ...(missing.length ? { pagesWithoutTables: missing } : {}),
      // External file has been modified: this version is regenerated (D-509).
      ...(file.source.imported ? { imported: 'rebuilt' as const } : {}),
    },
  };
  const change = commitVersion(
    desk,
    list.map((f) => (f.id === fileId ? next : f)),
    { kind: 'edit' },
    now,
  );
  const sealed = sealEdit(change.desk);
  await saveDesk(files, sealed);
  await files.desk.remove(change.drop.map((p) => inDesk(desk, p)));
  await removeManifest(files.desk, inDesk(desk, DRAFT_NAME));
  // Newly cropped images moved (D-467): update documents continuing to be used in the editor with
  // workspace addresses (2026-11-06: newly changed images turn into gray blocks after "Finish", and
  // subsequent modifications/saves point to missing temporary files).
  const doc = moved.size
    ? mapSourcePaths(source, (p) => (/^(file:|content:)/.test(p) ? p : deskFileUri(files, desk, p)))
        .doc
    : undefined;
  return { desk: sealed, fileId: next.id, ...(doc ? { doc } : {}) };
}

/** Write unclosed edits into the workspace (for crash prevention): if the app is closed, merge them into a version the next time the room is opened. */
export async function writeEditDraft(
  files: Files,
  desk: Desk,
  fileId: string,
  edited: DeskSourceDoc,
): Promise<void> {
  const source = relativeSource(files, desk, edited);
  await writeManifest(
    files.desk,
    inDesk(desk, DRAFT_NAME),
    JSON.stringify({ fileId, ...source }),
    isJson,
  );
}

export const dropEditDraft = (files: Files, desk: Desk) =>
  removeManifest(files.desk, inDesk(desk, DRAFT_NAME));

/** When opening a room: merge last unclosed edits into a version (revertible via undo). Discard if unreadable or file is no longer on the desk. */
export async function recoverEditDraft(files: Files, desk: Desk, now: number): Promise<Desk> {
  const text = await readManifest(files.desk, inDesk(desk, DRAFT_NAME), isJson);
  if (text === null) return desk;
  type Draft = { fileId?: string; kind?: string; doc?: unknown } | null;
  let draft: Draft;
  try {
    draft = JSON.parse(text) as Draft;
  } catch {
    draft = null;
  }
  const raw = JSON.stringify(draft?.doc ?? null);
  const source: DeskSourceDoc | null =
    draft?.kind === 'table'
      ? ((doc) => (doc ? { kind: 'table' as const, doc } : null))(parseTableDoc(raw))
      : draft?.kind === 'doc'
        ? ((doc) => (doc ? { kind: 'doc' as const, doc } : null))(parseDocDoc(raw))
        : null;
  const file = currentFiles(desk).find((f) => f.id === draft?.fileId);
  if (!source || !file || file.source?.kind !== source.kind) {
    await dropEditDraft(files, desk);
    return desk;
  }
  return (await commitEdit(files, desk, file.id, source, now)).desk;
}
