// Audio (D-152, D-153): Bitrate, channels, and sample rate when "compressing to specified size /
// audio quality" or "converting format". Actual encoding happens in the app's native module
// `morph-media` (iOS AVFoundation, Android Media3); only pure computation is done here. Outputs M4A
// (AAC) by default, which plays on WeChat, email, PC, and all phones; can also output WAV
// (uncompressed) and MP3 (LAME, D-183).

export const AUDIO_QUALITIES = ['high', 'standard', 'voice'] as const;
export type AudioQuality = (typeof AUDIO_QUALITIES)[number];

export const AUDIO_FORMATS = ['m4a', 'wav', 'mp3'] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

/** Encoding requirements (passed to the native module). WAV uses only channels / sampleRate. */
export interface AudioPlan {
  format: AudioFormat;
  bitrateKbps: number;
  channels: 1 | 2;
  sampleRate: number;
}

/** Audio quality tiers: high (music), standard, voice (recordings, lectures, mono). */
export const AUDIO_QUALITY_PLANS: Record<AudioQuality, Omit<AudioPlan, 'format'>> = {
  high: { bitrateKbps: 192, channels: 2, sampleRate: 44100 },
  standard: { bitrateKbps: 128, channels: 2, sampleRate: 44100 },
  voice: { bitrateKbps: 48, channels: 1, sampleRate: 22050 },
};

/** AAC becomes unintelligible at lower bitrates: throws an error directly when the calculated target size is lower, telling the user the minimum required size. */
export const MIN_AUDIO_KBPS = 24;
/** Maximum bitrate used when compressing to a specified size (higher yields no audible difference). */
export const MAX_AUDIO_KBPS = 192;
/** Container overhead and encoder bitrate error margin. */
export const AUDIO_SIZE_MARGIN = 0.94;

export interface AudioSource {
  durationMs: number;
  size: number;
  channels?: number;
  sampleRate?: number;
  /** Original bitrate (falls back to calculating from size and duration if unreadable). */
  kbps?: number;
}

export type AudioSizePlan =
  { kind: 'keep' } | { kind: 'encode'; plan: AudioPlan } | { kind: 'tooSmall'; minMB: number };

const MB = 1024 * 1024;

/** Original bitrate (kbps): calculated from size and duration if unreadable, returns 0 if neither is available. */
export const audioSourceKbps = (s: AudioSource) =>
  s.kbps && s.kbps > 0
    ? s.kbps
    : s.durationMs > 0
      ? (s.size * 8) / (s.durationMs / 1000) / 1000
      : 0;

/** Bitrate → channels and sample rate: stereo requires > 96 kbps; falls back to mono and 22.05 kHz when too low (AAC encoder requirement). */
function shapeFor(kbps: number, sourceChannels: number): Omit<AudioPlan, 'format'> {
  const stereo = kbps >= 96 && sourceChannels !== 1;
  return {
    bitrateKbps: Math.round(kbps),
    channels: stereo ? 2 : 1,
    sampleRate: kbps >= 48 ? 44100 : 22050,
  };
}

/**
 * Compress to at most `targetBytes`: keeps original if already within limit; calculates bitrate
 * based on duration with a 192 kbps cap; throws an error if below 24 kbps (with "at least X MB").
 */
export function planAudioSize(source: AudioSource, targetBytes: number, factor = 1): AudioSizePlan {
  if (factor === 1 && source.size > 0 && source.size <= targetBytes) return { kind: 'keep' };
  const seconds = Math.max(source.durationMs / 1000, 0.1);
  const kbps = Math.min(
    MAX_AUDIO_KBPS,
    ((targetBytes * 8 * AUDIO_SIZE_MARGIN) / seconds / 1000) * factor,
  );
  if (kbps < MIN_AUDIO_KBPS) {
    const minBytes = (MIN_AUDIO_KBPS * 1000 * seconds) / 8 / AUDIO_SIZE_MARGIN;
    return { kind: 'tooSmall', minMB: Math.ceil((minBytes / MB) * 10) / 10 };
  }
  return { kind: 'encode', plan: { format: 'm4a', ...shapeFor(kbps, source.channels ?? 2) } };
}

/** By audio quality: does not exceed original bitrate (compressing a smaller file won't make it larger); mono original files are not upmixed to stereo. */
export function planAudioQuality(source: AudioSource, quality: AudioQuality): AudioPlan {
  const tier = AUDIO_QUALITY_PLANS[quality];
  const original = audioSourceKbps(source);
  const kbps =
    original > 0
      ? Math.max(MIN_AUDIO_KBPS, Math.min(tier.bitrateKbps, original))
      : tier.bitrateKbps;
  const shape = shapeFor(kbps, source.channels ?? 2);
  return {
    format: 'm4a',
    bitrateKbps: shape.bitrateKbps,
    channels: tier.channels === 1 ? 1 : shape.channels,
    sampleRate: Math.min(tier.sampleRate, shape.sampleRate),
  };
}

/**
 * Convert format (also used for trimming, mixing, and extracting audio from video): M4A bitrate
 * follows the original (48–192 kbps); WAV is uncompressed 16-bit PCM, preserving the original
 * channels (up to 2) and sample rate.
 */
export function planAudioConvert(source: AudioSource, format: AudioFormat): AudioPlan {
  const channels: 1 | 2 = source.channels === 1 ? 1 : 2;
  if (format === 'mp3') return planMp3(source);
  if (format === 'wav') {
    const sampleRate = source.sampleRate ? Math.min(48000, source.sampleRate) : 44100;
    return { format, bitrateKbps: 0, channels, sampleRate };
  }
  // Bitrate follows the original (slightly increased upon re-encoding to avoid quality degradation), does not inflate low-bitrate recordings: 48–192 kbps.
  const original = audioSourceKbps(source);
  const kbps = Math.round(
    original > 0 ? Math.min(MAX_AUDIO_KBPS, Math.max(48, original * 1.2)) : 160,
  );
  return { format, bitrateKbps: kbps, channels: kbps >= 64 ? channels : 1, sampleRate: 44100 };
}

/** Standard MP3 bitrates (kbps): LAME encodes only using these tiers. */
export const MP3_BITRATES = [128, 160, 192, 224, 256, 320] as const;

/**
 * MP3: requires slightly higher bitrate than AAC for equivalent quality, takes the nearest
 * standard tier at 1.5x the original (128–320 kbps); defaults to 192 if original bitrate is
 * unreadable. Sample rate standardized to 44.1 kHz (recognized by all players); mono recordings
 * remain mono.
 */
function planMp3(source: AudioSource): AudioPlan {
  const original = audioSourceKbps(source);
  const wanted = original > 0 ? original * 1.5 : 192;
  const kbps = MP3_BITRATES.find((b) => b >= wanted) ?? 320;
  return {
    format: 'mp3',
    bitrateKbps: kbps,
    channels: source.channels === 1 ? 1 : 2,
    sampleRate: 44100,
  };
}

/** Estimated size (bytes): used for checking remaining space. */
export function estimateAudioBytes(plan: AudioPlan, durationMs: number): number {
  const seconds = durationMs / 1000;
  if (plan.format === 'wav') return plan.sampleRate * plan.channels * 2 * seconds + 44;
  return (plan.bitrateKbps * 1000 * seconds) / 8;
}
