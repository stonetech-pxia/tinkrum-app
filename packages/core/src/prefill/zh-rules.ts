// Chinese receipt rules (see measurement in side-session-notes/prefill-model/per-field/REPORT.md
// under SIBR section): uppercase amounts; expiration and print dates are excluded, and hotel bills
// take the latest date; invoice numbers are prioritized by key name.

const NUM: Record<string, number> = {
  零: 0,
  〇: 0,
  壹: 1,
  贰: 2,
  叁: 3,
  肆: 4,
  伍: 5,
  陆: 6,
  柒: 7,
  捌: 8,
  玖: 9,
  貳: 2,
  參: 3,
  陸: 6,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const UNIT: Record<string, number> = { 拾: 10, 十: 10, 佰: 100, 百: 100, 仟: 1000, 千: 1000 };

/** "Twenty-eight yuan nine jiao" -> 28.9; returns null if unrecognized. */
export function upperToNumber(raw: string): number | null {
  const s = raw.replace(/[\s人民币¥￥:：()（）大写]/g, '').replace(/[圆圓园]/g, '元');
  // The "zero" (ling) after yuan is just a placeholder: twenty-eight yuan zero five fen, one hundred yuan zero five jiao.
  const m =
    /^(.*?)元零?(?:(.)角)?零?(?:(.)分)?[整正]?$/.exec(s) ?? /^()(.)角(?:(.)分)?[整正]?$/.exec(s);
  if (!m) return null;
  let total = 0;
  let sec = 0;
  let digit = 0;
  for (const c of m[1]!) {
    if (c in NUM) digit = NUM[c]!;
    else if (c in UNIT) {
      sec += (digit || 1) * UNIT[c]!;
      digit = 0;
    } else if (c === '万' || c === '萬') {
      total += (sec + digit) * 10000;
      sec = digit = 0;
    } else return null;
  }
  const j = m[2];
  const f = m[3];
  if ((j && !(j in NUM)) || (f && !(f in NUM))) return null;
  const v =
    Math.round((total + sec + digit + (j ? NUM[j]! / 10 : 0) + (f ? NUM[f]! / 100 : 0)) * 100) /
    100;
  return v > 0 ? v : null;
}

const UPPER_RUN = /[零壹贰貳叁參肆伍陆陸柒捌玖拾佰仟万萬元圆圓角分整正]{3,}/g;
/** This section label indicates the total amount. */
const UPPER_TOTAL =
  /合计|合計|总计|總計|总额|總額|总金额|金额|金額|应付|應付|实付|實付|应收|價稅|价税/;
/** This section label refers to other money amounts (change, cash received are collected cash, not document amount). */
/** These rows contain "Total (Uppercase)", with the uppercase amount itself wrapping to the next line (e.g., below "Total Amount (Uppercase):" is "Received: Forty Yuan Even"). */
const UPPER_ABOVE = /(?:合计|合計|总计|總計|金额|金額|人民币).{0,6}大[写寫与]/;
/** This section label refers to other money amounts (change, cash received are collected cash, not document amount). */
const UPPER_OTHER =
  /小计|小計|税额|税金|稅額|服务费|服務費|手续费|押金|定金|订金|保证金|预付|预收|实收|實收|找零|优惠|優惠|折扣|减免|余额|餘額|单价|單價/;
/** "Received" or "Cash" might also refer to the leftmost column title on a receipt; they are not considered other money when "Total (Uppercase)" is written above. */
const UPPER_SIDE = /收款(?!人|单位|方)|现金|現金/;

/**
 * Uppercase amount within text. Requires checking the section label: total-related ones take
 * priority; a single unlabeled one is also valid; deposits, actual cash received, etc. are
 * excluded, and if mismatched, confidence is low (returns null). sure = the exact same number
 * with decimals also appears in the text (integers easily collide by coincidence, so they are
 * excluded). OCR often breaks uppercase strings apart, so spaces are stripped first.
 */
export function upperAmount(rows: readonly string[]): { value: number; sure: boolean } | null {
  const totals: number[] = [];
  const plain: number[] = [];
  rows.forEach((row, i) => {
    const flat = row.replace(/\s+/g, '');
    const above = rows
      .slice(Math.max(0, i - 3), i)
      .some((r) => UPPER_ABOVE.test(r.replace(/\s+/g, '')));
    let from = 0;
    for (const m of flat.matchAll(UPPER_RUN)) {
      const run = m[0];
      const label = flat.slice(from, m.index);
      from = m.index + run.length;
      if (!/[元圆圓角]/.test(run)) continue;
      const v = upperToNumber(run);
      if (v === null) continue;
      const own = /小计|小計/.test(label) ? false : UPPER_TOTAL.test(label);
      if (own || (above && !UPPER_OTHER.test(label))) totals.push(v);
      else if (!UPPER_OTHER.test(label) && !UPPER_SIDE.test(label)) plain.push(v);
    }
  });
  const list = totals.length > 0 ? totals : plain;
  const hasDecimals = (v: number) => {
    const forms = [v.toFixed(2), v.toFixed(1)];
    return (
      v >= 1 &&
      rows.some((r) => {
        const t = r.replace(/[\s,，]/g, '');
        return forms.some((q) =>
          new RegExp(`(^|[^\\d.])${q.replace('.', '\\.')}(?![\\d])`).test(t),
        );
      })
    );
  };
  // When there are multiple, recognize only the one that also has decimals in the text (OCR often recognizes subsequent text as uppercase fragments: e.g., six jiao even).
  const sure = [...new Set(list)].filter(hasDecimals);
  if (sure.length === 1) return { value: sure[0]!, sure: true };
  if (sure.length > 1 || new Set(list).size !== 1) return null;
  return { value: list[0]!, sure: false };
}

/** Rows containing validity periods, printing, printing permits, or supervision: the dates above them are not receipt dates. */
export const BAD_DATE_ROW =
  /使用至|有效期|过期|到期|止[，,。]|印制|准印|监制|出生|\bexp\b|expir|valid\s*(?:until|thru|through|to)\b|good\s*thru|due\s*date|échéance|expire|valable/i;

/** Departure row for hotel bills. */
export const DEPART_ROW = /离店|departure|depart\b|结账日期|退房/i;
/** Hotel bills: room number, room rate, room, guest, folio, check-in, check-out, arrival, departure, etc. Since departure rows are often misplaced by layout serialization, take the latest date in the full text (check-in <= check-out). Not used for non-hotels (train/flight tickets also have departure). */
export const HOTEL_DOC = /房号|房价|\broom\b|\bguest\b|\bfolio\b|入住|离店|抵店/i;
/** Flight, train, and transfer tickets also have departure and guest, but they are not hotel bills. */
export const TRAVEL_DOC =
  /\b(?:flight|airline|boarding|shuttle|pick-?up|drop-?off|train|ferry|coach)\b|^\s*return\b|航班|机票|登机|车票|高铁|列车|接送|接机|送机/i;

// Explicit key names identifying this document's number (English, French): prioritized before generic "No", and values can start with letters (e.g., INV12345).
const EXPLICIT_KEY =
  /(?:^|[^A-Za-z])(?:(?:tax\s*)?invoice|inv|receipt|rcpt|bill|facture)\s*(?:no\b|number|num[ée]ro|n°|nº|№|#)|(?:n°|nº|num[ée]ro)\s*de\s*facture/i;
// Generic "No": anything might follow, requires checking the entire row (see genericNoAllowed).
const GENERIC_KEY = /(?:^|[^A-Za-z])(?:NO|No|№|N[Oo0e]|N°|Nº)[.:：]?(?=\s*[A-Za-z]{0,2}\d)/;
// Invoice number key names, ordered by priority.
const NO_KEYS: readonly RegExp[] = [
  /(?:电子)?票据号码?|发票号码?/,
  EXPLICIT_KEY,
  GENERIC_KEY,
  /机打(?:号码|票号)|电脑票号|收据号|单据号/,
  /账单号|帳单号|帐单号|folio\s*(?:no|number)?|invoice|facture/i,
];
/** Numbers on these rows are not invoice numbers: key names for other numbers (Tel No, Co No, Reg No, etc.) and addresses. */
export const NOT_NO =
  /流水号|社保|社会保障|病历|门诊号|住院号|卡号|医保|身份证|电话|\btel\b|\bfax\b|\bphone\b|房号|\broom\b|确认号|\bconfirmation\b|会员|\bloyalty\b|预订号|\b(?:co|comp|company|reg|regn|registration|gst|sst|roc|ssm|vat|tax\s*id|siret|siren|tva|account|acct|a\/c|table|tbl|member|customer|cust|client|cashier|terminal|pos|batch|mobile|hp|passport|ic)\b\.?\s*(?:no\b|number|num[ée]ro|n°|nº|№|#)|\b(?:jalan|jln|lorong|taman|street|road|rue|avenue|blvd)\b/i;
const NO_ADDRESS = /\b(?:jalan|jln|lorong|taman|street|road|rue|avenue|blvd)\b/i;
/** Presence of these keywords in text indicates a potential invoice number (if code cannot extract a value, prompt the model). */
const NUMBER_KEY =
  /\b(?:invoice|inv|receipt|rcpt|bill|ticket|order|ref|reference|facture|commande|no)\b|n°|nº|№|票据号|发票号|单号|订单号|编号|收据号/i;
/** This text may contain an invoice number (has key name and is not in another number row). */
export const mayHaveNumber = (rows: readonly string[]) =>
  rows.some((r) => NUMBER_KEY.test(r) && !NOT_NO.test(r));

/** Prefix stripping for invoice numbers (e.g., "NO8039067169", "N4510498" -> numeric part). */
export const stripNoPrefix = (s: string) => s.replace(/^(?:NO|No|no|N[oe0°º]?|№)[.:：]?(?=\d)/, '');

/** English words immediately preceding generic "No" (e.g., "Tel" in "Tel No"): only these words indicate this document's number. */
const NO_OWNER =
  /^(?:folio|ticket|order|doc|document|ref|reference|cheque|check|voucher|trans|transaction|txn|re[çc]u|commande|tiket|nota|sales|slip)$/i;
function genericNoAllowed(row: string, before: string): boolean {
  // The segment belonging to this "No" (after the previous number or previous "label:"): OCR may
  // merge cells into a single row, so the number in "Business Serial Number: Medical Type: NO. 123"
  // is not a serial number, whereas "Serial Number NO 123" is. Checking full rows on SIBR would
  // drop many valid invoice numbers (see D-399). Address keywords are checked per full row.
  const own =
    before
      .replace(/^[^]*\d/, '')
      .replace(/(?:医疗|医疗机构|医保)类型\S*/g, '：') // "Medical type urban medical insurance" is in another cell, not the medical insurance number.
      .split(/[:：]/)
      .at(-1) ?? '';
  if (NOT_NO.test(own) || NO_ADDRESS.test(row)) return false;
  const word = /([A-Za-zÀ-ÿ/]+)[\s.]*$/.exec(before)?.[1];
  // Single-letter words are OCR fragments (e.g., "Anhui Finance Special (2014) P No 123").
  return word === undefined || word.length < 2 || NO_OWNER.test(word);
}

/** Find invoice number by key name; returns null if not found. */
export function invoiceNoByKey(rows: readonly string[]): string | null {
  for (const key of NO_KEYS) {
    const generic = key === GENERIC_KEY;
    // An explicit key name can be followed by a letter-prefixed value (INV12345, INV/2026/7), even if short; others follow SIBR line geometry.
    const value =
      key === EXPLICIT_KEY
        ? /^[\s.:：#]*([A-Za-z]*[-/]?\d[A-Za-z0-9/-]{2,})/
        : /^[\s.:：]*((?:[A-Za-z]{0,2})?\d[A-Za-z0-9-]{4,})/;
    for (const row of rows) {
      const k = key.exec(row);
      if (!k) continue;
      const after = row.slice(k.index + k[0].length);
      const m = value.exec(after);
      if (!m) continue;
      // The key name regex includes the preceding non-letter character.
      const before = row.slice(0, k.index + (/^[A-Za-z№]/.test(k[0]) ? 0 : 1));
      if (
        generic
          ? !genericNoAllowed(row, before)
          : NOT_NO.test(after.slice(0, m[0].length).replace(m[1]!, ''))
      )
        continue;
      // If followed by a date (Invoice 2026-10-30), it is not a number.
      if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(m[1]!)) continue;
      return stripNoPrefix(m[1]!);
    }
  }
  return null;
}
