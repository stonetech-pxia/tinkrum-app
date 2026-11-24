import { requireOptionalNativeModule, type EventSubscription } from 'expo';

// Local Expo module MorphSpeech (D-150, D-151): converts audio recordings to text on-device without
// uploading. iOS uses ios/MorphSpeechModule.swift: starting from iOS 26, uses system SpeechAnalyzer
// (SpeechTranscriber), falling back to SFSpeechRecognizer on older systems (local recognition
// only). The Android system cannot recognize audio files, so whisper.cpp (MIT) is compiled into
// android/...; models are downloaded on first use (speech-whisper-* in core/packs.ts). Returns null
// in Expo Go and tests, callers report 'must be used in the official Morph release'. Recognized
// text is returned only to the app and is not logged.

export type SpeechEngine = 'system' | 'whisper';

/**
 * Whether a language can be recognized on this device (only meaningful when engine is system;
 * whisper models are managed via downloads and are always installed): installed can be recognized
 * directly; needsDownload means the system must first download the recognition model for this
 * language (provided by Apple, via prepareLanguage); unsupported means this device does not
 * support it.
 */
export type LanguageStatus = 'installed' | 'needsDownload' | 'unsupported';

export interface TranscribeOptions {
  /** Used for progress events and cancellation. */
  taskId: string;
  /** system: BCP 47 (zh-CN, en-US); whisper: whisper language code (zh, en). */
  language: string;
  /** whisper model file (file:// URI or absolute path), required only for whisper. */
  model?: string;
  /** whisper voice activity detection model (to skip parts where no one is speaking), used only by whisper. */
  vad?: string;
  /** whisper prompt: use Simplified Chinese sentences for Chinese, otherwise it often outputs Traditional Chinese. */
  prompt?: string;
  /** For testing only: also use SFSpeechRecognizer on iOS 26+ to check the old system path on new systems. */
  legacy?: boolean;
  /** Requests word/segment timestamps for subtitles (older iOS versions grouped by word). */
  timed?: boolean;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface NativeTranscript {
  segments: TranscriptSegment[];
  durationMs: number;
}

export interface SpeechProgressEvent {
  taskId: string;
  /** 0–1。 */
  fraction: number;
}

export interface MorphSpeechModule {
  readonly engine: SpeechEngine;
  /** Recognizable languages (system: BCP 47, underscores replaced with hyphens; whisper: language code). */
  supportedLanguages(): Promise<string[]>;
  languageStatus(language: string): Promise<LanguageStatus>;
  /**
   * System downloads the recognition model for this language (starting from iOS 26, provided by
   * Apple, shared across all apps); returns immediately if already present. Can only be called
   * after user confirmation. Sends onProgress updates via taskId.
   */
  prepareLanguage(language: string, taskId: string): Promise<void>;
  /**
   * Transcribe an audio file (m4a, wav, mp3, aac, caf...; any format decodable by the system on
   * Android). Error codes: ERR_SPEECH_UNSUPPORTED_LANGUAGE, ERR_SPEECH_NEEDS_DOWNLOAD,
   * ERR_SPEECH_NOT_AUTHORIZED, ERR_SPEECH_UNREADABLE_AUDIO (cannot open / no audio track),
   * ERR_SPEECH_MODEL (corrupted model file), ERR_SPEECH_CANCELLED, ERR_SPEECH_UNAVAILABLE (system
   * speech recognition unavailable on this device, e.g., iOS simulator).
   */
  transcribe(uri: string, options: TranscribeOptions): Promise<NativeTranscript>;
  /** Cancel a transcription: transcribe finishes with ERR_SPEECH_CANCELLED. */
  cancel(taskId: string): void;
  /** Computes file SHA-256 while reading (downloaded models are hundreds of MBs and cannot be read entirely into JS). */
  sha256File(uri: string): Promise<string>;
  addListener(event: 'onProgress', listener: (e: SpeechProgressEvent) => void): EventSubscription;
}

export default requireOptionalNativeModule<MorphSpeechModule>('MorphSpeech');
