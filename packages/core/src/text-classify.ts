// File "form/topic" prototype (local-only, not yet integrated into the inbox): The recognized text
// is first checked by code for readability. Blank and garbled text are directly classified as
// "unknown" and never sent to the model. Readable text is ranked against candidates using local
// embedding similarity; if the score is not high enough, or if the top two results are too close,
// it also returns "unknown". Used exclusively for clickable recommendations, never runs
// automatically (D-190). Text, vectors, and results never leave the device and are never sent to
// the AI. Thresholds are provided by the caller and must be determined on a calibration set, see
// side-session-notes/model-eval/CLASSIFY_124_REPORT.md (measurement report, not in repo). Avoid
// \\p{...} (older Hermes versions do not support Unicode properties), write out character ranges
// explicitly.

export type TextReadability = 'blank' | 'garbled' | 'readable';

/** Requires at least this many readable characters (Chinese characters, letters in words, numbers) before sending to the model. */
export const MIN_READABLE_CHARS = 6;
/** Readable characters must account for at least this fraction of non-whitespace characters. */
export const MIN_READABLE_SHARE = 0.5;

// CJK characters (Hanzi, Kana, Hangul): every character is considered readable.
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
// Latin (including French accents), Greek, and Cyrillic letters.
const LETTERS = 'A-Za-zÀ-ÖØ-öø-ɏͰ-ϿЀ-ӿ';
const LETTER = new RegExp(`[${LETTERS}]`);
const ANY_TEXT = new RegExp(`[${LETTERS}0-9]|${CJK.source}`);
const WORD = new RegExp(`^[${LETTERS}]+(?:['’\\-][${LETTERS}]+)*$`);
// Numbers, amounts, dates, times, percentages (12,50 €, $4.20, 2026-03-12, 14:05, -20%).
const NUMBER = /^[-+]?[$€£¥]?\d[\d.,:/\-]*[%€$£¥]?$/;
// Receipt numbers, codes (INV-2026-0042, F2026-118, A12B34): at least two digits, at least four characters.
const CODE = /^(?=(?:[^\d]*\d){2})[A-Za-z0-9#/\-]{4,}$/;
// Form blank lines and checkboxes (Applicant name: ________ □ Male □ Female) are layout elements, neither characters nor garbled text.
const FORM_BLANKS = /[_\u2610\u25a1]+/g;
// Leading and trailing punctuation are not counted as part of the word.
const EDGE = /^[\s.,;:!?¡¿()[\]{}"'«»“”‘’<>*·•…—–]+|[\s.,;:!?¡¿()[\]{}"'«»“”‘’<>*·•…—–]+$/g;

/** Number of readable characters within a whitespace-separated segment. */
function readableChars(token: string): number {
  if (CJK.test(token)) {
    // A Chinese text segment is often followed by numbers and units (e.g., 32.00 RMB paid); Chinese characters, letters, and numbers are all counted.
    return [...token].filter((ch) => CJK.test(ch) || LETTER.test(ch) || /\d/.test(ch)).length;
  }
  const core = token.replace(EDGE, '');
  if (core.length === 0) return 0;
  // Single letters (à, a, l) are excluded: scattered single letters are the most common artifact in garbled text.
  if (WORD.test(core) && core.length >= 2) return core.length;
  if (NUMBER.test(core) || CODE.test(core)) return core.length;
  return 0;
}

/**
 * Determines whether the recognition result can be used for classification: returns 'blank' if
 * there are no letters, numbers, or Chinese characters; 'garbled' if there are too few readable
 * characters or their proportion is too low (such as "lI1 |:; 0O0 ■■"); otherwise 'readable'.
 * Evaluates characters only, not semantics: text that is grammatically correct but discusses
 * something else (a poem, a manual) is handled by subsequent score checks.
 */
export function textReadability(text: string): TextReadability {
  if (!ANY_TEXT.test(text)) return 'blank';
  const tokens = text
    .replace(FORM_BLANKS, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const total = tokens.reduce((n, t) => n + [...t].length, 0);
  const good = tokens.reduce((n, t) => n + readableChars(t), 0);
  return good >= MIN_READABLE_CHARS && good >= MIN_READABLE_SHARE * total ? 'readable' : 'garbled';
}

/** A candidate label (embedded form, topic, or user-defined category) along with the vector of its description text. */
export interface LabelVector {
  id: string;
  vector: ArrayLike<number>;
}

export interface LabelScore {
  id: string;
  score: number;
}

/** Cosine similarity; returns 0 if either vector is a zero vector. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error('vector lengths differ');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Ranks candidates by similarity from highest to lowest; preserves original order on ties. */
export function rankLabels(query: ArrayLike<number>, labels: readonly LabelVector[]): LabelScore[] {
  return labels
    .map((l, i) => ({ id: l.id, score: cosine(query, l.vector), i }))
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .map(({ id, score }) => ({ id, score }));
}

/**
 * Conditions for assigning a category (defined independently per dimension): the top score must
 * not be lower than minScore, and must exceed the second place by at least minMargin. Similarity
 * is not a probability, so these thresholds must be determined on a calibration set and
 * re-evaluated when changing models, quantization, or candidate descriptions.
 */
export interface GuessThresholds {
  minScore: number;
  minMargin: number;
}

export type UnknownReason = 'blank' | 'garbled' | 'noCandidates' | 'lowScore' | 'tooClose';

export type LabelGuess =
  | { status: 'label'; id: string; score: number; margin: number }
  | { status: 'unknown'; reason: UnknownReason };

/** Selects one from the ranked scores, or returns "unknown". If there is only a single candidate, the margin is treated as infinite. */
export function pickLabel(scores: readonly LabelScore[], thresholds: GuessThresholds): LabelGuess {
  const valid = scores.filter((s) => Number.isFinite(s.score)).sort((x, y) => y.score - x.score);
  const [first, second] = valid;
  if (!first) return { status: 'unknown', reason: 'noCandidates' };
  const margin = second ? first.score - second.score : Number.POSITIVE_INFINITY;
  if (first.score < thresholds.minScore) return { status: 'unknown', reason: 'lowScore' };
  if (margin < thresholds.minMargin) return { status: 'unknown', reason: 'tooClose' };
  return { status: 'label', id: first.id, score: first.score, margin };
}

export type TextFacet = 'kind' | 'topic';

export interface FacetGuesses {
  kind: LabelGuess;
  topic: LabelGuess;
}

/**
 * Determines the form and topic of recognized text. Blank and garbled text do not invoke the
 * model and both dimensions return "unknown". Embedding uses local models (queries must include
 * the same task description as calibration, so they are encoded separately per dimension).
 */
export async function guessFacets(
  text: string,
  embed: (text: string, facet: TextFacet) => Promise<ArrayLike<number>>,
  labels: Readonly<Record<TextFacet, readonly LabelVector[]>>,
  thresholds: Readonly<Record<TextFacet, GuessThresholds>>,
): Promise<FacetGuesses> {
  const readability = textReadability(text);
  if (readability !== 'readable') {
    const unknown: LabelGuess = { status: 'unknown', reason: readability };
    return { kind: unknown, topic: unknown };
  }
  const guess = async (facet: TextFacet): Promise<LabelGuess> => {
    if (labels[facet].length === 0) return { status: 'unknown', reason: 'noCandidates' };
    return pickLabel(rankLabels(await embed(text, facet), labels[facet]), thresholds[facet]);
  };
  return { kind: await guess('kind'), topic: await guess('topic') };
}
