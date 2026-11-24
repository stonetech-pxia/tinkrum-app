import { tidyTranscript, type SpeechLanguage, type SpeechSegment } from './speech';

const stamp = (ms: number) => {
  const value = Math.max(0, Math.round(ms));
  const pad = (v: number, n = 2) => String(v).padStart(n, '0');
  return `${pad(Math.floor(value / 3600000))}:${pad(Math.floor(value / 60000) % 60)}:${pad(Math.floor(value / 1000) % 60)},${pad(value % 1000, 3)}`;
};
function splitAt(text: string, max: number): string[] {
  const output: string[] = [];
  let rest = Array.from(text);
  while (rest.length > max) {
    let cut = max;
    // Latin languages prefer line breaks at word boundaries; long words and CJK characters are split by Unicode characters.
    for (let i = max; i > max * 0.55; i--)
      if (rest[i] === ' ') {
        cut = i;
        break;
      }
    output.push(rest.slice(0, cut).join('').trim());
    rest = rest.slice(cut);
    while (rest[0] === ' ') rest.shift();
  }
  if (rest.length) output.push(rest.join('').trim());
  return output;
}
/** Maximum display duration for a subtitle cue (milliseconds), longer cues are split proportionally by text length. */
const MAX_CUE_MS = 6000;
/** Minimum display duration for a cue that is completely covered by the previous one and forced to follow it. */
const MIN_CUE_MS = 700;

/** Generate SRT from actual recognition timestamps; overly long native segments are split proportionally by text length, within-segment times are approximate. Maximum two lines per cue. */
export function speechToSrt(
  segments: readonly SpeechSegment[],
  language: SpeechLanguage,
  durationMs: number,
): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '';
  const lineLength = ['zh', 'zh-TW', 'ja', 'ko'].includes(language) ? 21 : 42;
  const fits = (text: string) => splitAt(text, lineLength).length <= 2;
  const end = Math.floor(durationMs);
  const candidates: SpeechSegment[] = [];
  for (const segment of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    if (!Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs)) continue;
    const startMs = Math.max(0, Math.round(segment.startMs));
    const endMs = Math.min(end, Math.round(segment.endMs));
    if (endMs <= startMs) continue;
    const text = tidyTranscript(
      [{ ...segment, text: segment.text.replace(/\s+/g, ' ') }],
      language,
    ).trim();
    if (!text) continue;
    // Split from both ends based on word count (fitting two lines) and duration (not exceeding MAX_CUE_MS).
    const length = Array.from(text).length;
    const pieces = Math.max(
      Math.ceil(length / (lineLength * 2)),
      Math.ceil((endMs - startMs) / MAX_CUE_MS),
    );
    const chunks = splitAt(text, Math.max(1, Math.ceil(length / pieces))).flatMap((chunk) =>
      fits(chunk) ? [chunk] : splitAt(chunk, lineLength),
    );
    const weights = chunks.map((c) => Array.from(c).length);
    const total = weights.reduce((a, b) => a + b, 0);
    let consumed = 0;
    for (const [i, chunk] of chunks.entries()) {
      const start = startMs + Math.round(((endMs - startMs) * consumed) / total);
      consumed += weights[i]!;
      const stop = startMs + Math.round(((endMs - startMs) * consumed) / total);
      if (stop > start) candidates.push({ startMs: start, endMs: stop, text: chunk });
    }
  }
  const cues: SpeechSegment[] = [];
  for (const candidate of candidates.sort((a, b) => a.startMs - b.startMs)) {
    const previous = cues[cues.length - 1];
    const startMs = Math.max(candidate.startMs, previous?.endMs ?? 0);
    const combined = previous ? tidyTranscript([previous, candidate], language) : candidate.text;
    if (candidate.endMs <= startMs) {
      // Entire segment falls within the previous cue's time (recognition results overlap): merge into the previous cue; if it doesn't fit, append it immediately after, without losing text.
      if (!previous) continue;
      if (fits(combined)) previous.text = combined;
      else if (startMs < end)
        cues.push({
          startMs,
          endMs: Math.min(end, startMs + Math.max(MIN_CUE_MS, candidate.endMs - candidate.startMs)),
          text: candidate.text,
        });
      continue;
    }
    if (
      previous &&
      startMs - previous.endMs <= 350 &&
      candidate.endMs - previous.startMs <= MAX_CUE_MS &&
      fits(combined) &&
      !/[.!?。！？]$/.test(previous.text)
    ) {
      previous.text = combined;
      previous.endMs = candidate.endMs;
    } else cues.push({ ...candidate, startMs });
  }
  return cues
    .map(
      (cue, i) =>
        `${i + 1}\r\n${stamp(cue.startMs)} --> ${stamp(cue.endMs)}\r\n${splitAt(cue.text, lineLength).join('\r\n')}\r\n`,
    )
    .join('\r\n');
}
