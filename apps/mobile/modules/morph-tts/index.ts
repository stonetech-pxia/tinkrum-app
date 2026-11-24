import { requireOptionalNativeModule, type EventSubscription } from 'expo';

// Local Expo module MorphTTS (D-270): reads text into an audio file on-device using built-in system
// voices without uploading. On iOS, it uses ios/MorphTTSModule.swift (AVSpeechSynthesizer.write),
// and on Android, android/…/MorphTTSModule.kt (TextToSpeech.synthesizeToFile, one WAV per segment,
// then concatenated). Produces only files, no playback. In Expo Go and tests, it returns null, and
// callers report "use in the official Morph app". Text is passed exclusively to the system speech
// engine and is never logged.

/**
 * Voice status on this device: installed (ready to use); notDownloaded (the system recognizes the
 * language, but voice data has not been downloaded yet—on Android, this requires downloading via
 * system text-to-speech settings); unsupported (no voice available for this language); noEngine
 * (no speech engine available on Android).
 */
export type VoiceStatus = 'installed' | 'notDownloaded' | 'unsupported' | 'noEngine';

export interface SynthesizeOptions {
  /** Used for progress events and cancellation. */
  taskId: string;
  /** Voice region code (BCP 47: zh-CN, en-US). */
  voice: string;
  /** 1 is normal speed, ranging from 0.5 to 2. */
  rate: number;
  /** Output WAV (file:// URI) in the current run's temp directory; existing files will be overwritten. */
  output: string;
}

export interface SynthesizeResult {
  uri: string;
  size: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
}

export interface TTSProgressEvent {
  taskId: string;
  /** 0–1 (based on completed segments). */
  fraction: number;
}

export interface MorphTTSModule {
  voiceStatus(voice: string): Promise<VoiceStatus>;
  /**
   * Reads text segments sequentially into a single 16-bit PCM WAV file. Intermediate files (one
   * WAV per segment on Android) are cleaned up regardless of success or failure; the output file
   * is also deleted on failure or cancellation. Error codes: ERR_TTS_NO_VOICE,
   * ERR_TTS_NOT_DOWNLOADED, ERR_TTS_UNAVAILABLE (no speech engine), ERR_TTS_CANCELLED,
   * ERR_TTS_FAILED.
   */
  synthesize(segments: readonly string[], options: SynthesizeOptions): Promise<SynthesizeResult>;
  /** Cancels an ongoing speech synthesis: synthesize completes with ERR_TTS_CANCELLED. */
  cancel(taskId: string): void;
  addListener(event: 'onProgress', listener: (e: TTSProgressEvent) => void): EventSubscription;
}

export default requireOptionalNativeModule<MorphTTSModule>('MorphTTS');
