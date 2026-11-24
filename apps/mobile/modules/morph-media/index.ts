import { requireOptionalNativeModule, type EventSubscription } from 'expo';

// Local Expo module MorphMedia (D-141): Processes video and audio locally using only system
// frameworks and official libraries. iOS is ios/MorphMediaModule.swift (AVFoundation), Android is
// android/.../MorphMediaModule.kt (Jetpack Media3 Transformer, Apache-2.0). Returns null in Expo Go
// and tests, and video operations report needsFullApp.
//
// Interfaces designed around "video + audio" (shared with audio tools): This batch implements
// probe, transcode (mp4 + H.264, audio AAC or dropped), trim, thumbnails, cancel, and progress
// events; m4a/wav, audio-only (video: 'drop'), PCM, concat, waveform are supplemented by audio
// tools, and unimplemented combinations throw ERR_NOT_IMPLEMENTED on the native side. URIs: file://
// (iOS, Android) or content:// (Android shared files). Output is always file://.

export type MediaKind = 'video' | 'audio';

export interface MediaInfo {
  kind: MediaKind;
  durationMs: number;
  size: number;
  hasVideo: boolean;
  hasAudio: boolean;
  // Video (width / height are dimensions after video orientation correction)
  width?: number;
  height?: number;
  rotation?: 0 | 90 | 180 | 270;
  fps?: number;
  hdr?: boolean;
  videoCodec?: string;
  videoBitrateKbps?: number;
  // Audio (video track or audio file)
  audioCodec?: string;
  audioBitrateKbps?: number;
  sampleRate?: number;
  channels?: number;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface VideoSettings {
  speed?: number;
  aspectRatio?: number;
  codec: 'h264';
  bitrateKbps?: number;
  /** Scale down to this short-side pixel count; provided only when smaller than the original video (the native side does not check, upscale prevention is guaranteed by the caller). */
  maxShortSide?: number;
  maxFps?: number;
  /** Unified output canvas during concatenation; dimensions must be positive even numbers. */
  width?: number;
  height?: number;
  /** Convert HDR to standard video (BT.709). H.264 output is always converted. */
  toSdr?: boolean;
}

export interface AudioSettings {
  /** mp3: LAME compiled into the app (D-183). */
  codec: 'aac' | 'pcm' | 'mp3';
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: 1 | 2;
}

export interface TranscodeOptions {
  container: 'mp4' | 'm4a' | 'wav' | 'mp3';
  /** 'drop': Audio only (audio format conversion, extracting audio from video). */
  video: VideoSettings | 'drop';
  /** 'drop': Remove audio. */
  audio: AudioSettings | 'drop';
  /** Only a specific segment (re-encoded, frame-accurate). */
  range?: TimeRange;
}

export interface MediaResult {
  /** The actual written file (file extension may differ from the request, e.g., changing to MOV when MP4 cannot hold the original audio during trimming). */
  uri: string;
  size: number;
  info: MediaInfo;
}

export interface GifResult {
  uri: string;
  size: number;
  width: number;
  height: number;
  frames: number;
}

/** Native-side error codes (error.code). */
export const MEDIA_ERRORS = {
  /** System cannot open (format not supported, copy-protected, or missing video/audio tracks). */
  unsupported: 'ERR_MEDIA_UNSUPPORTED',
  /** Cancelled via cancel(jobId). */
  cancelled: 'ERR_MEDIA_CANCELLED',
  /** Switched to another app during processing (iOS does not allow background video encoding). */
  interrupted: 'ERR_MEDIA_INTERRUPTED',
  /** Combinations not yet implemented in this batch. */
  notImplemented: 'ERR_NOT_IMPLEMENTED',
  /** Other encoding/file-writing failures. */
  failed: 'ERR_MEDIA_FAILED',
} as const;

export interface MorphMediaModule {
  probe(uri: string): Promise<MediaInfo>;
  /** Compression, format conversion, and audio extraction all go through this single method. jobId is used for cancellation and mapping progress events. */
  transcode(
    jobId: string,
    uri: string,
    output: string,
    options: TranscodeOptions,
  ): Promise<MediaResult>;
  speechAudio?(jobId: string, uri: string, output: string): Promise<MediaResult>;
  volume?(
    jobId: string,
    uri: string,
    output: string,
    options: { automatic: boolean; db: number; video: VideoSettings | 'drop' },
  ): Promise<MediaResult>;
  denoise?(
    jobId: string,
    uri: string,
    output: string,
    options: { video: VideoSettings | 'drop' },
  ): Promise<MediaResult>;
  rotate?(
    jobId: string,
    uri: string,
    output: string,
    degrees: number,
    options: TranscodeOptions,
  ): Promise<MediaResult>;
  /** Remove audio without re-encoding (iOS); falls back to transcode to strip the audio track when unavailable. */
  mute?(jobId: string, uri: string, output: string): Promise<MediaResult>;
  mixAudio?(
    jobId: string,
    uri: string,
    music: string,
    output: string,
    options: TranscodeOptions & {
      originalVolume: number;
      loop: boolean;
      videoDurationMs: number;
      musicDurationMs: number;
    },
  ): Promise<MediaResult>;
  /** Trim a segment without re-encoding (supports both video and audio). */
  trim(jobId: string, uri: string, output: string, range: TimeRange): Promise<MediaResult>;
  /** Save the single frame closest to the timestamp, original-size JPEG, oriented correctly. Older development builds lack this method. */
  frame?(uri: string, timeMs: number, directory: string): Promise<string>;
  /** Extract frames by time (oriented correctly, long side not exceeding maxSide), write as JPEGs into directory, and return file addresses. */
  thumbnails(
    uri: string,
    timesMs: readonly number[],
    maxSide: number,
    directory: string,
  ): Promise<string[]>;
  /** Animations (D-184): Extract frames from the entire video at given fps (width not exceeding width) and write as a GIF. */
  videoGif(
    jobId: string,
    uri: string,
    output: string,
    options: { width: number; fps: number },
  ): Promise<GifResult>;
  /** Animations (D-184): Write several images (long side scaled to maxSide, centered using the first image's dimensions) as a GIF, with each frame displayed for delayMs. */
  imagesGif(
    jobId: string,
    uris: readonly string[],
    output: string,
    options: { delayMs: number; maxSide: number },
  ): Promise<GifResult>;
  cancel(jobId: string): void;
  addListener(
    event: 'progress',
    listener: (event: { jobId: string; progress: number }) => void,
  ): EventSubscription;
  // ---- Audio tools to be implemented later (caller checks if method exists first) ----
  /** Concatenate several segments in order: input formats and sample rates can differ, uniformly re-encoded. */
  concat?(
    jobId: string,
    uris: readonly string[],
    output: string,
    options: TranscodeOptions,
  ): Promise<MediaResult>;
  /** Peak array from 0 to 1, used for drawing waveforms in the UI trim view. */
  waveform?(uri: string, buckets: number, range?: TimeRange): Promise<number[]>;
}

export default requireOptionalNativeModule<MorphMediaModule>('MorphMedia');
