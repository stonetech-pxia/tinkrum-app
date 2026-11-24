import { strFromU8, unzipSync, type UnzipFileInfo } from 'fflate';

import { children, parseXml, type XmlElement } from './xml';

// Opens external docx/xlsx packages (D-509): recognizes password-protected files (Office stores
// encrypted files in OLE compound files rather than zip), legacy formats (.doc/.xls with changed
// extensions), and corrupted files; only unzips needed parts, checking file sizes and compression
// bombs against directory declarations before unzipping (same as tool-archive). Fully local, no
// network requests (Invariant 1).

/** Causes for unreadable files: password-protected, not docx/xlsx, corrupted, too large (exceeding editor and preview capacity). */
export type OfficeImportError = 'encrypted' | 'notOffice' | 'damaged' | 'tooLarge';

export class OfficeImportFailure extends Error {
  constructor(readonly code: OfficeImportError) {
    super(`office import: ${code}`);
  }
}

/** Package limits: max bytes for an XML part, total unzipped size, total images (bytes), and compression ratio (checked only for parts > 1 MB). */
export const OFFICE_LIMITS = {
  maxPartBytes: 40 * 1024 * 1024,
  maxTotalBytes: 80 * 1024 * 1024,
  maxMediaBytes: 40 * 1024 * 1024,
  maxRatio: 200,
};
const RATIO_CHECK_MIN_BYTES = 1024 * 1024;

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** OLE compound file (encrypted Office files, legacy .doc/.xls). */
const isCfb = (bytes: Uint8Array) => CFB_MAGIC.every((b, i) => bytes[i] === b);

/** Check if the compound file directory contains the "EncryptedPackage" stream (named in UTF-16LE): if present, it is a password-protected Office file. */
function hasEncryptedPackage(bytes: Uint8Array): boolean {
  const name = 'EncryptedPackage';
  const first = name.charCodeAt(0);
  for (let i = 0; i + name.length * 2 <= bytes.length; i++) {
    if (bytes[i] !== first || bytes[i + 1] !== 0) continue;
    let ok = true;
    for (let k = 1; k < name.length && ok; k++) {
      ok = bytes[i + 2 * k] === name.charCodeAt(k) && bytes[i + 2 * k + 1] === 0;
    }
    if (ok) return true;
  }
  return false;
}

/** Part text: UTF-8 (with or without BOM), UTF-16 must have a BOM. */
export function decodeOfficeXml(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16(bytes, true);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16(bytes, false);
  return strFromU8(bytes);
}

function utf16(bytes: Uint8Array, little: boolean): string {
  let out = '';
  for (let i = 2; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(
      little ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!,
    );
  }
  return out;
}

export interface Relationship {
  id: string;
  type: string;
  /** Path within the package (does not start with /); original address for external links. */
  target: string;
  external: boolean;
}

/** Resolve the package path relative to the directory of the 'from' part. */
export function resolvePart(from: string, target: string): string {
  const parts = target.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const seg of target.replace(/^\/+/, '').split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export interface OoxmlPackage {
  names: string[];
  bytes(path: string): Uint8Array | undefined;
  /** Parsed XML; undefined if the part is missing, throws 'damaged' if corrupted. */
  xml(path: string): XmlElement | undefined;
  /** Relationships for a part (_rels/name.rels). */
  rels(path: string): Map<string, Relationship>;
  /** Main document of the package (officeDocument in _rels/.rels). */
  main(): string | undefined;
}

const caseless = (names: readonly string[]) => new Map(names.map((n) => [n.toLowerCase(), n]));

/**
 * Open package: 'wanted' determines which parts to extract (others only have their directory
 * inspected). Throws OfficeImportFailure if password-protected, legacy format, corrupted, or too
 * large.
 */
export function openPackage(
  data: Uint8Array,
  wanted: (name: string) => boolean,
  isMedia: (name: string) => boolean = () => false,
): OoxmlPackage {
  if (isCfb(data))
    throw new OfficeImportFailure(hasEncryptedPackage(data) ? 'encrypted' : 'notOffice');
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new OfficeImportFailure(data.length === 0 ? 'damaged' : 'notOffice');
  }
  let total = 0;
  let media = 0;
  const listed: string[] = [];
  const filter = (file: UnzipFileInfo): boolean => {
    listed.push(file.name);
    if (!wanted(file.name)) return false;
    const big = file.originalSize > RATIO_CHECK_MIN_BYTES;
    if (big && file.originalSize > file.size * OFFICE_LIMITS.maxRatio) {
      throw new OfficeImportFailure('tooLarge');
    }
    if (isMedia(file.name)) {
      media += file.originalSize;
      // If there are too many images, stop extracting subsequent ones (leaving those image slots empty), allowing the document to still be read.
      if (media > OFFICE_LIMITS.maxMediaBytes) return false;
    } else if (file.originalSize > OFFICE_LIMITS.maxPartBytes) {
      throw new OfficeImportFailure('tooLarge');
    }
    total += file.originalSize;
    if (total > OFFICE_LIMITS.maxTotalBytes) throw new OfficeImportFailure('tooLarge');
    return true;
  };
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, { filter });
  } catch (e) {
    if (e instanceof OfficeImportFailure) throw e;
    throw new OfficeImportFailure('damaged');
  }
  // Case-insensitive package file names (some tools write Word/Document.xml).
  const byLower = caseless(Object.keys(files));
  const find = (path: string) => byLower.get(path.replace(/^\/+/, '').toLowerCase());
  const parsed = new Map<string, XmlElement | undefined>();
  const pkg: OoxmlPackage = {
    names: listed,
    bytes: (path) => {
      const name = find(path);
      return name === undefined ? undefined : files[name];
    },
    xml(path) {
      const name = find(path);
      if (name === undefined) return undefined;
      if (!parsed.has(name)) {
        try {
          parsed.set(name, parseXml(decodeOfficeXml(files[name]!)));
        } catch {
          throw new OfficeImportFailure('damaged');
        }
      }
      return parsed.get(name);
    },
    rels(path) {
      const dir = path.split('/').slice(0, -1).join('/');
      const base = path.split('/').at(-1)!;
      const relPath = `${dir ? `${dir}/` : ''}_rels/${base}.rels`;
      const out = new Map<string, Relationship>();
      const root = pkg.xml(relPath);
      for (const rel of children(root)) {
        const id = rel.attrs.Id;
        const target = rel.attrs.Target;
        if (!id || target === undefined) continue;
        const external = rel.attrs.TargetMode === 'External';
        out.set(id, {
          id,
          type: rel.attrs.Type ?? '',
          target: external ? target : resolvePart(path, target),
          external,
        });
      }
      return out;
    },
    main() {
      for (const rel of pkg.rels('').values()) {
        if (/\/officeDocument$/.test(rel.type) && !rel.external) return rel.target;
      }
      return undefined;
    },
  };
  return pkg;
}

/** Relationship type name (last segment of the URL: image, styles, worksheet). */
export const relKind = (rel: Relationship) => rel.type.split('/').at(-1) ?? '';
