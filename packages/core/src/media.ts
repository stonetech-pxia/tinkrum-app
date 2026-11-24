// Video and audio (D-140–D-143): Determining whether a file is video/audio, and calculating bitrate
// and resolution when compressing to a specified size/quality. Actual encoding is handled by the
// app's native morph-media module; only pure calculations reside here, allowing tests in Node.

export type MediaKind = 'image' | 'pdf' | 'video' | 'audio' | 'zip' | 'other';

/** Video/audio extension -> MIME type (selectors and shares do not always provide MIME types). */
export const MEDIA_MIME_BY_EXT: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  caf: 'audio/x-caf',
  amr: 'audio/amr',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
};

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif']);

/** Office document extension -> MIME type (D-186: Word, Excel, PowerPoint to PDF). */
export const OFFICE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // System file picker recognizes text/rtf (application/rtf cannot be selected), while shares from other apps may provide either.
  rtf: 'text/rtf',
};
export const OFFICE_MIME_TYPES = [
  ...new Set([...Object.values(OFFICE_MIME_BY_EXT), 'application/rtf']),
];

/** Whether it is an office document: check MIME type if recognized, otherwise check extension. */
export function isOfficeFile(mimeType: string | null | undefined, name: string): boolean {
  const mime = (mimeType ?? '').toLowerCase();
  if (OFFICE_MIME_TYPES.includes(mime)) return true;
  const ext = name.includes('.') ? extOf(name) : name.toLowerCase();
  return ext in OFFICE_MIME_BY_EXT;
}

const extOf = (name: string) => /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';

/**
 * Determine file category: check MIME type first; if unreliable (empty or
 * application/octet-stream), fall back to extension. nameOrExt can be a file name or just an
 * extension.
 */
export function mediaKindOf(mimeType: string | null | undefined, nameOrExt = ''): MediaKind {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/zip' || mime === 'application/x-zip-compressed') return 'zip';
  const ext = nameOrExt.includes('.') ? extOf(nameOrExt) : nameOrExt.toLowerCase();
  const byExt = MEDIA_MIME_BY_EXT[ext];
  if (byExt) return byExt.startsWith('video/') ? 'video' : 'audio';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'zip') return 'zip';
  return 'other';
}

export const isVideoFile = (mimeType: string | null | undefined, nameOrExt = '') =>
  mediaKindOf(mimeType, nameOrExt) === 'video';
export const isAudioFile = (mimeType: string | null | undefined, nameOrExt = '') =>
  mediaKindOf(mimeType, nameOrExt) === 'audio';

// ---- Animated GIFs (video.toGif, image.toGif, D-184) ----

/** Maximum duration for video-to-GIF conversion in seconds: each frame in a GIF is a full image, so longer durations result in tens of megabytes. */
export const GIF_MAX_SECONDS = 30;
/** Maximum number of images for creating an animated GIF from multiple pictures. */
export const GIF_MAX_FRAMES = 50;

// ---- Video compression (video.compress) ----

export const VIDEO_QUALITIES = ['1080p', '720p', '480p'] as const;
export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

/** Quality tiers: short-side pixels and video bitrate (kbps, H.264, up to 30 fps). */
const QUALITY_TIERS: Record<VideoQuality, { shortSide: number; videoKbps: number }> = {
  '1080p': { shortSide: 1080, videoKbps: 5000 },
  '720p': { shortSide: 720, videoKbps: 2500 },
  '480p': { shortSide: 480, videoKbps: 1000 },
};

/** Select short side based on bitrate: resolution must also drop when bitrate is too low, otherwise the image becomes heavily pixelated. */
const SIZE_LADDER: readonly { minKbps: number; shortSide: number }[] = [
  { minKbps: 4000, shortSide: 1080 },
  { minKbps: 1800, shortSide: 720 },
  { minKbps: 800, shortSide: 540 },
  { minKbps: 0, shortSide: 360 },
];

/** Video bitrates below this threshold become unclear: if the target size calculates to an even lower bitrate, throw an error immediately without wasting time compressing. */
export const MIN_VIDEO_KBPS = 150;

/** Margin reserved when compressing to a target size: accounts for container overhead and hardware encoder bitrate errors. */
export const SIZE_MARGIN = 0.92;

export interface VideoSource {
  durationMs: number;
  size: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  /** Original video's video bitrate (when readable): never scales bitrate upward. */
  videoKbps?: number;
}

export interface VideoPlan {
  videoKbps: number;
  /** 0 = no audio. */
  audioKbps: number;
  /** Output short-side pixels; does not upscale original video. */
  shortSide: number;
  maxFps: number;
}

export type VideoCompressPlan =
  | { kind: 'encode'; plan: VideoPlan }
  /** Original file is already within target size: pass through to the next step as-is. */
  | { kind: 'keep' }
  /** Target too small: minMB specifies the minimum required size. */
  | { kind: 'tooSmall'; minMB: number };

const MB = 1024 * 1024;

const shortSideOf = (s: VideoSource) =>
  s.width && s.height ? Math.min(s.width, s.height) : Number.POSITIVE_INFINITY;

function audioKbpsFor(totalKbps: number): number {
  if (totalKbps >= 1000) return 128;
  if (totalKbps >= 300) return 64;
  return 32;
}

/** Compress according to quality tier: no upscaling, and never increases bitrate above the original. */
export function planVideoQuality(source: VideoSource, quality: VideoQuality): VideoPlan {
  const tier = QUALITY_TIERS[quality];
  const shortSide = Math.min(tier.shortSide, shortSideOf(source));
  // Scale down bitrate proportionally if the original video is smaller than this tier.
  const pixelRatio = Number.isFinite(shortSide) ? (shortSide / tier.shortSide) ** 2 : 1;
  let videoKbps = Math.round(tier.videoKbps * Math.min(1, pixelRatio));
  if (source.videoKbps) videoKbps = Math.min(videoKbps, source.videoKbps);
  return {
    videoKbps: Math.max(MIN_VIDEO_KBPS, videoKbps),
    audioKbps: source.hasAudio ? 128 : 0,
    shortSide: Number.isFinite(shortSide) ? shortSide : tier.shortSide,
    maxFps: 30,
  };
}

/**
 * Compress to not exceed targetBytes: total bitrate = target size × 8 × margin ÷ duration;
 * subtracting audio bitrate yields video bitrate, and resolution is then selected based on video
 * bitrate. factor is used to re-compress if still overtime after compression (reducing bitrate by
 * the excess proportion).
 */
export function planVideoSize(
  source: VideoSource,
  targetBytes: number,
  factor = 1,
): VideoCompressPlan {
  if (source.size <= targetBytes && factor === 1) return { kind: 'keep' };
  const seconds = Math.max(source.durationMs, 1) / 1000;
  const totalKbps = ((targetBytes * 8 * SIZE_MARGIN) / seconds / 1000) * factor;
  const audioKbps = source.hasAudio ? audioKbpsFor(totalKbps) : 0;
  const videoKbps = Math.floor(totalKbps - audioKbps);
  if (videoKbps < MIN_VIDEO_KBPS) {
    const minAudio = source.hasAudio ? 32 : 0;
    const bytes = ((MIN_VIDEO_KBPS + minAudio) * 1000 * seconds) / 8 / SIZE_MARGIN;
    return { kind: 'tooSmall', minMB: Math.ceil((bytes / MB) * 10) / 10 };
  }
  const ladder = SIZE_LADDER.find((s) => videoKbps >= s.minKbps)!;
  const capped = source.videoKbps ? Math.min(videoKbps, source.videoKbps) : videoKbps;
  return {
    kind: 'encode',
    plan: {
      videoKbps: capped,
      audioKbps,
      shortSide: Math.min(ladder.shortSide, shortSideOf(source)),
      maxFps: 30,
    },
  };
}

/** Format conversion (video.convert): preserve original quality as much as possible, retaining up to 4K and 60 fps for sources above 30 fps. */
export function planVideoConvert(source: VideoSource): VideoPlan {
  const shortSide = Math.min(2160, shortSideOf(source));
  const side = Number.isFinite(shortSide) ? shortSide : 1080;
  // H.264 requires roughly 6 Mbps per megapixels (at 30 fps) to maintain original quality.
  // Originals are usually more efficient HEVC, so the upper limit is set to 1.5 times the original
  // bitrate to prevent excessive bloat during conversion.
  const pixels = (side * side * 16) / 9;
  let videoKbps = Math.round((pixels / 1_000_000) * 6000);
  if (source.videoKbps) {
    videoKbps = Math.min(videoKbps, Math.max(Math.round(source.videoKbps * 1.5), 1000));
  }
  return { videoKbps, audioKbps: source.hasAudio ? 192 : 0, shortSide: side, maxFps: 60 };
}
