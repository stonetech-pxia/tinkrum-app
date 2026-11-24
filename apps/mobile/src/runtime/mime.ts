import { MEDIA_MIME_BY_EXT, OFFICE_MIME_BY_EXT } from '@morph/core';

// Conversion between filenames, extensions, and MIME types (pure function). In a separate file: storage needs it too and should not depend on action common utilities for this (R11).

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  zip: 'application/zip',
  txt: 'text/plain',
  ...MEDIA_MIME_BY_EXT,
  ...OFFICE_MIME_BY_EXT,
};

export const extOf = (name: string) => /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
export const baseName = (name: string) => name.replace(/\.[^./]+$/, '');
export const mimeOfExt = (ext: string) => MIME_BY_EXT[ext] ?? 'application/octet-stream';
/** Extension corresponding to MIME type (used when filename lacks an extension); empty if unrecognized. */
export const extOfMime = (mime: string | null | undefined) =>
  Object.keys(MIME_BY_EXT).find((ext) => MIME_BY_EXT[ext] === mime?.toLowerCase()) ?? '';

export function mimeOf(name: string, given: string | null): string {
  if (given && given !== 'application/octet-stream') return given;
  return mimeOfExt(extOf(name));
}

export const isImageMime = (mime: string) => mime.startsWith('image/');
