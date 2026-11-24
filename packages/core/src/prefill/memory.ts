import type { Field, FieldType } from '../schema';
import { splitLines, type ValueCandidate } from './candidates';
import { amountTier, labelOf, normalizeLabel } from './pick';

// Layout memory (extension of D-244, prototype, not integrated into UI): learns from the values
// finally saved when the user logs an entry (not from prefilled values), remembering "which label
// this field's value follows, approximately which line number, and its formatting pattern". It does
// not record the actual values of amounts and dates; it records text fields that remain constant
// like merchant names, and only fills them if the identical value appears in the text of a new
// file. It does not learn if a value's origin cannot be found in the text, or if multiple
// occurrences make it ambiguous. Saving once constitutes learning (set by founder 2026-10-28); if
// the user modifies the memory-filled value, it is downgraded: requiring two more consistent uses
// before adoption. If any part of a new file mismatches or seems unreasonable against memory,
// prefer leaving it blank (prefill.ts). Stored by field ID; discarded if the field is deleted or
// its type changes. Layout recognition relies primarily on label text (lines appearing consistently
// across saves), while line box positions are used only to pick among multiple values under the
// same label. Stored strictly on-device (whether it is stored, clearable, or included in backups is
// pending decision in the report).

/** A line's position on the image (recognizeText line bounding box, pixels, origin at top-left). When unavailable, position is calculated by line number. */
export interface LineBox {
  y: number;
  height: number;
}

export interface ValueHabit {
  kind: 'amount' | 'date';
  /** Normalized label text. */
  label: string;
  /** 0: label and value are on the same line; 1: label is on the previous line. */
  offset: 0 | 1;
  /** 0-1, approximate height position on the page (line number / total lines, or bounding box y / page height). */
  position: number;
  /** Pattern format: amounts use decimal points (dot / comma / none), dates replace digits with 9s (9/9/9, 9/9/9999). */
  format: string;
  /** Ambiguous numeric date order confirmed by the user; do not guess if absent in old memory. */
  dateOrder?: 'DMY' | 'MDY';
  /** Number of consecutive matches. */
  hits: number;
  /** Required number of consecutive matches before use; defaults to LEARNED_HITS, or 2 after user modification. */
  needs?: number;
}

export interface ConstantHabit {
  kind: 'constant';
  value: string;
  hits: number;
  needs?: number;
}

export type FieldHabit = ValueHabit | ConstantHabit;

export interface LayoutMemory {
  id: string;
  /** Label lines that appear consistently every time (normalized text). */
  anchors: string[];
  fieldTypes: Record<string, FieldType>;
  fields: Record<string, FieldHabit>;
}

/** Saving once constitutes learning. */
export const LEARNED_HITS = 1;
/** Text fields (such as merchant names) require two identical saves before use: seeing them only once makes it impossible to know if they are constant every time. */
export const CONSTANT_HITS = 2;
/** After the user modifies a memory-filled value, it must match this many more times before being used again. */
export const RELEARN_HITS = 2;
/** Whether learning has been achieved. */
export const isLearned = (habit: FieldHabit) => habit.hits >= (habit.needs ?? LEARNED_HITS);
const MAX_ANCHORS = 40;
/** Minimum proportion of memory label lines that must appear in a new file to be considered a potential matching layout. */
export const MIN_LAYOUT_MATCH = 0.6;
/** Apply memory filling only when matching exceeds this threshold; values between the two thresholds represent "similar but not exact": prefer leaving memory-learned fields blank. */
export const SURE_LAYOUT_MATCH = 0.8;
/** Minimum number of label lines required for layout recognition (too few makes anything match). */
const MIN_ANCHORS = 3;

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The label portion of a line (before the first number, minus sign, or colon): e.g., "Invoice
 * date: March 3", "Customer: Mr. Wang", where the trailing part varies each time. Entire lines
 * without numbers or colons (store names, "Thank you") are treated as whole labels.
 */
export function anchorOf(line: string): string {
  const cut = line.search(/[\d:：]|-\s*[$€£¥￥]?\d/);
  return normalizeLabel(cut > 0 ? line.slice(0, cut) : line);
}

/**
 * Label lines in this text: text lines normalized and deduplicated. Excludes label-less amount
 * lines (item lines, varying each time); label-containing amount lines like "Total 98.75" are
 * included with numbers stripped ("Total").
 */
export function layoutAnchors(text: string, candidates: readonly ValueCandidate[]): string[] {
  const lines = splitLines(text);
  const out = new Set<string>();
  lines.forEach((line, i) => {
    if (out.size >= MAX_ANCHORS) return;
    const items = candidates.filter((c) => c.line === i && c.kind === 'amount');
    if (items.some((c) => amountTier(labelOf(lines, c, candidates).text, false) === 0)) return;
    const label = anchorOf(line);
    if (label.length >= 3 || /[\u4e00-\u9fff]{2}/.test(label)) out.add(label);
  });
  return [...out];
}

/** Proportion of memory label lines appearing in this text (accounting for skewed/merged lines via containment ratios). */
export function layoutScore(memory: LayoutMemory, text: string): number {
  if (memory.anchors.length < MIN_ANCHORS) return 0;
  const page = ` ${normalizeLabel(text)} `;
  const found = memory.anchors.filter((a) => page.includes(` ${a} `) || page.includes(a)).length;
  return found / memory.anchors.length;
}

/** The most similar layout and its similarity score; returns null if not similar enough. */
export function matchLayout(
  memories: readonly LayoutMemory[],
  text: string,
): { memory: LayoutMemory; score: number } | null {
  let best: { memory: LayoutMemory; score: number } | null = null;
  for (const memory of memories) {
    const score = layoutScore(memory, text);
    if (score >= MIN_LAYOUT_MATCH && (!best || score > best.score)) best = { memory, score };
  }
  return best;
}

/** The most similar layout; returns null if not similar enough. */
export function findLayout(memories: readonly LayoutMemory[], text: string): LayoutMemory | null {
  return matchLayout(memories, text)?.memory ?? null;
}

/** Table structure changed: discard memories for deleted or type-changed fields. */
export function reconcileLayout(memory: LayoutMemory, fields: readonly Field[]): LayoutMemory {
  const types = new Map(fields.map((f) => [f.id, f.type]));
  const kept = Object.entries(memory.fields).filter(
    ([id]) => types.get(id) === memory.fieldTypes[id],
  );
  return {
    ...memory,
    fieldTypes: Object.fromEntries(kept.map(([id]) => [id, memory.fieldTypes[id]!])),
    fields: Object.fromEntries(kept),
  };
}

function formatOf(c: ValueCandidate): string {
  if (c.kind === 'date') return c.raw.replace(/\d+/g, '9').replace(/\s+/g, '');
  return /,\d{2}\b/.test(c.raw) ? 'comma' : /\.\d{2}\b/.test(c.raw) ? 'dot' : 'none';
}

function positionOf(
  c: ValueCandidate,
  lineCount: number,
  boxes?: readonly (LineBox | null)[],
): number {
  const box = boxes?.[c.line];
  const page = boxes?.reduce((h, b) => (b ? Math.max(h, b.y + b.height) : h), 0) ?? 0;
  if (box && page > 0) return (box.y + box.height / 2) / page;
  return lineCount > 1 ? c.line / (lineCount - 1) : 0;
}

function sameHabit(a: FieldHabit, b: FieldHabit): boolean {
  if (a.kind === 'constant' || b.kind === 'constant')
    return a.kind === 'constant' && b.kind === 'constant' && a.value === b.value;
  return (
    a.kind === b.kind &&
    a.label === b.label &&
    a.offset === b.offset &&
    a.format === b.format &&
    a.dateOrder === b.dateOrder
  );
}

const sameNumber = (a: unknown, b: string) => Math.abs(Number(a) - Number(b)) < 0.005;

/** Origin of the saved value within the text: unique, or disambiguated by a unique matching label among candidates (amounts rely on "paid / total" level). */
function sourceOf(
  kind: 'amount' | 'date',
  saved: unknown,
  lines: readonly string[],
  candidates: readonly ValueCandidate[],
): ValueCandidate | null {
  const hits = candidates.filter(
    (c) => c.kind === kind && (kind === 'amount' ? sameNumber(saved, c.value) : saved === c.value),
  );
  if (hits.length <= 1) return hits[0] ?? null;
  // Frequency of appearance: dates are ambiguous; amounts are recognized only if a single-occurrence label sits at the "paid / total" level.
  if (kind === 'date') return null;
  const labels = hits.map((c) => labelOf(lines, c, candidates));
  const changeOnPage = lines.some((l) => /找零|找赎|\bchange\b|rendu|monnaie/i.test(l));
  const tiers = labels.map((l) => amountTier(l.text, changeOnPage));
  const top = Math.max(...tiers);
  const best = hits.filter((_, i) => tiers[i] === top);
  return top >= 2 && best.length === 1 ? best[0]! : null;
}

export interface LearnInput {
  text: string;
  /** Fields of this table (learns only amounts, dates, and text fields). */
  fields: readonly Field[];
  /** Values finally saved by the user (field ID -> value). */
  saved: Readonly<Record<string, unknown>>;
  /** Prefilled values and their sources for this run; memory-filled values are downgraded if modified by the user. */
  prefilled?: Readonly<Record<string, { value: unknown; source: string }>>;
  candidates: readonly ValueCandidate[];
  boxes?: readonly (LineBox | null)[];
}

/**
 * Record a save event. memory is the layout found by findLayout (pass null if none, starting a
 * new one); returns null (not stored) if no fields can be learned or too few label lines prevent
 * layout recognition.
 */
export function learnLayout(
  memory: LayoutMemory | null,
  input: LearnInput,
  id: string,
): LayoutMemory | null {
  const lines = splitLines(input.text);
  const anchors = layoutAnchors(input.text, input.candidates);
  const kept = memory ? reconcileLayout(memory, input.fields) : null;
  const fields: Record<string, FieldHabit> = { ...(kept?.fields ?? {}) };
  const fieldTypes: Record<string, FieldType> = { ...(kept?.fieldTypes ?? {}) };
  for (const field of input.fields) {
    const saved = input.saved[field.id];
    const before = fields[field.id];
    const filled = input.prefilled?.[field.id];
    const corrected =
      filled?.source === 'memory' &&
      (field.type === 'money' ? !sameNumber(saved, String(filled.value)) : filled.value !== saved);
    let seen: FieldHabit | null = null;
    if (field.type === 'money' || field.type === 'date') {
      const kind = field.type === 'money' ? 'amount' : 'date';
      const source =
        saved === null || saved === undefined || saved === ''
          ? null
          : sourceOf(kind, saved, lines, input.candidates);
      if (source) {
        const label = labelOf(lines, source, input.candidates);
        seen = {
          kind,
          label: label.text,
          offset: label.offset,
          position: positionOf(source, lines.length, input.boxes),
          format: formatOf(source),
          ...(source.dateOrder ? { dateOrder: source.dateOrder } : {}),
          hits: 1,
        };
      }
    } else if (field.type === 'text' && typeof saved === 'string' && saved.trim()) {
      // Text fields cannot be known to be constant when seen only once (merchant name is constant, order number varies each time): requires two identical occurrences before use.
      if (squash(input.text).includes(squash(saved)))
        seen = { kind: 'constant', value: saved.trim(), hits: 1, needs: CONSTANT_HITS };
    }
    if (corrected) {
      // User modified a memory-filled value: downgrade, restart learning from this observation, and require two consistent matches before reusing (skip until source is visible).
      if (seen) fields[field.id] = { ...seen, needs: RELEARN_HITS };
      else if (before) fields[field.id] = { ...before, hits: 0, needs: RELEARN_HITS };
    } else if (seen && before && sameHabit(before, seen)) {
      fields[field.id] = {
        ...seen,
        hits: Math.min(before.hits + 1, 9),
        ...(before.needs ? { needs: before.needs } : {}),
      };
    } else if (seen) {
      fields[field.id] = seen;
    }
    if (fields[field.id]) fieldTypes[field.id] = field.type;
  }
  // Layout label lines: all lines initially, retaining only consistently appearing ones thereafter (lines like item names that vary each time are filtered out).
  const page = ` ${normalizeLabel(input.text)} `;
  const nextAnchors = kept ? kept.anchors.filter((a) => page.includes(a)) : anchors;
  if (Object.keys(fields).length === 0 || nextAnchors.length < MIN_ANCHORS) return null;
  return { id: kept?.id ?? id, anchors: nextAnchors, fieldTypes, fields };
}

/** Read a field using learned layouts; returns null if unreadable or ambiguous (fallback to label rules or leave blank). */
export function readWithLayout(
  habit: FieldHabit,
  text: string,
  candidates: readonly ValueCandidate[],
  boxes?: readonly (LineBox | null)[],
): string | null {
  if (!isLearned(habit)) return null;
  if (habit.kind === 'constant')
    return squash(text).includes(squash(habit.value)) ? habit.value : null;
  const lines = splitLines(text);
  const matches = candidates
    .filter((c) => c.kind === habit.kind && formatOf(c) === habit.format)
    .filter(
      (c) =>
        !c.dateOrder ||
        c.dateOrder === habit.dateOrder ||
        (habit.dateOrder === undefined &&
          !candidates.some(
            (other) =>
              other !== c &&
              other.kind === 'date' &&
              other.line === c.line &&
              other.start === c.start &&
              other.end === c.end &&
              other.value !== c.value,
          )),
    )
    .filter((c) => {
      const label = labelOf(lines, c, candidates);
      return label.offset === habit.offset && label.text === habit.label;
    })
    .map((c) => ({ c, distance: Math.abs(positionOf(c, lines.length, boxes) - habit.position) }));
  if (new Set(matches.map(({ c }) => c.value)).size <= 1) return matches[0]?.c.value ?? null;
  // Multiple different values under the same label: pick the one closest in position; leave blank if the closest two are equidistant.
  matches.sort((a, b) => a.distance - b.distance);
  return matches[1]!.distance - matches[0]!.distance > 0.1 ? matches[0]!.c.value : null;
}
