import type { MorphTTSModule } from '../../modules/morph-tts';
import type { SpeakErrorCode, SpeakPlatform } from './platform';

// Implementation of SpeakPlatform: local Expo module MorphTTS (D-270). Null when this module is
// absent (Expo Go, tests). Cancellation is identical to speech-to-text: check the run page Stop
// button every 0.3 seconds and hand off to the native module to stop system text-to-speech.

const CANCEL_POLL_MS = 300;

/** Native module error codes -> platform error codes. */
const CODES: Record<string, SpeakErrorCode> = {
  ERR_TTS_NO_VOICE: 'noVoice',
  ERR_TTS_NOT_DOWNLOADED: 'notDownloaded',
  ERR_TTS_UNAVAILABLE: 'unavailable',
  ERR_TTS_CANCELLED: 'cancelled',
};

function rethrow(e: unknown): never {
  const code = CODES[String((e as { code?: string })?.code)] ?? 'failed';
  throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { code });
}

let nextTask = 0;
const newTaskId = () => `tts-${Date.now()}-${nextTask++}`;

export function createSpeaker(
  native: MorphTTSModule | null,
  runUri: (runId: string, relPath: string) => string,
): SpeakPlatform | null {
  if (!native) return null;
  return {
    voiceStatus: (voice) => native.voiceStatus(voice),

    async synthesize(segments, { voice, rate, runId, relPath, onProgress, isCancelled }) {
      const taskId = newTaskId();
      const sub = native.addListener('onProgress', (e) => {
        if (e.taskId === taskId) onProgress?.(e.fraction);
      });
      const poll = isCancelled
        ? setInterval(() => {
            if (isCancelled()) native.cancel(taskId);
          }, CANCEL_POLL_MS)
        : null;
      try {
        return await native.synthesize(segments, {
          taskId,
          voice,
          rate,
          output: runUri(runId, relPath),
        });
      } catch (e) {
        return rethrow(e);
      } finally {
        if (poll) clearInterval(poll);
        sub.remove();
      }
    },
  };
}
