import { splitLines, type ValueCandidate } from './candidates';

// Labels preceding candidates: text immediately preceding it on the same line; if only symbols are
// present, use the previous line (when two columns are split and the label is on its own line).
// When no layout memory is available, pick by label (extension of D-244): amounts prioritize
// "Actual paid / Amount payable / Total TTC / Amount paid", excluding subtotal, discount, change,
// cash, tax, HT; dates exclude expiration, delivery, print; when multiple dates are ambiguous,
// prioritize "Invoice date" categories. Leave blank if nothing can be picked, never guess: numbers
// without labels are ignored, and if two equally plausible claims have different values, neither is
// taken.

/** Label preceding a candidate: text preceding it on the same line; if only symbols are present, use the previous line (two columns split, label on its own line). */
export interface CandidateLabel {
  /** Normalized label text (lowercase, stripped of numbers, currency symbols, and punctuation). */
  text: string;
  /** 0: same line; 1: previous line. */
  offset: 0 | 1;
}

const STRIP = /[\d$€£¥￥元:：.,;·•*#()[\]{}<>|=_\-–—/\\'"«»“”]+/g;

export function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
}

const hasWords = (s: string) => /[a-zà-ÿ一-鿿]{2,}|[一-鿿]/i.test(s);

export function labelOf(
  lines: readonly string[],
  candidate: ValueCandidate,
  all: readonly ValueCandidate[],
): CandidateLabel {
  const line = lines[candidate.line] ?? '';
  // Only the text following other candidates on the same line ("Subtotal 98.75 Actual paid 90.25") serves as its label.
  const before = all
    .filter((c) => c.line === candidate.line && c.end <= candidate.start)
    .reduce((from, c) => Math.max(from, c.end), 0);
  const same = normalizeLabel(line.slice(before, candidate.start));
  // If a value already precedes it on the same line (table row: quantity, unit price, amount): its label is the table header, do not look at the previous line.
  if (hasWords(same) || before > 0) return { text: same, offset: 0 };
  for (let i = candidate.line - 1; i >= 0; i--) {
    const prev = lines[i]!;
    if (!prev.trim()) continue;
    const label = normalizeLabel(prev);
    const prevHasValue = all.some((c) => c.line === i && c.kind === candidate.kind);
    return !prevHasValue && hasWords(label)
      ? { text: label, offset: 1 }
      : { text: same, offset: 0 };
  }
  return { text: same, offset: 0 };
}

// ---- Amount ----

const AMOUNT_EXCLUDE =
  /小计|优惠|折扣|减免|立减|找零|找赎|零钱|现金|积分|余额|押金|小费|税|单价|数量|原价|subtotal|sub total|discount|saving|saved|coupon|promo|\bchange\b|\bcash\b|tender|\btip\b|gratuity|deposit|points|previous|\btax\b|\bvat\b|unit price|\bqty\b|sous total|\bht\b|hors tax|remise|réduction|rabais|rendu|monnaie|espèces|\btva\b|acompte|pourboire|déjà|already paid|prix unitaire|économie/;
// Final / amount to be paid.
const AMOUNT_FINAL =
  /实付|应付|应收|付款金额|支付金额|价税合计|实际支付|本次支付|amount paid|total paid|grand total|balance due|amount due|total due|to pay|net à payer|net a payer|\bttc\b|à payer|a payer|à régler|a régler|total payé|montant payé|montant dû|montant total|total à/;
// General total.
const AMOUNT_TOTAL = /合计|总计|总额|总价|总金额|实收|金额|\btotal\b|\bmontant\b|\bsum\b|\bsomme\b/;
// Card, QR code, or similar payment lines: used only when there is no total.
const AMOUNT_PAYMENT =
  /visa|mastercard|master card|amex|\bcb\b|carte|\bcard\b|debit|crédit|credit|微信|支付宝|银联|刷卡|apple pay|google pay|payé par|paid by/;
// When change is present, "Actual received / Collected / received" represents cash received rather than the amount.
const CHANGE = /找零|找赎|\bchange\b|rendu|monnaie/;
const TENDER = /实收|收款|received|reçu/;

/** Classify amount candidates by label tier: 3 final payable, 2 total, 1 payment line, 0 unlabeled, -1 excluded. */
export function amountTier(label: string, changeOnPage: boolean): number {
  if (!label) return 0;
  if (AMOUNT_EXCLUDE.test(label)) return -1;
  if (changeOnPage && TENDER.test(label)) return -1;
  if (AMOUNT_FINAL.test(label)) return 3;
  if (AMOUNT_TOTAL.test(label)) return 2;
  if (AMOUNT_PAYMENT.test(label)) return 1;
  return 0;
}

/** Pick from the highest tier: fill only if this tier has a single value (can appear multiple times); leave blank if values differ. Negative numbers are not picked. */
function pickByTier(scored: { c: ValueCandidate; tier: number }[]): ValueCandidate | null {
  const usable = scored.filter((s) => s.tier > 0 && Number(s.c.value) > 0);
  if (usable.length === 0) return null;
  const top = Math.max(...usable.map((s) => s.tier));
  const best = usable.filter((s) => s.tier === top);
  const values = new Set(best.map((s) => Number(s.c.value).toFixed(2)));
  if (values.size !== 1) return null;
  // Rules take precedence: if a rule candidate exists for the same value, use it.
  return (best.find((s) => s.c.source === 'rule') ?? best[0]!).c;
}

const hasCents = (c: ValueCandidate) => /[.,]\d{2}\s*\D*$/.test(c.raw.trim());

export function pickAmount(
  text: string,
  candidates: readonly ValueCandidate[],
): ValueCandidate | null {
  const lines = splitLines(text);
  const changeOnPage = lines.some((l) => CHANGE.test(l.toLowerCase()));
  // When all amounts on the page have two decimal places, those without decimals (31362 €) likely missed the decimal point: do not pick, prefer leaving blank.
  const withCents = candidates.some((c) => c.kind === 'amount' && hasCents(c));
  const amounts = candidates.filter((c) => c.kind === 'amount' && (!withCents || hasCents(c)));
  return pickByTier(
    amounts.map((c) => ({ c, tier: amountTier(labelOf(lines, c, candidates).text, changeOnPage) })),
  );
}

const TAX = /税额|税金|增值税|\btax\b|\bvat\b|\btva\b|\btaxes\b/;
const TAX_NOT = /不含税|含税|价税合计|excl|incl|before tax|\bht\b|\bttc\b|hors tax|rate|taux/;
const TAX_TOTAL = /total|合计|总/;

/** Tax amount: labels that resemble tax and are not "Excluding tax / Total including tax / Tax rate"; when multiple tax rates are listed separately, pick only the one marked "Total". */
export function pickTax(
  text: string,
  candidates: readonly ValueCandidate[],
): ValueCandidate | null {
  const lines = splitLines(text);
  const taxes = candidates
    .filter((c) => c.kind === 'amount' && Number(c.value) > 0)
    .map((c) => ({ c, label: labelOf(lines, c, candidates).text }))
    .filter(({ label }) => TAX.test(label) && !TAX_NOT.test(label));
  const values = new Set(taxes.map(({ c }) => Number(c.value).toFixed(2)));
  if (values.size === 1) return taxes[0]!.c;
  const totals = taxes.filter(({ label }) => TAX_TOTAL.test(label));
  return new Set(totals.map(({ c }) => Number(c.value).toFixed(2))).size === 1
    ? totals[0]!.c
    : null;
}

// ---- Date ----

const DATE_EXCLUDE =
  /到期|截止|期限|有效期|出生|生日|配送|送达|发货|预计|打印|下次|period|周期|账期|\bdue\b|payable|pay by|expir|\bexp\b|valid|delivery|deliver|ship|arriv|birth|\bdob\b|print|next|échéance|avant le|livraison|expédition|naissance|validité|imprimé|période|prochain/;
const DATE_ISSUE =
  /开票日期|日期|交易|消费|下单|乘车|出发|\bdate\b|issued|invoice date|transaction|purchase|order date|travel|émis|émission|achat|facture du|\ble\b/;

/** Date: exclude expiration, delivery, print; fill if only a single value remains; if more than one, look under "Invoice date" labels, or leave blank if still multiple. */
export function pickDate(
  text: string,
  candidates: readonly ValueCandidate[],
): ValueCandidate | null {
  const lines = splitLines(text);
  const dates = candidates
    .filter((c) => c.kind === 'date')
    .map((c) => ({ c, label: labelOf(lines, c, candidates).text }))
    .filter(({ label }) => !DATE_EXCLUDE.test(label));
  // When the same numeric text can be interpreted as two dates, language settings cannot be used to guess the user's intent.
  const ambiguous = (list: typeof dates) =>
    list.some(({ c }) =>
      list.some(
        ({ c: other }) =>
          c !== other &&
          c.line === other.line &&
          c.start === other.start &&
          c.end === other.end &&
          c.value !== other.value,
      ),
    );
  const prefer = (list: typeof dates) =>
    list.find(({ c }) => c.source === 'rule')?.c ?? list[0]?.c ?? null;
  if (ambiguous(dates)) return null;
  if (new Set(dates.map(({ c }) => c.value)).size === 1) return prefer(dates);
  const issued = dates.filter(({ label }) => DATE_ISSUE.test(label));
  return new Set(issued.map(({ c }) => c.value)).size === 1 ? prefer(issued) : null;
}
