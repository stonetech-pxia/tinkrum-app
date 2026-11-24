import {
  SPEECH_MODEL_FILE,
  SPEECH_MODEL_PACKS,
  SPEECH_VAD_FILE,
  SPEECH_VAD_PACK,
  SYSTEM_SPEECH_LOCALES,
  tidyTranscript,
  whisperLanguage,
  whisperPrompt,
  type SpeechLanguage,
  type SpeechSegment,
  type SpeechModel,
} from '@morph/core';

import type { MorphSpeechModule } from '../../modules/morph-speech';

// What is still missing before recognition. The speech-to-text app side (D-150, D-151): wraps the
// MorphSpeech native module into a platform-agnostic interface. iOS uses system recognition, where
// downloading the recognition model may be required by the system on first use of a language;
// Android uses whisper, with downloadable models. Text stays strictly on device (D-036).

/** What is still missing before recognition. */
export type SpeechNeed =
  | { kind: 'ready' }
  /** iOS: The system must first download the recognition model for this language (provided by Apple, shared across all apps; size is not reported by the system). */
  | { kind: 'systemDownload' }
  /** Android: The whisper model (along with the voice activity detection model) must be downloaded first. */
  | { kind: 'pack'; packId: string }
  | { kind: 'unsupported' };

export type SpeechErrorCode =
  | 'unsupportedLanguage'
  | 'needsDownload'
  | 'notAuthorized'
  | 'unreadableAudio'
  | 'model'
  | 'cancelled'
  /** System recognition is unavailable on this device (iOS simulator: model is 'installed' but no usable audio format is available). */
  | 'unavailable'
  | 'failed';

export class SpeechError extends Error {
  constructor(
    readonly code: SpeechErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const NATIVE_CODES: Record<string, SpeechErrorCode> = {
  ERR_SPEECH_UNSUPPORTED_LANGUAGE: 'unsupportedLanguage',
  ERR_SPEECH_NEEDS_DOWNLOAD: 'needsDownload',
  ERR_SPEECH_NOT_AUTHORIZED: 'notAuthorized',
  ERR_SPEECH_UNREADABLE_AUDIO: 'unreadableAudio',
  ERR_SPEECH_MODEL: 'model',
  ERR_SPEECH_CANCELLED: 'cancelled',
  ERR_SPEECH_UNAVAILABLE: 'unavailable',
};

export interface SpeechPacks {
  isInstalled(id: string): Promise<boolean>;
  /** Local path of a file within the downloaded content. */
  uri(id: string, file: string): string;
}

export interface TranscribeRequest {
  timed?: boolean;
  language: SpeechLanguage;
  /** Which model to use on Android; ignored on iOS. */
  model: SpeechModel;
  /** 0–1。 */
  onProgress?: (fraction: number) => void;
  /** User tapped 'Cancel' on the running page (checked every 0.3 seconds). */
  isCancelled?: () => boolean;
}

export interface SpeechTranscript {
  segments?: SpeechSegment[];
  text: string;
  durationMs: number;
}

export interface SpeechPlatform {
  readonly engine: 'system' | 'whisper';
  need(language: SpeechLanguage, model: SpeechModel): Promise<SpeechNeed>;
  /** iOS: Prompt the system to download the recognition model (can only be called after user confirmation). */
  prepare(language: SpeechLanguage, onProgress?: (fraction: number) => void): Promise<void>;
  transcribe(uri: string, request: TranscribeRequest): Promise<SpeechTranscript>;
}

const CANCEL_POLL_MS = 300;

let nextTask = 0;
const newTaskId = () => `speech-${Date.now()}-${nextTask++}`;

function asSpeechError(e: unknown): SpeechError {
  if (e instanceof SpeechError) return e;
  const code = (e as { code?: string })?.code;
  const message = e instanceof Error ? e.message : String(e);
  return new SpeechError((code && NATIVE_CODES[code]) || 'failed', message);
}

/** Null when native modules are unavailable (Expo Go, tests). */
export function createSpeech(
  native: MorphSpeechModule | null,
  packs: SpeechPacks | null,
): SpeechPlatform | null {
  if (!native) return null;
  const nativeLanguage = (language: SpeechLanguage) =>
    native.engine === 'system' ? SYSTEM_SPEECH_LOCALES[language] : whisperLanguage(language);

  return {
    engine: native.engine,

    async need(language, model) {
      const status = await native.languageStatus(nativeLanguage(language));
      if (status === 'unsupported') return { kind: 'unsupported' };
      if (native.engine === 'system') {
        return status === 'needsDownload' ? { kind: 'systemDownload' } : { kind: 'ready' };
      }
      const packId = SPEECH_MODEL_PACKS[model];
      if (!packs) return { kind: 'unsupported' };
      const ready = (await packs.isInstalled(packId)) && (await packs.isInstalled(SPEECH_VAD_PACK));
      return ready ? { kind: 'ready' } : { kind: 'pack', packId };
    },

    async prepare(language, onProgress) {
      const taskId = newTaskId();
      const sub = native.addListener('onProgress', (e) => {
        if (e.taskId === taskId) onProgress?.(e.fraction);
      });
      try {
        await native.prepareLanguage(nativeLanguage(language), taskId);
      } catch (e) {
        throw asSpeechError(e);
      } finally {
        sub.remove();
      }
    },

    async transcribe(uri, { language, model, onProgress, isCancelled, timed }) {
      const taskId = newTaskId();
      const whisper = native.engine === 'whisper';
      if (whisper && !packs) throw new SpeechError('model', 'no downloads');
      const sub = native.addListener('onProgress', (e) => {
        if (e.taskId === taskId) onProgress?.(e.fraction);
      });
      const poll = isCancelled
        ? setInterval(() => {
            if (isCancelled()) native.cancel(taskId);
          }, CANCEL_POLL_MS)
        : null;
      try {
        const result = await native.transcribe(uri, {
          taskId,
          ...(timed ? { timed: true } : {}),
          language: nativeLanguage(language),
          ...(whisper && {
            model: packs!.uri(SPEECH_MODEL_PACKS[model], SPEECH_MODEL_FILE),
            vad: packs!.uri(SPEECH_VAD_PACK, SPEECH_VAD_FILE),
            prompt: whisperPrompt(language),
          }),
        });
        return {
          text: tidyTranscript(result.segments, language),
          durationMs: result.durationMs,
          ...(timed ? { segments: result.segments } : {}),
        };
      } catch (e) {
        throw asSpeechError(e);
      } finally {
        if (poll) clearInterval(poll);
        sub.remove();
      }
    },
  };
}
