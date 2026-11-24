// Output formats. Only output JPEG / PNG / WebP, never HEIC (unsupported on many platforms).

export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

const MIME: Record<OutputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const EXT: Record<OutputFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };

/** Remove parameters and lowercase, e.g., "Image/JPEG; q=1" -> "image/jpeg". */
function normalize(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

/** Output format corresponding to MIME; returns null when not an outputable format (such as HEIC, GIF). */
export function formatOfMime(mime: string): OutputFormat | null {
  switch (normalize(mime)) {
    case 'image/jpeg':
    case 'image/jpg':
    case 'image/pjpeg':
      return 'jpeg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return null;
  }
}

export function extOfFormat(format: OutputFormat): string {
  return EXT[format];
}

export function mimeOfFormat(format: OutputFormat): string {
  return MIME[format];
}

/** Any image type (including input-only formats like HEIC, GIF, etc.). */
export function isImageMime(mime: string): boolean {
  return /^image\/[a-z0-9.+-]+$/.test(normalize(mime));
}
