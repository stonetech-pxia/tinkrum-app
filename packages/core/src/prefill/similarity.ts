// Candidate values for new record form (D-394): character similarity between labels and keywords
// (Variant A from measurements, copied from side-session-notes/prefill-ranking/scripts/score.py).
// Case-insensitive, stripping accents and whitespace/punctuation, so OCR swallowed spaces
// ('Amountpaid') and minor typos ('Totel') still match; short Latin words (tel, no, to) must be a
// complete word.

/** Canonical normalization: NFKC, lowercase, strip accents, keep only letters and digits. */
export function norm(s: string): string {
  return unicode(unicode(s, 'NFKC').toLowerCase(), 'NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Return as-is if engine does not support normalize (recognizes fewer accents and full-width characters). */
function unicode(s: string, form: 'NFKC' | 'NFD'): string {
  try {
    return s.normalize(form);
  } catch {
    return s;
  }
}

/** Split into tokens by whitespace and common separators (applying canonical normalization to each token). */
export function tokens(s: string): string[] {
  return s
    .split(/[\s:：/\-–·.,()[\]|]+/)
    .map(norm)
    .filter(Boolean);
}

const CJK = /[㐀-鿿]/;

function grams(s: string): Map<string, number> {
  const n = norm(s);
  const out = new Map<string, number>();
  if (n.length <= 2) {
    if (n) out.set(n, 1);
    return out;
  }
  for (let i = 0; i < n.length - 1; i++) {
    const g = n.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
function shared(a: Map<string, number>, b: Map<string, number>): number {
  let n = 0;
  for (const [g, c] of a) n += Math.min(c, b.get(g) ?? 0);
  return n;
}

const latinShort = (kw: string) => {
  const n = norm(kw);
  return n.length <= 3 && !CJK.test(n);
};

/** Degree to which keyword appears in label: 0.75 * coverage + 0.25 * precision (lower as extra characters in label increase). */
export function charSim(label: string, kw: string): number {
  if (!label || !kw) return 0;
  const nl = norm(label);
  const nk = norm(kw);
  if (!nl || !nk) return 0;
  if (latinShort(kw)) {
    return tokens(label).includes(nk) || nk === nl ? 0.75 + (0.25 * nk.length) / nl.length : 0;
  }
  const gl = grams(label);
  const gk = grams(kw);
  const inter = shared(gk, gl);
  return (0.75 * inter) / Math.max(1, total(gk)) + (0.25 * inter) / Math.max(1, total(gl));
}

/** Excluded term: counts only if almost entirely present in label (coverage >= 0.75), otherwise 0. */
export function charCover(label: string, kw: string): number {
  if (!label || !kw) return 0;
  if (latinShort(kw)) return tokens(label).includes(norm(kw)) ? 1 : 0;
  const gk = grams(kw);
  const cov = shared(gk, grams(label)) / Math.max(1, total(gk));
  return cov >= 0.75 ? cov : 0;
}

/** Give no score for accidental partial character matches (bigram collision): (s - 0.4) / 0.6, clamped to 0..1. */
const A0 = 0.4;

/** Label score 0..1: similarity to the closest keyword (calibrated) minus similarity to the closest exclusion term. */
export function labelScore(
  label: string,
  keywords: readonly string[],
  exclude: readonly string[],
): number {
  if (!label) return 0;
  let p = 0;
  for (const k of keywords) p = Math.max(p, charSim(label, k));
  p = Math.max(0, (p - A0) / (1 - A0));
  let e = 0;
  for (const k of exclude) e = Math.max(e, charCover(label, k));
  return Math.max(0, Math.min(1, p - e));
}

/** Label is explicitly an exclusion term for this field (coverage >= 0.75, same threshold subtracted in labelScore): subtotal, change, discount. */
export function isExcludedLabel(label: string, exclude: readonly string[]): boolean {
  return !!label && exclude.some((k) => charCover(label, k) >= 0.75);
}

/** How similar two text strings are (0..1, edit distance); used for single-choice option comparison (difflib-like approximation). */
export function ratio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}
