import { hasRecordCurrency } from '../money-currency';
import type { Field, Locale } from '../schema';
import { CONCEPTS, fieldTerms, type ConceptId, type ValueKind } from './concepts';
import { fieldNameKey } from './field-names';
import { looksTyped, pageOccurrences, type Occurrence, type TextPage } from './rows';
import { ctx, receiptRules } from './doc-context';
import {
  adjustTerms,
  amountSet,
  extraSumRow,
  extraWholeNumbers,
  isExcludedX,
  isInvoiceText,
  labelScoreX,
  reorderTiedAmounts,
  sellerLabelScore,
  taxAddCheck,
  taxRateCheck,
} from './rules';
import * as D from './rules-data';
import {
  cleanMerchant,
  companyRow,
  isTitleRow,
  POWERED,
  sellerClientName,
  weakStore,
} from './rules-text';
import { charSim, norm, ratio } from './similarity';

// Candidate values for the new record form (D-394): at most 3 candidates given for each empty
// field, filled only when the user taps, never automatically filled (founder 2026-10-31: "better
// empty than wrong", neither measurement could find a 0-error threshold). Scoring copies variant A
// of the measurements (side-session-notes/prefill-ranking/scripts/score.py): 3 * label + 3 * memory
// + 1 * uniqueness + 1 * plausibility + 1 * position, each ranging from 0..1. No vector models are
// used; everything is on-device; recognized text, file names, and records are never sent to cloud
// AI. Only rule-based scoring is performed here: arithmetic, Chinese rules, and value memory are in
// code-rules.ts, and the on-device model (D-396) is in model.ts.

/** A learned label for this field (normalized spelling, see fieldNameKey). */
export interface LearnedLabel {
  label: string;
  /** The reading chosen by the user for dates following this label where day and month are ambiguous. */
  order?: 'DMY' | 'MDY';
  /** The user tapped a different value when this label appeared: retained, but no longer ranked first. */
  rejected?: true;
}

/** Candidates previously tapped by the user: which label-following position and vertical page height were tapped last time for this field in this table (does not record the value itself). */
export interface FieldPick {
  label: string;
  relY: number;
  /** The reading chosen by the user for ambiguous day/month dates. */
  order?: 'DMY' | 'MDY';
  /** Learned labels for this field, most recently tapped first. Older memory lacks this, at which point it counted as having one learned label. */
  labels?: readonly LearnedLabel[];
}

/** Maximum number of learned labels remembered per field: discards the least recently tapped when exceeded. */
export const MAX_LEARNED_LABELS = 20;

/** Learned labels for this field, most recently tapped first. */
export function learnedLabels(pick: FieldPick | undefined): readonly LearnedLabel[] {
  if (!pick) return [];
  if (pick.labels) return pick.labels;
  const label = fieldNameKey(pick.label);
  return label ? [{ label, ...(pick.order ? { order: pick.order } : {}) }] : [];
}

/**
 * Memory after the user taps a candidate: records the label at this location under the field;
 * previously top-ranked learned labels not tapped by the user are no longer ranked first. New
 * labels are not learned if this value cannot be located in the text (no pick). Returns undefined
 * when nothing changes.
 */
export function rememberPick(
  previous: FieldPick | undefined,
  tapped: ValueSuggestion,
  shown: readonly ValueSuggestion[],
): FieldPick | undefined {
  const keep = new Set(tapped.learned ?? []);
  const passed = new Set(shown.flatMap((s) => s.learned ?? []).filter((l) => !keep.has(l)));
  let labels = learnedLabels(previous).map((l) =>
    passed.has(l.label) ? { ...l, rejected: true as const } : l,
  );
  const pick = tapped.pick;
  if (!pick) return previous && passed.size > 0 ? { ...previous, labels } : undefined;
  const label = fieldNameKey(pick.label);
  if (label) {
    const old = labels.find((l) => l.label === label);
    labels = [
      {
        label,
        ...(pick.order ? { order: pick.order } : {}),
        ...(old?.rejected ? { rejected: true as const } : {}),
      },
      ...labels.filter((l) => l !== old),
    ].slice(0, MAX_LEARNED_LABELS);
  }
  return { ...pick, labels };
}

export interface ValueSuggestion {
  /** Representation in the form: amounts and numbers are text, dates are YYYY-MM-DD, single-selects are option IDs. */
  value: string;
  score: number;
  /** Recorded after a tap (FieldPick). Absent when this value cannot be located in the text, and not recorded on tap. */
  pick?: FieldPick;
  /** Learned labels that caused this value to rank high. */
  learned?: readonly string[];
  /** Confident (only for spoken input, D-575): filled directly into the form without waiting for user taps. */
  sure?: boolean;
}

export interface SuggestInput {
  fields: readonly Field[];
  /** prefillRules for this table: which set of rules to use in addition to general rules (D-421). */
  rules?: 'receipt' | 'card';
  pages: readonly TextPage[];
  /** The text is what the user spoke for this entry (speech-to-text, D-575), not read from a file: reads spoken values according to field type, ignoring layout. */
  spoken?: boolean;
  /** Language used for recognition (when day/month is ambiguous, only affects sorting order; both are provided). */
  locale: Locale;
  /** Last-tapped items for each field in this table (field ID -> FieldPick). */
  picks?: Readonly<Record<string, FieldPick>>;
  /** Stored store names and companies for this table (field ID -> value, queried on the fly, see knownValues); treated as candidates if appearing verbatim in the text. */
  known?: Readonly<Record<string, readonly string[]>>;
  /** Namecard table (rules: card): text read from attachments' QR codes (D-423). vCard/MeCard values and URLs are placed at the very front of each field's candidates. */
  codes?: readonly string[];
  now?: Date;
}

/** Maximum number of candidates per field. */
export const MAX_SUGGESTIONS = 3;
/**
 * Scores below this are not displayed (only points for uniqueness and plausibility, with no
 * contribution from labels, memory, or position). Determined from measurement data: 99.6% of
 * correct top-three predictions across all data are above 1.25, halving errors; for real receipts
 * (150 SROIE images), correct top-three amounts drop from 95 to 90, dates from 131 to 126. At a
 * threshold of 1.5, SROIE amounts drop to just 80; 2.0 drops a standalone unlabeled date, so
 * neither is used.
 */
export const SUGGESTION_FLOOR = 1.25;
/** Minimum score for tax amount candidates: tax amounts mostly have a "tax" label; numbers without labels rely on coincidence, so it is better left blank. */
const TAX_FLOOR = 2;

const GENERIC = [
  'receipt',
  'invoice',
  'tax invoice',
  'official receipt',
  'cash bill',
  'cash sale',
  'simplified tax invoice',
  'bill',
  'ticket',
  'order',
  'welcome',
  'thank you',
  'note',
  'handwritten note',
  'handwritten',
  'sample',
  'sample document',
  'test',
  'test only',
  'copy',
  '欢迎光临',
  '增值税普通发票',
  '增值税专用发票',
  '增值税电子普通发票',
  '发票',
  '收据',
  '小票',
  '谢谢惠顾',
  '感谢惠顾',
  '欢迎再次光临',
  '合同',
  '账单',
  '样本',
  '测试',
  'facture',
  'reçu',
  'ticket de caisse',
  'bienvenue',
  'merci',
  'contrat',
  'échantillon',
].map(norm);
const isGeneric = (n: string) =>
  GENERIC.some((g) => n === g || (n.includes(g) && n.length <= g.length + 4));
/**
 * Old approach (prior to D-403): still used for non-receipt documents (namecards, others). Words
 * that receive a position score of 0: generic document labels, document names ("receipt"),
 * "Powered by", too short/long, high digit density, URLs/emails, or appearing to be another
 * category. Address lines are no longer excluded based on street number, country, or state
 * patterns: measurements showed lines with address words accounted for 8.6% of real store name
 * lines and 7.2% of lines directly above them, which cannot be separated; excluding them directly
 * discards real store names.
 */
// Old approach (prior to D-403): still used for non-receipt documents (namecards, others).
const ADDRESS_OLD =
  /\b(street|st|road|rd|jalan|jln|lorong|taman|avenue|ave|rue|bd|boulevard|no|lot|blok|block)\b|[路街号巷弄区]/i;
const ADDRESS_ONLY_OLD =
  /(,.*\b\d{4,6}\b|\b\d{4,6}\b.*,)|\b(malaysia|singapore|selangor|johor|kuala lumpur|china|france|usa|united states|canada|australia|cedex)\b|中国|[省市县]/i;
function positionZero(text: string, locale: Locale): boolean {
  const n = norm(text);
  if (isGeneric(n)) return true;
  if (receiptRules() && (isTitleRow(text) || POWERED.test(text))) return true;
  if (n.length <= 2 || text.split(/\s+/).length > 8 || text.length > 45) return true;
  if (!receiptRules()) {
    if (/\d/.test(text) && ADDRESS_OLD.test(text)) return true;
    if (ADDRESS_ONLY_OLD.test(text)) return true;
  }
  if ([...n].filter((c) => /\d/.test(c)).length > 0.3 * n.length) return true;
  if (/@|www\.|https?:|\.com\b/i.test(text)) return true;
  return looksTyped(text, locale);
}

const hasLetter = /\p{L}/u;
/** Value of a text field: at least two characters, at most 40, contains letters, digits do not exceed 30%, and is not a generic label like "Invoice" or "Tax invoice". */
function textOk(v: string): boolean {
  const n = norm(v);
  if (n.length < 2 || v.length > 40 || !hasLetter.test(v) || isGeneric(n)) return false;
  return [...n].filter((c) => /\d/.test(c)).length <= 0.3 * n.length;
}

/** The type of value required by the field; null for fields that do not provide candidates. */
function wantOf(field: Field, concept: ConceptId | null): ValueKind | 'choice' | null {
  switch (field.type) {
    case 'money':
    case 'number':
      return 'money';
    case 'date':
      return 'date';
    case 'choice':
      return 'choice';
    case 'text':
    case 'note':
      return (concept && CONCEPTS[concept].kind) || 'text';
    default:
      return null;
  }
}

function choiceOf(value: string, options: readonly { id: string; label: string }[]): string | null {
  const nv = norm(value);
  let best = 0;
  let id: string | null = null;
  for (const o of options) {
    const no = norm(o.label);
    const s = nv === no ? 1 : nv.length >= 3 ? ratio(nv, no) : 0;
    if (s > best) {
      best = s;
      id = o.id;
    }
  }
  return best >= 0.85 ? id : null;
}

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const YEAR = 365.25 * 24 * 3600 * 1000;

interface Candidate {
  value: string;
  occ: Occurrence[];
  order?: 'DMY' | 'MDY';
  score: number;
  /** Score when there is no memory: whether it qualifies as a candidate. */
  base: number;
  first: number;
  /** Date falls within the reasonable window. */
  plaus?: boolean;
}

const NO_DECIMAL_CCY = ['JPY', 'KRW', 'IDR', 'VND', 'CLP'];
/** When all amounts in the entire text have two decimal places, total candidates written as integers (order numbers, quantities, years) are penalized by 1 point (penalized in both score and threshold). */
function demoteWholeNumbers(cands: Candidate[]): void {
  const live = cands.filter((c) => c.score > 0 && Number.isFinite(Number(c.value)));
  const decimalsOf = (o: Occurrence) => o.raw.replace(/[^\d.,]/g, '');
  const hasDec = live.some((c) => c.occ.some((o) => /[.,]\d{2}$/.test(decimalsOf(o))));
  if (!hasDec || NO_DECIMAL_CCY.includes(ctx.currency)) return;
  for (const c of live) {
    if (c.occ.every((o) => !/[.,]\d{1,2}$/.test(decimalsOf(o)))) {
      c.score -= 1;
      c.base -= 1;
    }
  }
}

/** Context required by date and amount parsing rules: currency, entire text, current year, and whether it is an invoice. */
export function setDocContext(input: SuggestInput): void {
  // Rule set specified on the table (D-421): subsequent rules check ctx.kind; defaults to general rules only if unassigned.
  ctx.kind = input.rules ?? 'other';
  ctx.nowYear = (input.now ?? new Date()).getUTCFullYear();
  ctx.text = input.pages.flatMap((p) => p.lines.map((l) => l.text)).join('\n');
  ctx.invoice = receiptRules() && isInvoiceText(ctx.text);
  // When currencies are chosen per entry (D-429), the currency on the field does not indicate which country the receipt belongs to.
  ctx.currency = input.fields.some(hasRecordCurrency)
    ? ''
    : ((
        input.fields.find((f) => f.type === 'money' && (f as { currency?: string }).currency) as
          { currency?: string } | undefined
      )?.currency ?? '');
}

/** Candidates for all fields (field ID -> ordered by score descending, up to 3). Provided only for fillable fields; empty fields are chosen by the caller. */
export function suggestValues(input: SuggestInput): Record<string, ValueSuggestion[]> {
  const now = input.now ?? new Date();
  setDocContext(input);
  const pages = input.pages.map((p, i) => pageOccurrences(p, i, input.locale));
  const occ = pages.flatMap((p) => p.occ);
  const rowText = (o: Occurrence) => pages[o.page]!.rows[o.row]?.text ?? '';
  // Dates with a single reading: used to judge whether other dates are reasonable (document date), defaulting to the present if absent.
  const readings = new Map<string, number>();
  for (const o of occ)
    if (o.kind === 'date') {
      const k = `${o.page}|${o.row}|${o.raw}`;
      readings.set(k, (readings.get(k) ?? 0) + 1);
    }
  const anchors = [
    ...new Set(
      occ
        .filter((o) => o.kind === 'date' && readings.get(`${o.page}|${o.row}|${o.raw}`) === 1)
        .map((o) => o.value),
    ),
  ];

  const out: Record<string, ValueSuggestion[]> = {};
  for (const field of input.fields) {
    const terms = fieldTerms(field);
    const concept = terms.concept;
    // Term lists for totals, tax amounts, and store names supplemented by rules; "Printed" is no longer an exclusion word for invoice dates (print dates are instead sorted last).
    const adjusted = adjustTerms(concept, terms.keywords, terms.exclude);
    const keywords = adjusted.kw;
    const exclude =
      concept === 'issueDate' && receiptRules()
        ? adjusted.ex.filter((e) => e !== 'printed')
        : adjusted.ex;
    const scoreLabel = (label: string) => labelScoreX(concept, label, keywords, exclude);
    const isExcluded = (label: string) => isExcludedX(concept, label, exclude);
    const want = wantOf(field, concept);
    if (!want) continue;
    // Find two additional candidate types for totals and tax amounts: integers following labels, and numbers in an "A + B = C" row.
    let occF = occ;
    if (receiptRules() && want === 'money' && (concept === 'amount' || concept === 'tax')) {
      const extra = [
        ...extraWholeNumbers(pages, scoreLabel, isExcluded),
        ...extraSumRow(concept, pages, scoreLabel, isExcluded),
      ];
      if (extra.length) occF = occ.concat(extra);
    }
    const longAhead = concept === 'dueDate' || concept === 'signDate';
    // Whether a date is reasonable: falls within 10 years before to 1 year after "present";
    // otherwise checks other dates on the document (document dates). If any other dates fall within
    // the window, only those are used as reference (preventing a print date or expiration date from
    // distorting the reference).
    const plausibleDate = (v: string) => {
      const t = day(v);
      if (!receiptRules()) {
        const old = anchors.filter((a) => a !== v).map(day);
        if (old.length > 0)
          return t >= Math.min(...old) - YEAR && t <= Math.max(...old) + 10 * YEAR;
        return t >= now.getTime() - 10 * YEAR && t <= now.getTime() + (longAhead ? 10 : 1) * YEAR;
      }
      const n = now.getTime();
      const inWindow = (u: number) => u >= n - 10 * YEAR && u <= n + (longAhead ? 10 : 1) * YEAR;
      if (inWindow(t)) return true;
      const pool = anchors.filter((a) => a !== v);
      const fresh = pool.filter((a) => inWindow(day(a)));
      const others = (fresh.length > 0 ? fresh : pool).map(day);
      if (others.length === 0) return false;
      return t >= Math.min(...others) - YEAR && t <= Math.max(...others) + 10 * YEAR;
    };

    // Merges identical values (amounts by two decimal places, dates along with their reading style, text by normalized spelling).
    const byKey = new Map<string, Candidate>();
    for (const o of occF) {
      let value: string;
      let key: string;
      if (want === 'choice') {
        if (o.kind !== 'text' || o.other || field.type !== 'choice') continue;
        const id = choiceOf(o.value, field.options);
        if (!id) continue;
        value = id;
        key = id;
      } else if (o.kind !== want) continue;
      else if (want === 'text') {
        if (o.other || !textOk(o.value)) continue;
        if (receiptRules() && concept === 'merchant' && POWERED.test(rowText(o))) continue;
        value = o.value.trim();
        if (receiptRules() && concept === 'merchant') {
          value = cleanMerchant(value);
          if (!textOk(value)) continue;
        }
        key = norm(value);
      } else if (want === 'money') {
        const n = Number(o.value);
        value = o.value;
        key = n.toFixed(2);
      } else if (want === 'date') {
        value = o.value;
        key = `${o.value}|${o.dateOrder ?? ''}`;
      } else {
        // Fill phone numbers and numbers in their original format (with spaces and parentheses), and emails in lowercase.
        value = want === 'email' ? o.value : o.raw.trim();
        key = o.value;
      }
      const c = byKey.get(key);
      if (c) c.occ.push(o);
      else
        byKey.set(key, {
          value,
          occ: [o],
          ...(o.dateOrder ? { order: o.dateOrder } : {}),
          score: 0,
          base: 0,
          first: 0,
        });
    }
    const cands = [...byKey.values()];
    const n = cands.length;
    const pick = input.picks?.[field.id];
    const position = concept !== null && CONCEPTS[concept].position === true;
    for (const c of cands) {
      // Values where every occurrence follows an exclusion word (subtotal, discount, change) are omitted: they are explicitly not what the field requires.
      if (c.occ.every((o) => isExcluded(o.label))) continue;
      let L = Math.max(
        ...c.occ.map(
          (o) =>
            scoreLabel(o.label) * (receiptRules() && position && weakStore(o.label) ? 0.25 : 1),
        ),
      );
      // Fields relying on position like store names: if the label score is below 0.6, it is treated
      // as having no label. When a preceding row is mistaken for a label, a slogan sharing a few
      // matching letter pairs with store/shop can also score a fraction of a point, which when
      // multiplied by 3 overrides the position score and places the slogan before the store name.
      if (receiptRules() && position && L < 0.6) L = 0;
      // Invoice: Issuer labels (Remit to, Supplier, From, etc.) are scored by whole word.
      if (ctx.invoice && position) L = Math.max(L, ...c.occ.map((o) => sellerLabelScore(o.label)));
      const U = 1 / n;
      let P = 1;
      if (want === 'money') {
        const v = Number(c.value);
        P = v > 0 && v < 100000 && c.occ.some((o) => o.raw.replace(/\D/g, '').length < 9) ? 1 : 0;
      } else if (want === 'date') P = plausibleDate(c.value) ? 1 : 0;
      let M = 0;
      if (pick) {
        for (const o of c.occ) {
          // When the last click was on an unlabeled row (store name), only consider rows that are similarly unlabeled and not addresses or the like.
          const ls =
            !pick.label && !o.label
              ? want === 'text' && positionZero(rowText(o), input.locale)
                ? 0
                : 1
              : pick.label && o.label
                ? charSim(o.label, pick.label)
                : 0;
          const ps = Math.max(0, 1 - Math.abs(o.relY - pick.relY) / 0.1);
          // Text alone isn't memorized based solely on similar height: if labels don't match at all, give no memory score.
          let m = want === 'text' && ls === 0 ? 0 : 0.5 * ls + 0.5 * ps;
          if (pick.order && c.order && pick.order !== c.order) m *= 0.5;
          M = Math.max(M, m);
        }
      }
      let X = 0;
      // Position score when there is no memory: whether a candidate qualifies depends only on this; memory only reorders (positions clicked for other stores cannot bring in new candidates).
      let X0 = 0;
      if (position) {
        for (const o of c.occ) {
          if (
            o.label ||
            positionZero(o.value, input.locale) ||
            positionZero(rowText(o), input.locale)
          )
            continue;
          if (o.page === 0 && o.row < 3) X0 = Math.max(X0, (3 - o.row) / 3);
          if (pick) {
            // Remembered position replaces 'top three rows'.
            if (!pick.label) X = Math.max(X, Math.max(0, 1 - Math.abs(o.relY - pick.relY) / 0.1));
          } else if (o.page === 0 && o.row < 3) X = Math.max(X, (3 - o.row) / 3);
        }
      }
      // For text fields, 'unique' and 'reasonable' are not enough: rows where labels, memory, and
      // position are all absent are given 0 points (e.g. store names, addresses, and other useless
      // candidates listed under 'Remarks' or 'Reason', observed on iOS Simulator 2026-10-31).
      c.score = want === 'text' && L === 0 && M === 0 && X === 0 ? 0 : 3 * L + 3 * M + U + P + X;
      c.base = want === 'text' && L === 0 && X0 === 0 ? 0 : 3 * L + U + P + X0;
      c.first = Math.min(...c.occ.map((o) => o.page * 10000 + o.row));
      if (want === 'date') c.plaus = P === 1;
      // When no tax keyword appears anywhere in the text, tax candidates without a label score are likely something else: penalize by 1 point (deducting from both score and threshold).
      if (receiptRules() && concept === 'tax' && L === 0 && !D.TAX_WORD.test(ctx.text)) {
        c.score -= 1;
        c.base -= 1;
      }
    }
    if (receiptRules() && want === 'money' && concept === 'amount') demoteWholeNumbers(cands);
    if (receiptRules() && concept === 'tax') {
      const amounts = amountSet(occF);
      taxRateCheck(cands, rowText, amounts);
      taxAddCheck(cands, amounts);
      // Score differences under 0.05 are treated as ties; for tied tax amounts, take the smaller one (larger ones are usually tax-inclusive totals).
      cands.sort((a, b) =>
        Math.abs(b.score - a.score) >= 0.05
          ? b.score - a.score
          : Number(a.value) - Number(b.value) || a.first - b.first,
      );
    } else cands.sort((a, b) => b.score - a.score || a.first - b.first);
    if (receiptRules() && concept === 'amount') {
      const reordered = reorderTiedAmounts(cands);
      cands.length = 0;
      cands.push(...reordered);
    }
    if (receiptRules() && concept === 'issueDate') {
      // 'Printed' date rows are sorted to the end.
      const isPrint = (c: Candidate) =>
        c.occ.every((o) => {
          const row = rowText(o);
          const at = row.indexOf(o.raw);
          return (
            D.PRINT_WORD.test(o.label) ||
            (at > 0 && D.PRINT_WORD.test(row.slice(Math.max(0, at - 30), at)))
          );
        });
      const keep = cands.filter((c) => !isPrint(c));
      const back = cands.filter(isPrint);
      cands.length = 0;
      cands.push(...keep, ...back);
    }
    // Higher threshold for tax amounts (2 points): numbers without labels, tax rates, or addition proofs do not qualify as tax.
    const floor =
      receiptRules() && concept === 'tax'
        ? Math.max(SUGGESTION_FLOOR, TAX_FLOOR)
        : SUGGESTION_FLOOR;
    // Below threshold, but if it falls in the top quarter of the page and is a standalone row or a reasonable date with a month name, accept it.
    const lowOk = (c: Candidate) =>
      receiptRules() &&
      want === 'date' &&
      c.plaus === true &&
      c.occ.some(
        (o) =>
          o.page === 0 &&
          o.relY <= 0.25 &&
          (rowText(o).trim().length <= o.raw.trim().length + 3 || /[A-Za-z]{3}/.test(o.raw)),
      );
    const list: ValueSuggestion[] = [];
    for (const c of cands) {
      if (list.length >= MAX_SUGGESTIONS) break;
      if (c.base < floor && !lowOk(c)) continue;
      // For the same value (e.g., when one of two readings matches a date elsewhere), keep only the highest scoring one.
      if (list.some((s) => s.value === c.value)) continue;
      // The recorded occurrence: highest label score first, then topmost.
      const best = [...c.occ].sort(
        (a, b) => scoreLabel(b.label) - scoreLabel(a.label) || a.page - b.page || a.row - b.row,
      )[0]!;
      list.push({
        value: c.value,
        score: c.score,
        pick: {
          label: best.label,
          relY: Math.round(best.relY * 1000) / 1000,
          ...(c.order ? { order: c.order } : {}),
        },
      });
    }
    if (receiptRules() && concept === 'merchant') {
      // When there are fewer than 3 candidates, if there is a single row with a company suffix (LLC, GmbH, Inc., etc.) in the text, add it as the last candidate.
      if (list.length < 3) {
        const hits: { text: string; relY: number }[] = [];
        for (const pg of pages) for (const r of pg.rows) if (companyRow(r.text)) hits.push(r);
        const only = hits.length === 1 ? hits[0]! : null;
        const text = only ? cleanMerchant(only.text.trim()) : '';
        if (only && textOk(text) && !list.some((s) => norm(s.value) === norm(text)))
          list.push({
            value: text,
            score: 0,
            pick: { label: '', relY: Math.round(only.relY * 1000) / 1000 },
          });
      }
      // Invoice header 'Seller: Client:': the first cell in the row below is the seller, ranked first.
      const name = sellerClientName(pages);
      if (name && textOk(name.text)) {
        const rest = list.filter((s) => norm(s.value) !== norm(name.text));
        list.length = 0;
        list.push({ value: name.text, score: 99, pick: { label: '', relY: name.relY } }, ...rest);
        list.length = Math.min(list.length, MAX_SUGGESTIONS);
      }
    }
    if (list.length > 0) out[field.id] = list;
  }
  return out;
}
