import {
  AUDIO_COMPRESS_PARAMS,
  AUDIO_CONVERT_PARAMS,
  implOf,
  localize,
  MAX_SPEAK_CHARS,
  RunCancelled,
  RunError,
  SPEAK_VOICE_LOCALES,
  SPEECH_LANGUAGE_NAMES,
  chooseSpeakLanguage,
  estimateSpeechBytes,
  splitForSpeech,
  translateLanguageName,
  audioSourceKbps,
  planAudioConvert,
  planAudioQuality,
  planAudioSize,
  estimateAudioBytes,
  planVideoConvert,
  speechToSrt,
  type ActionImpl,
  type AudioFormat,
  type AudioPlan,
  type AudioSource,
  type RunItem,
  type RunValue,
  type SpeakLanguage,
  type SpeechLanguage,
  type SpeechModel,
} from '@morph/core';

import { t } from '../../i18n';
import type { MediaInfo, MediaOutput, MediaPlatform } from '../platform';
import { SpeechError } from '../speech';
import { MB, displayName, fileItems, freshName, writeItem, type RunServices } from './helpers';
import { checkSpace, mediaError } from './video';

// Audio tool action implementations (D-150–D-155): bitrate and channels are calculated in
// core/audio.ts, encoding is delegated to the native module morph-media, speech-to-text to
// morph-speech (iOS system recognition, Android whisper.cpp), and text-to-speech to morph-tts
// (system voice, D-270). Recognized text and text to be spoken remain on-device only (D-036).

type Impl = ActionImpl<RunServices>;
type Ctx = Parameters<Impl>[2];

/** Maximum number of additional compression passes if it still exceeds the target after compressing. */
const MAX_RETRIES = 2;
/** Number of initial segments to inspect for automatic language detection (sufficient for identification without handing the entire book to the system). */
const DETECT_SEGMENTS = 8;
/** Proportion of progress allocated to speech synthesis when converting to M4A (format conversion is very fast). */
const SPEAK_SHARE = 0.9;

/** Number of buckets in a trimmed waveform interface. */
const WAVEFORM_BUCKETS = 120;

const audioMime = (ext: string) =>
  ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4';

function mediaOf(ctx: Ctx): MediaPlatform {
  const media = ctx.services.files.media;
  if (!media) throw new RunError('needsFullApp');
  return media;
}

async function probeAudio(media: MediaPlatform, item: RunItem): Promise<MediaInfo> {
  let info: MediaInfo;
  try {
    info = await media.probe(item.uri);
  } catch (e) {
    throw mediaError(e, item);
  }
  if (!info.hasAudio) {
    throw new RunError(info.hasVideo ? 'noAudio' : 'mediaUnsupported', { name: displayName(item) });
  }
  return info;
}

const sourceOf = (item: RunItem, info: MediaInfo): AudioSource => ({
  durationMs: info.durationMs || item.durationMs || 0,
  size: info.hasVideo ? 0 : info.size || item.size,
  ...(info.channels ? { channels: info.channels } : {}),
  ...(info.sampleRate ? { sampleRate: info.sampleRate } : {}),
  ...(info.audioBitrateKbps ? { kbps: info.audioBitrateKbps } : {}),
});

const encodeOf = (plan: AudioPlan, range?: { startMs: number; endMs: number }) => ({
  format: plan.format,
  bitrateKbps: plan.bitrateKbps,
  channels: plan.channels,
  sampleRate: plan.sampleRate,
  ...(range ? { range } : {}),
});

const audioItem = (item: RunItem, result: MediaOutput, name = item.name): RunItem => ({
  uri: result.uri,
  name,
  ext: result.ext || 'm4a',
  mimeType: audioMime(result.ext),
  size: result.size,
  durationMs: result.info.durationMs,
  ...(item.takenAt !== undefined ? { takenAt: item.takenAt } : {}),
});

/** A job: reports progress as a cumulative percentage across all files, monotonically increasing; cancellation is handled via "Stop" on the run page. */
function jobFor(ctx: Ctx, index: number, total: number) {
  let shown = 0;
  return {
    progress: (f: number) => {
      shown = Math.max(shown, Math.min(1, f));
      ctx.progress(Math.round(((index + shown) / total) * 100), 100, 'percent');
    },
    isCancelled: () => {
      try {
        ctx.throwIfCancelled();
        return false;
      } catch {
        return true;
      }
    },
  };
}

/** Process audio files (or video sound tracks) one by one. work returns a new temporary file, or null (passes through to the next step unchanged). */
async function eachAudio(
  input: RunValue | null,
  ctx: Ctx,
  work: (
    item: RunItem,
    info: MediaInfo,
    media: MediaPlatform,
    job: ReturnType<typeof jobFor>,
  ) => Promise<MediaOutput | null>,
): Promise<RunValue> {
  const items = fileItems(input);
  const media = mediaOf(ctx);
  const out: RunItem[] = [];
  for (const [i, item] of items.entries()) {
    ctx.throwIfCancelled();
    const job = jobFor(ctx, i, items.length);
    job.progress(0);
    const info = await probeAudio(media, item);
    let result: MediaOutput | null;
    try {
      result = await work(item, info, media, job);
    } catch (e) {
      throw mediaError(e, item);
    }
    out.push(result ? audioItem(item, result) : item);
  }
  ctx.progress(100, 100, 'percent');
  return { type: 'audio', items: out };
}

/** Already in this format (AAC, WAV, or MP3 within M4A): no need to transcode. */
function alreadyIn(item: RunItem, info: MediaInfo, format: AudioFormat): boolean {
  if (info.hasVideo) return false;
  if (format === 'wav') return item.ext === 'wav';
  if (format === 'mp3') return item.ext === 'mp3';
  return item.ext === 'm4a' && /^(aac|mp4a)/i.test(info.audioCodec ?? '');
}

/** Speech-to-text error → user-facing error. */
function speechError(e: unknown, item: RunItem, ctx: Ctx, language: SpeechLanguage): Error {
  if (e instanceof RunError || e instanceof RunCancelled) return e;
  const { locale } = ctx;
  const lang = localize(SPEECH_LANGUAGE_NAMES[language], locale);
  if (!(e instanceof SpeechError)) {
    return new RunError('unexpected', { detail: String((e as Error)?.message ?? e) });
  }
  switch (e.code) {
    case 'cancelled':
      return new RunCancelled();
    case 'unreadableAudio':
      return new RunError('mediaUnsupported', { name: displayName(item) });
    case 'notAuthorized':
      return new RunError('permissionDenied', { what: 'speech' });
    case 'unsupportedLanguage':
      return new RunError('unsupportedAction', {
        action: t(locale, 'speechLangUnsupported', { lang }),
      });
    case 'unavailable':
      return new RunError('unsupportedAction', { action: t(locale, 'speechUnavailable') });
    case 'needsDownload':
    case 'model':
      return new RunError('packFailed', { detail: t(locale, 'speechDownloadFailed', { lang }) });
    default:
      return new RunError('unexpected', { detail: e.message });
  }
}

async function prepareSpeech(ctx: Ctx, language: SpeechLanguage, model: SpeechModel) {
  const { locale } = ctx;
  const speech = ctx.services.files.speech;
  if (!speech) throw new RunError('needsFullApp');
  const lang = localize(SPEECH_LANGUAGE_NAMES[language], locale);

  const need = await speech.need(language, model);
  if (need.kind === 'unsupported') {
    throw new RunError('unsupportedAction', {
      action: t(locale, 'speechLangUnsupported', { lang }),
    });
  }
  // iPhone: the system needs to download the recognition model for this language first; prompt the user before downloading (D-064, D-112).
  if (need.kind === 'systemDownload') {
    const ok = await ctx.services.ui.confirm(
      t(locale, 'speechDownloadAsk', { lang }),
      t(locale, 'speechDownload'),
      t(locale, 'cancel'),
      t(locale, 'speechDownloadBody'),
    );
    if (!ok) throw new RunCancelled();
    try {
      await speech.prepare(language, (f) => ctx.progress(Math.round(f * 100), 100, 'percent'));
    } catch {
      throw new RunError('packFailed', { detail: t(locale, 'speechDownloadFailed', { lang }) });
    }
  }
  // Android: models are confirmed for download by the executor prior to this step via packFor; if not specified, download failed.
  if (need.kind === 'pack') {
    throw new RunError('packFailed', { detail: t(locale, 'speechDownloadFailed', { lang }) });
  }

  return speech;
}

async function processSound(
  input: Parameters<Impl>[0],
  params: Parameters<Impl>[1],
  ctx: Ctx,
  denoise: boolean,
): Promise<RunValue> {
  if (!input || (input.type !== 'audio' && input.type !== 'video'))
    throw new RunError('wrongType', { kind: 'audio/video' });
  const media = mediaOf(ctx);
  const out: RunItem[] = [];
  for (const [i, item] of input.items.entries()) {
    ctx.throwIfCancelled();
    const info = await probeAudio(media, item);
    const video =
      input.type === 'video'
        ? planVideoConvert({
            durationMs: info.durationMs,
            size: item.size,
            hasAudio: info.hasAudio,
            width: info.width,
            height: info.height,
            videoKbps: info.videoBitrateKbps,
          })
        : undefined;
    const pcmBytes =
      (info.durationMs / 1000) *
      Math.max(48000 * 2 * 4, (info.sampleRate ?? 48000) * (info.channels ?? 2) * 2);
    checkSpace(
      ctx,
      pcmBytes +
        (video
          ? ((video.videoKbps + video.audioKbps) * info.durationMs) / 8
          : info.durationMs * 24),
    );
    let shown = 0;
    try {
      const result = await (denoise ? media.denoise.bind(media) : media.volume.bind(media))(
        item.uri,
        {
          automatic: params.mode === 'normal',
          db: Number(params.db ?? 0),
          ...(video
            ? {
                video: {
                  videoKbps: video.videoKbps,
                  audioKbps: video.audioKbps,
                  maxFps: video.maxFps,
                },
              }
            : {}),
        },
        ctx.services.runId,
        freshName(item.name, video ? 'mp4' : 'm4a'),
        {
          progress: (f) => {
            shown = Math.max(shown, Math.min(1, f));
            ctx.progress(Math.round(((i + shown) / input.items.length) * 100), 100, 'percent');
          },
          isCancelled: () => {
            try {
              ctx.throwIfCancelled();
              return false;
            } catch {
              return true;
            }
          },
        },
      );
      out.push({
        ...item,
        uri: result.uri,
        ext: result.ext,
        mimeType: video ? 'video/mp4' : 'audio/mp4',
        size: result.size,
        durationMs: result.info.durationMs,
        ...(result.info.width ? { width: result.info.width } : {}),
        ...(result.info.height ? { height: result.info.height } : {}),
      });
    } catch (e) {
      throw mediaError(e, item);
    }
  }
  ctx.throwIfCancelled();
  return { type: input.type, items: out };
}

export const AUDIO_IMPLS: Record<string, Impl> = {
  async 'video.subtitles'(input, params, ctx) {
    if (input?.type !== 'video') throw new RunError('wrongType', { kind: 'video' });
    const language = params.lang as SpeechLanguage;
    const model = params.model as SpeechModel;
    const speech = await prepareSpeech(ctx, language, model);
    const media = mediaOf(ctx);
    const out: RunItem[] = [];
    for (const [i, item] of input.items.entries()) {
      ctx.throwIfCancelled();
      const info = await probeAudio(media, item);
      checkSpace(
        ctx,
        (info.durationMs / 1000) *
          Math.max(48000 * 2 * 4, (info.sampleRate ?? 48000) * (info.channels ?? 2) * 2),
      );
      const job = jobFor(ctx, i, input.items.length);
      let audio: MediaOutput;
      try {
        audio = await media.speechAudio(
          item.uri,
          ctx.services.runId,
          freshName(`${item.name}-speech`, 'wav'),
          { isCancelled: job.isCancelled, progress: (f) => job.progress(f * 0.2) },
        );
      } catch (error) {
        throw mediaError(error, item);
      }
      ctx.throwIfCancelled();
      let segments;
      try {
        ({ segments } = await speech.transcribe(audio.uri, {
          language,
          model,
          timed: true,
          onProgress: (f) => job.progress(0.2 + f * 0.8),
          isCancelled: job.isCancelled,
        }));
      } catch (error) {
        throw speechError(error, item, ctx, language);
      }
      if (!segments)
        throw new RunError('unsupportedAction', { action: t(ctx.locale, 'subtitlesNeedApp') });
      const srt = speechToSrt(segments, language, info.durationMs);
      if (!srt) throw new RunError('noSpeech', { name: displayName(item) });
      ctx.throwIfCancelled();
      out.push(
        await writeItem(ctx.services, new TextEncoder().encode(srt), {
          name: item.name,
          ext: 'srt',
          mimeType: 'application/x-subrip',
        }),
      );
    }
    ctx.progress(100, 100, 'percent');
    return { type: 'files', items: out };
  },

  'audio.volume': (input, params, ctx) => processSound(input, params, ctx, false),
  'audio.denoise': (input, params, ctx) => processSound(input, params, ctx, true),
  'audio.compress': implOf(AUDIO_COMPRESS_PARAMS, async (input, { by, maxMB, quality }, ctx) => {
    const target = maxMB * MB;
    return eachAudio(input, ctx, async (item, info, media, job) => {
      const source = sourceOf(item, info);
      const encode = (plan: AudioPlan) => {
        checkSpace(ctx, estimateAudioBytes(plan, source.durationMs));
        return media.encodeAudio(
          item.uri,
          encodeOf(plan),
          ctx.services.runId,
          freshName(item.name, 'm4a'),
          job,
        );
      };
      if (by === 'quality') return encode(planAudioQuality(source, quality));

      const first = planAudioSize(source, target);
      if (first.kind === 'keep') return null;
      if (first.kind === 'tooSmall') {
        throw new RunError('audioTooSmall', {
          name: displayName(item),
          target: `${maxMB} MB`,
          mb: first.minMB,
        });
      }
      let result = await encode(first.plan);
      // Encoders may slightly overshoot the bitrate: if exceeded, scale down proportionally and re-encode.
      let factor = 1;
      for (let retry = 0; result.size > target && retry < MAX_RETRIES; retry++) {
        factor *= (target / result.size) * 0.95;
        const next = planAudioSize(source, target, factor);
        if (next.kind !== 'encode') break;
        result = await encode(next.plan);
      }
      if (result.size > target) {
        throw new RunError('targetNotMet', {
          name: displayName(item),
          target: `${maxMB} MB`,
          got: `${(result.size / MB).toFixed(1)} MB`,
        });
      }
      return result;
    });
  }),

  'audio.convert': implOf(AUDIO_CONVERT_PARAMS, async (input, { format }, ctx) => {
    return eachAudio(input, ctx, async (item, info, media, job) => {
      if (alreadyIn(item, info, format)) return null;
      const plan = planAudioConvert(sourceOf(item, info), format);
      checkSpace(ctx, estimateAudioBytes(plan, info.durationMs));
      return media.encodeAudio(
        item.uri,
        encodeOf(plan),
        ctx.services.runId,
        freshName(item.name, format),
        job,
      );
    });
  }),

  async 'audio.fromVideo'(input, params, ctx) {
    const format = params.format as AudioFormat;
    return eachAudio(input, ctx, async (item, info, media, job) => {
      const plan = planAudioConvert(sourceOf(item, info), format);
      checkSpace(ctx, estimateAudioBytes(plan, info.durationMs));
      return media.encodeAudio(
        item.uri,
        encodeOf(plan),
        ctx.services.runId,
        freshName(item.name, format),
        job,
      );
    });
  },

  async 'audio.trim'(input, _params, ctx) {
    const media = mediaOf(ctx);
    // Trimming interface needs duration (file picker from share does not provide it); waveforms are read after the interface opens.
    const items: RunItem[] = [];
    const infos: MediaInfo[] = [];
    for (const item of fileItems(input)) {
      const info = await probeAudio(media, item);
      infos.push(info);
      items.push({ ...item, durationMs: info.durationMs });
    }
    const ranges = await ctx.services.ui.open('trimMedia', {
      items,
      loadWaveform: (i) => media.waveform(items[i]!.uri, WAVEFORM_BUCKETS),
    });
    if (!ranges) throw new RunCancelled();
    const out: RunItem[] = [];
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      const range = ranges[i];
      const whole = item.durationMs ?? 0;
      // No trimming needed if the entire range is selected (startMs <= 0 and whole > 0 and endMs >= whole).
      if (!range || (range.startMs <= 0 && whole > 0 && range.endMs >= whole)) {
        out.push(item);
        continue;
      }
      // Re-encode to M4A: any format can be trimmed with millisecond accuracy (uncoded cutting is only suitable for M4A, and the start point may be misaligned otherwise).
      const plan = planAudioConvert(sourceOf(item, infos[i]!), 'm4a');
      checkSpace(ctx, estimateAudioBytes(plan, range.endMs - range.startMs));
      let result: MediaOutput;
      try {
        result = await media.encodeAudio(
          item.uri,
          encodeOf(plan, range),
          ctx.services.runId,
          freshName(item.name, 'm4a'),
          jobFor(ctx, i, items.length),
        );
      } catch (e) {
        throw mediaError(e, item);
      }
      out.push(audioItem(item, result));
    }
    ctx.progress(100, 100, 'percent');
    return { type: 'audio', items: out };
  },

  async 'audio.merge'(input, _params, ctx) {
    const items = fileItems(input);
    if (items.length <= 1) return input!;
    const media = mediaOf(ctx);
    const infos: MediaInfo[] = [];
    for (const item of items) infos.push(await probeAudio(media, item));
    const sources = items.map((item, i) => sourceOf(item, infos[i]!));
    const durationMs = sources.reduce((sum, s) => sum + s.durationMs, 0);
    // Use stereo if any segment is stereo; bitrate follows the highest-quality segment (up to 192
    // kbps). Android often fails to report bitrates for M4A, so calculate based on size and
    // duration (otherwise, two voice memos combined would be synthesized at 128 kbps, inflating
    // size significantly).
    const plan = planAudioConvert(
      {
        durationMs,
        size: 0,
        channels: Math.max(...sources.map((s) => s.channels ?? 2)),
        kbps: Math.max(...sources.map((s) => audioSourceKbps(s) || 128)),
      },
      'm4a',
    );
    checkSpace(ctx, estimateAudioBytes(plan, durationMs));
    const first = items[0]!;
    const name = t(ctx.locale, 'audioMerged', { name: first.name, n: items.length - 1 });
    let result: MediaOutput;
    try {
      result = await media.concatAudio(
        items.map((it) => it.uri),
        encodeOf(plan),
        ctx.services.runId,
        freshName(name, 'm4a'),
        jobFor(ctx, 0, 1),
      );
    } catch (e) {
      throw mediaError(e, first);
    }
    ctx.progress(100, 100, 'percent');
    return { type: 'audio', items: [audioItem(first, result, name)] };
  },

  // Text-to-speech (D-270): system voice is first read as WAV, then passed to morph-media when M4A is requested (using the same bitrate rules as "Audio convert format").
  async 'audio.fromText'(input, params, ctx) {
    if (input?.type !== 'text') throw new RunError('emptyText');
    const text = input.text.trim();
    if (!text) throw new RunError('emptyText');
    if (text.length > MAX_SPEAK_CHARS) throw new RunError('textTooLong', { max: MAX_SPEAK_CHARS });
    const segments = splitForSpeech(text);
    if (segments.length === 0) throw new RunError('emptyText');
    const { locale } = ctx;
    const speaker = ctx.services.files.speaker;
    if (!speaker) throw new RunError('needsFullApp');
    const unsupported = (key: Parameters<typeof t>[1], lang?: SpeakLanguage) =>
      new RunError('unsupportedAction', {
        action: t(locale, key, lang ? { lang: translateLanguageName(lang, locale) } : {}),
      });

    let lang = params.lang as SpeakLanguage | 'auto';
    if (lang === 'auto') {
      // Query the system first (uses the same language recognition as translation); fallback to guessing based on the text's writing system if unrecognized. Uses only one voice at a time.
      const sample = segments.slice(0, DETECT_SEGMENTS);
      const detected = await ctx.services.files.translator
        ?.detectLanguages(sample)
        .catch(() => null);
      const chosen = chooseSpeakLanguage(sample, detected ?? null, locale);
      if (!chosen) throw unsupported('speakLanguageUnknown');
      lang = chosen;
    }
    const voice = SPEAK_VOICE_LOCALES[lang];
    const status = await speaker.voiceStatus(voice);
    if (status === 'noEngine') throw unsupported('speakNoEngine');
    if (status === 'unsupported') throw unsupported('speakNoVoice', lang);
    if (status === 'notDownloaded') throw unsupported('speakNotDownloaded', lang);

    const rate = Number(params.rate);
    const format = params.format === 'wav' ? 'wav' : 'm4a';
    // WAV intermediate file must have sufficient capacity; include M4A size (much smaller) when converting to M4A.
    const wavBytes = estimateSpeechBytes(text, rate);
    checkSpace(ctx, format === 'm4a' ? wavBytes * 1.1 : wavBytes);
    const share = format === 'm4a' ? SPEAK_SHARE : 1;
    let shown = 0;
    const progress = (f: number) => {
      shown = Math.max(shown, Math.min(1, f));
      ctx.progress(Math.round(shown * 100), 100, 'percent');
    };
    const { isCancelled } = jobFor(ctx, 0, 1);
    progress(0);

    let wav;
    try {
      wav = await speaker.synthesize(segments, {
        voice,
        rate,
        runId: ctx.services.runId,
        relPath: freshName(input.name, 'wav'),
        onProgress: (f) => progress(f * share),
        isCancelled,
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'cancelled') throw new RunCancelled();
      if (code === 'noVoice') throw unsupported('speakNoVoice', lang);
      if (code === 'notDownloaded') throw unsupported('speakNotDownloaded', lang);
      if (code === 'unavailable') throw unsupported('speakNoEngine');
      throw new RunError('unexpected', { detail: String((e as Error).message ?? e) });
    }
    ctx.throwIfCancelled();
    const spoken: RunItem = {
      uri: wav.uri,
      name: input.name,
      ext: 'wav',
      mimeType: audioMime('wav'),
      size: wav.size,
      durationMs: wav.durationMs,
    };
    if (format === 'wav') {
      progress(1);
      return { type: 'audio', items: [spoken] };
    }

    // M4A: speech narration is monophonic human voice, bitrate follows "Audio convert format" rules (following WAV would hit the upper limit, so assign speech-appropriate rates here).
    const media = mediaOf(ctx);
    const plan = planAudioConvert(
      {
        durationMs: wav.durationMs,
        size: 0,
        channels: wav.channels,
        sampleRate: wav.sampleRate,
        kbps: 64,
      },
      'm4a',
    );
    let result: MediaOutput;
    try {
      result = await media.encodeAudio(
        wav.uri,
        encodeOf(plan),
        ctx.services.runId,
        freshName(input.name, 'm4a'),
        { progress: (f) => progress(share + f * (1 - share)), isCancelled },
      );
    } catch (e) {
      throw mediaError(e, spoken);
    }
    progress(1);
    return { type: 'audio', items: [audioItem(spoken, result)] };
  },

  async 'audio.transcribe'(input, params, ctx) {
    const items = fileItems(input);
    const language = params.lang as SpeechLanguage;
    const model = params.model as SpeechModel;
    const speech = await prepareSpeech(ctx, language, model);

    const parts: { name: string; text: string }[] = [];
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      const job = jobFor(ctx, i, items.length);
      job.progress(0);
      let text: string;
      try {
        ({ text } = await speech.transcribe(item.uri, {
          language,
          model,
          onProgress: job.progress,
          isCancelled: job.isCancelled,
        }));
      } catch (e) {
        throw speechError(e, item, ctx, language);
      }
      if (text.trim()) parts.push({ name: displayName(item), text: text.trim() });
    }
    if (parts.length === 0) throw new RunError('noSpeech', { name: displayName(items[0]!) });
    ctx.progress(100, 100, 'percent');
    // Prepend filename to each segment when there are multiple recordings. Text remains on-device only: copied, saved as a file, or formatted into a PDF, never sent to AI.
    const text =
      items.length === 1
        ? parts[0]!.text
        : parts.map((p) => `【${p.name}】\n${p.text}`).join('\n\n');
    // A single voice recording is a sentence spoken by the user (D-575): when followed by "log an expense", it fills the form directly. Combinations of multiple recordings stitched together are not counted.
    return {
      type: 'text',
      text,
      name: items[0]!.name,
      ...(items.length === 1 ? { spoken: true } : {}),
    };
  },
};
