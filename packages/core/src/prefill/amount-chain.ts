import type { Locale } from '../schema';
import { ruleCandidates } from './candidates';
import { receiptRules } from './doc-context';
import { normalizeNumber } from '../text-rules';

// Arithmetic total finding (founder's idea from 2026-11-01, measurement see per-field/REPORT.md
// test paper section): ignore field names, look only at numbers.
// 1. Payment - change = x, where x is the total (these two rows must have payment/change keywords).
// 2. Otherwise: subtotal = sum of consecutive detail rows above; total = subtotal +/- some number
// below (discount, tax).
// 3. Otherwise: subtotal itself.

const NOT_MONEY =
  /\b(tel|fax|phone|gst\s*(reg|id|no)|reg\.?\s*no|invoice\s*no|bill\s*no|no\s*:|qty|date|time)\b|电话|编号|单号|日期|\d{1,2}[:/]\d{2}/i;
const PAY_ROW = /cash|tender|paid|payment|visa|master|card|现金|实收|收款|esp[èe]ces|pay[ée]/i;
const CHANGE_ROW = /change|找零|monnaie|rendu|kembali/i;
// Western language payment, change, discount, and total keywords (whole words, no similarity matching).
const W_PAY_ROW =
  /(^|[^\p{L}])(bar|barzahlung|ec[\s-]?karte|girocard|karte|kontaktlos|bezahlt|contanti|contante|bancomat|pagato|efectivo|tarjeta|pagado|contant|pin|dinheiro|cartão|cartao|cb|carte|carte bancaire|esp[eè]ces)([^\p{L}]|$)/iu;
const W_CHANGE_ROW =
  /(^|[^\p{L}])(r[uü]e?ckgeld|zur[uü]ck|resto|cambio|vuelto|troco|wisselgeld)([^\p{L}]|$)/iu;
const W_DISCOUNT_ROW =
  /(^|[^\p{L}])(rabatt|sconto|descuento|desconto|korting|remise)([^\p{L}]|$)/iu;
const W_TOTAL_ROW =
  /(^|[^\p{L}])(summe|gesamt|gesamtsumme|gesamtbetrag|totale|totaal|importe|importo|a pagar|zu zahlen)([^\p{L}]|$)/iu;
const W_NOT_FINAL_ROW = /(^|[^\p{L}])(mwst|ust|iva|btw|netto|imponibile)([^\p{L}]|$)/iu;
const DISCOUNT_ROW = /优惠|折扣|discount|remise|promo|voucher|less/i;
/** Skip when there are too many numbers (long receipts, statements): triple loops take hundreds of milliseconds on mobile, and such documents are not targeted by this algorithm. */
const MAX_AMOUNTS = 120;

/** Row stating total (payment keywords may also appear on such rows: Total Paid). */
const TOTAL_ROW = /total|合计|总计|总额|montant|amount|应付|实付/i;
const NOT_TOTAL_ROW = /sub[\s.-]*total|小计|sous-total/i;
/** Row stating total but not a grand total (Total Qty, Total Tax). */
const NOT_FINAL_ROW = /qty|quantity|\bitems?\b|\b(?:tax|gst|vat|tva)\b|税|数量/i;

const isPay = (r: string) => PAY_ROW.test(r) || (receiptRules() && W_PAY_ROW.test(r));
const isChange = (r: string) => CHANGE_ROW.test(r) || (receiptRules() && W_CHANGE_ROW.test(r));
const isDiscount = (r: string) =>
  DISCOUNT_ROW.test(r) || (receiptRules() && W_DISCOUNT_ROW.test(r));
const isNotFinal = (r: string) =>
  NOT_FINAL_ROW.test(r) || (receiptRules() && W_NOT_FINAL_ROW.test(r));

interface Amount {
  v: number;
  row: number;
  last: boolean;
  /** Numbers without decimals on payment rows (Cash 100): used as payment only within "payment - change". */
  payOnly?: boolean;
}

function amountsOf(rows: readonly string[], noDecimals: boolean, locale: Locale): Amount[] {
  const out: Amount[] = [];
  rows.forEach((r, row) => {
    let vs: number[] = [];
    if (noDecimals) {
      for (const m of r.matchAll(/\d{1,3}(?:[.,]\d{3})+(?:[.,]00)?|\d{4,}/g))
        vs.push(Number(m[0].replace(/[.,]00$/, '').replace(/\D/g, '')));
    } else {
      // Extract only numbers with two decimal places per row (amounts on receipts) to avoid quantities and numbers.
      for (const m of r.matchAll(/-?\d{1,3}(?:[ ,.]\d{3})*[.,]\d{2}(?!\d)/g)) {
        // Numbers with spaces as thousand separators (2 368.66) passed to ruleCandidates alone would only read the second half (368.66); merged only when immediately followed by €/EUR.
        if (
          receiptRules() &&
          /^-?\d{1,3}(?: \d{3})+[.,]\d{2}$/.test(m[0]) &&
          /^\s*(?:€|eur|euros?)/i.test(r.slice(m.index + m[0].length))
        ) {
          const x = Number(normalizeNumber(m[0].replace(/ /g, '')));
          vs.push(isDiscount(r) ? Math.abs(x) : x);
          continue;
        }
        const c = ruleCandidates(m[0], locale).find((x) => x.kind === 'amount');
        // Discounts are often written as negative numbers: subtract their absolute value.
        if (c) vs.push(isDiscount(r) ? Math.abs(Number(c.value)) : Number(c.value));
      }
    }
    vs = vs.filter((v) => v > 0);
    vs.forEach((v, k) => out.push({ v, row, last: k === vs.length - 1 }));
    if (!noDecimals && vs.length === 0 && isPay(r))
      for (const m of r.matchAll(/(^|[^\d.,])(\d{1,6})(?![\d.,])/g))
        out.push({ v: Number(m[2]), row, last: false, payOnly: true });
  });
  return out;
}

export interface AmountChain {
  value: number;
  how: 'payMinusChange' | 'subtotalAdjust' | 'subtotal';
}

/** Difference threshold for equality: currencies without decimals differ by 1, others differ by 0.01. */
export const amountNear = (a: number, b: number, noDecimals: boolean) =>
  Math.abs(a - b) <= (noDecimals ? 1 : 0.011);

/** Calculated total; null if it cannot be calculated. noDecimals: currencies without decimals like Indonesian Rupiah. */
export function amountChain(
  rows: readonly string[],
  noDecimals: boolean,
  locale: Locale,
): AmountChain | null {
  const near = (a: number, b: number) => amountNear(a, b, noDecimals);
  const found = amountsOf(rows, noDecimals, locale).filter(
    (a) => !NOT_MONEY.test(rows[a.row]!) || /total|合计|montant/i.test(rows[a.row]!),
  );
  if (found.length > MAX_AMOUNTS) return null;
  const all = found.filter((a) => !a.payOnly);
  const isTotal = (row: number) =>
    (TOTAL_ROW.test(rows[row]!) || (receiptRules() && W_TOTAL_ROW.test(rows[row]!))) &&
    !NOT_TOTAL_ROW.test(rows[row]!);
  // When the total row has a number, payment rows below it (Cash 20.00) are just outgoing money and
  // cannot be treated as the calculated total or subtotal. Only when the total row OCR fails to
  // read a number (TOTAL on a separate row, 28-90) can the payment row numbers possibly be the
  // total (common on real receipts).
  const notPayRow = (a: Amount) =>
    !isPay(rows[a.row]!) ||
    isTotal(a.row) ||
    !all.some((t) => t.row < a.row && isTotal(t.row) && !isNotFinal(rows[t.row]!));
  for (const x of all) {
    for (const pay of found) {
      if (pay === x || pay.row <= x.row || !isPay(rows[pay.row]!)) continue;
      for (const ch of all) {
        if (
          ch !== pay &&
          ch !== x &&
          ch.row > x.row &&
          isChange(rows[ch.row]!) &&
          near(pay.v - ch.v, x.v) &&
          // When change is greater than the total (paying with large bills), require the row to say total and not differ even by a cent, otherwise a detail row will be miscalculated as the total.
          (ch.v < x.v || (isTotal(x.row) && Math.abs(pay.v - ch.v - x.v) < 0.005))
        )
          return { value: x.v, how: 'payMinusChange' };
      }
    }
  }

  const subs: Amount[] = [];
  for (const x of all.filter(notPayRow)) {
    const above = all.filter((a) => a.last && a.row < x.row);
    outer: for (let i = 0; i < above.length; i++) {
      let s = 0;
      for (let j = i; j < above.length; j++) {
        s += above[j]!.v;
        if (j > i && near(s, x.v)) {
          subs.push(x);
          break outer;
        }
      }
    }
    // When there is only a single detail item, subtotal = number from a row above.
    if (
      !subs.includes(x) &&
      above.some((a) => near(a.v, x.v)) &&
      /sub|小计|sous|total/i.test(rows[x.row]!)
    )
      subs.push(x);
  }
  let adjusted: number | null = null;
  for (const sub of subs) {
    for (const x of all.filter(notPayRow)) {
      if (x.row <= sub.row) continue;
      for (const adj of all) {
        if (adj === x || adj === sub || adj.v >= sub.v) continue;
        if (near(sub.v + adj.v, x.v)) adjusted = x.v;
        // Subtotal - discount = total, same arithmetic as "gross total - net = tax amount": take the smaller number if the subtracted row says discount, otherwise take the larger.
        else if (near(sub.v - adj.v, x.v))
          adjusted = isDiscount(rows[adj.row]!) ? x.v : Math.max(sub.v, x.v);
      }
    }
  }
  if (adjusted !== null) return { value: adjusted, how: 'subtotalAdjust' };
  return subs.length > 0 ? { value: subs.at(-1)!.v, how: 'subtotal' } : null;
}
