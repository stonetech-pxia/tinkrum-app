import { Directory, File, Paths } from 'expo-file-system';

import type { DeskFs } from './fs';

// Expo implementation of DeskFs: desk/ under app document directory (file-room DESIGN §3 suggested location, D-357).

const ROOT = 'desk';

const rootDir = () => new Directory(Paths.document, ROOT);

/** A file in the desk directory; directories are created on demand. */
function fileAt(path: string, create = false): File {
  const parts = path.split('/').filter((p) => p && p !== '.' && p !== '..');
  if (parts.length === 0) throw new Error('empty desk path');
  if (create) {
    const dir = new Directory(Paths.document, ROOT, ...parts.slice(0, -1));
    dir.create({ idempotent: true, intermediates: true });
  }
  return new File(Paths.document, ROOT, ...parts);
}

async function writeBytes(path: string, bytes: Uint8Array): Promise<number> {
  const dest = fileAt(path, true);
  if (!dest.exists) dest.create();
  // write is asynchronous (release-build-gotchas): must await its completion.
  await dest.write(bytes);
  return bytes.length;
}

const runsUri = () => new Directory(Paths.cache, 'runs').uri;

export const expoDeskFs: DeskFs = {
  uri: (path) => fileAt(path).uri,

  isRunFile: (uri) => uri.startsWith(runsUri()),

  pathOf(uri) {
    const root = rootDir().uri;
    const base = root.endsWith('/') ? root : `${root}/`;
    return uri.startsWith(base) ? decodeURIComponent(uri.slice(base.length)) : null;
  },

  async copyIn(uri, path) {
    const dest = fileAt(path, true);
    if (dest.exists) dest.delete();
    await new File(uri).copy(dest);
    return new File(dest.uri).size;
  },

  async moveIn(uri, path) {
    const source = new File(uri);
    // Read size before moving: File objects at the new path after move may still read as 0.
    const size = source.size;
    const dest = fileAt(path, true);
    if (dest.exists) dest.delete();
    source.move(dest);
    return size;
  },

  writeText: (path, text) => writeBytes(path, new TextEncoder().encode(text)),

  writeBytes,

  async readText(path) {
    const file = fileAt(path);
    if (!file.exists) return null;
    try {
      return await file.text();
    } catch {
      return null;
    }
  },

  async rename(from, to) {
    const source = fileAt(from);
    const dest = fileAt(to, true);
    if (dest.exists) dest.delete();
    // move is asynchronous on both platforms: wait for it to complete.
    await source.move(dest);
  },

  async remove(paths) {
    for (const path of paths) {
      try {
        const file = fileAt(path);
        if (file.exists) file.delete();
      } catch {
        // Leave unmovable files: delete along with the entire directory when clearing the desk.
      }
    }
  },

  async removeDesk(deskId) {
    if (!/^[a-z0-9]+$/.test(deskId)) return;
    const dir = new Directory(Paths.document, ROOT, deskId);
    if (dir.exists) dir.delete();
  },

  async list() {
    const root = rootDir();
    if (!root.exists) return [];
    return root
      .list()
      .filter((entry) => entry instanceof Directory)
      .map((entry) => entry.name);
  },
};
