/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, degrees } from 'pdf-lib';

// For testing only: generate a real PDF / PNG, read a JPEG sample, and decode the page content stream.

/** One [width, height] per page (or width only, height defaults to 800), with an optional rotation angle. */
export async function makePdf(
  pages: (number | { size: [number, number]; rotate?: number })[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const spec of pages) {
    if (typeof spec === 'number') {
      doc.addPage([spec, 800]);
    } else {
      const page = doc.addPage(spec.size);
      if (spec.rotate) page.setRotation(degrees(spec.rotate));
    }
  }
  return doc.save();
}

/** A PDF with /Encrypt in the trailer, which pdf-lib rejects by default. */
export async function makeEncryptedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: 'Standard', V: 1, R: 2 });
  return doc.save();
}

export const brokenBytes = Uint8Array.from('this is not a pdf', (c) => c.charCodeAt(0));

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

/** Real RGB PNG (color gradient). */
export function makePng(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth
  ihdr[9] = 2; // RGB
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * row + 1 + x * 3;
      raw[o] = (x * 255) / width;
      raw[o + 1] = (y * 255) / height;
      raw[o + 2] = 128;
    }
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(raw)),
      pngChunk('IEND', new Uint8Array(0)),
    ]),
  );
}

/** Noisy RGB (or RGBA) PNG: hard to compress, large enough when embedded in PDF, for PDF compression tests. */
export function makeNoisyPng(width: number, height: number, alpha = false): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  const comps = alpha ? 4 : 3;
  const row = width * comps + 1;
  const raw = Buffer.alloc(row * height);
  let seed = 7;
  for (let i = 0; i < raw.length; i++) {
    if (i % row === 0) continue;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = (seed >>> 16) & 0xff;
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(raw)),
      pngChunk('IEND', new Uint8Array(0)),
    ]),
  );
}

/** 400×300 noisy JPEG (approx. 90 KB, converted using macOS sips). */
export function readNoisyJpeg(): Uint8Array {
  return new Uint8Array(readFileSync(new URL('./__fixtures__/noise-400x300.jpg', import.meta.url)));
}

/** 60×40 real JPEG (converted from gradient PNG using macOS sips). */
export function readJpeg(): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL('./__fixtures__/gradient-60x40.jpg', import.meta.url)),
  );
}

/** Page content stream (decompressed and concatenated into a latin1 string), used to check drawing instructions. */
export async function pageContent(bytes: Uint8Array, index: number): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(index).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  return streams
    .map((ref) => {
      const stream = ref && doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) return '';
      const filtered = stream.dict.get(PDFName.of('Filter')) !== undefined;
      return Buffer.from(filtered ? inflateSync(stream.contents) : stream.contents).toString(
        'latin1',
      );
    })
    .join('\n');
}

/** All text matrices Tm (a b c d e f) in the content stream and the hex text following them. */
export function textDraws(content: string): { m: number[]; text: string }[] {
  const re = /(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) Tm\s*<([0-9A-Fa-f]*)> Tj/g;
  return [...content.matchAll(re)].map((match) => ({
    m: match.slice(1, 7).map(Number),
    text: Buffer.from(match[7] ?? '', 'hex').toString('latin1'),
  }));
}

/** Translation, rotation, and scaling of drawImage in the content stream (fixed order of instructions in pdf-lib: translate, rotate, scale, skew). */
export function imageDraws(
  content: string,
): { x: number; y: number; rot: number[]; w: number; h: number }[] {
  const n = '(-?[\\d.e-]+)';
  const re = new RegExp(
    `1 0 0 1 ${n} ${n} cm\\s+${n} ${n} ${n} ${n} 0 0 cm\\s+${n} 0 0 ${n} 0 0 cm\\s+[^\\n]* cm\\s+/\\S+ Do`,
    'g',
  );
  return [...content.matchAll(re)].map((m) => {
    const v = m.slice(1).map(Number);
    return { x: v[0] ?? 0, y: v[1] ?? 0, rot: v.slice(2, 6), w: v[6] ?? 0, h: v[7] ?? 0 };
  });
}

/** Fonts used on a page: subtype, encoding, presence of ToUnicode, and whether a font file is embedded. */
export async function pageFonts(
  bytes: Uint8Array,
  index: number,
): Promise<{ subtype: string; encoding: string; toUnicode: boolean; embedded: boolean }[]> {
  const doc = await PDFDocument.load(bytes);
  const resources = doc.getPage(index).node.Resources();
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fonts) return [];
  return fonts.values().map((ref) => {
    const font = doc.context.lookup(ref, PDFDict);
    const name = (key: string, dict = font) =>
      dict.lookupMaybe(PDFName.of(key), PDFName)?.decodeText() ?? '';
    const descendants = font.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
    const cid = descendants ? doc.context.lookup(descendants.get(0), PDFDict) : undefined;
    const descriptor = (cid ?? font).lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    return {
      subtype: name('Subtype'),
      encoding: name('Encoding'),
      toUnicode: font.has(PDFName.of('ToUnicode')),
      embedded: !!descriptor?.has(PDFName.of('FontFile2')),
    };
  });
}
