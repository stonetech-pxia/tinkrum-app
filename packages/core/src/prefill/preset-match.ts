import type { NewTablePreset } from '../templates';
import { ruleCandidates } from './candidates';
import { bounded, free } from './engine';
import { fitText, MODEL_LIMITS, type ModelRequest, type OpenModel } from './model';
import type { TextPage } from './rows';

// Create a form after importing a file: which presets come first (D-444). Rules are sorted first:
// files without amounts have presets that require amounts placed later (not hidden, optical
// character recognition might miss amounts); deterministic signals (passport MRZ, IBAN) are placed
// first. The on-device 2B model only chooses from presets that are not demoted; the result is
// merely a recommendation, applied only when the user taps it (invariant D-396). Neither text nor
// results go online or are sent to cloud AI (invariants 1, 2).

const DESCRIPTIONS: Record<NewTablePreset, string> = {
  bank: 'bank account statement with transactions and balance',
  bill: 'utility, phone or service bill or invoice to pay',
  contacts: 'business card or contact details of a person',
  contract: 'agreement between parties with terms and signatures',
  education: 'diploma, certificate or transcript',
  identity: 'passport, ID card, driving licence or other identity document',
  insurance: 'insurance policy or certificate',
  lab: 'medical test results with measured values',
  lease: 'rental agreement for a home',
  loan: 'loan or mortgage agreement or statement',
  payslip: 'salary slip with gross and net pay',
  pet: 'veterinary or pet record',
  prescription: 'doctor prescription of medicines',
  property: 'deed or proof of owning property',
  purchase:
    'receipt, bill, invoice, loan or tax payment, expense claim: any document with a total amount to pay',
  reimbursement: 'expense claim to be paid back',
  tax: 'tax return or tax notice',
  travel: 'plane, train or hotel booking or ticket',
  vaccination: 'vaccination record',
  vehicle: 'vehicle registration or inspection document',
  warranty: 'product warranty or guarantee',
};
export const NEW_TABLE_PRESETS = Object.keys(DESCRIPTIONS) as NewTablePreset[];

/** Files for these presets must have an amount. */
const NEEDS_MONEY: readonly NewTablePreset[] = [
  'bank',
  'bill',
  'loan',
  'payslip',
  'purchase',
  'reimbursement',
  'tax',
];

/** Merged into the amount category of "shopping vouchers" when totals and amounts are present (D-476, D-480): not selectable by the model, but still selectable in the list. */
const FOLDED: readonly NewTablePreset[] = [
  'bank',
  'bill',
  'loan',
  'payslip',
  'reimbursement',
  'tax',
];

export interface PresetRanking {
  /** Presets placed earlier (deterministic signals first). */
  likely: NewTablePreset[];
  /** Demoted: rules see that the file lacks items they are guaranteed to have. */
  unlikely: NewTablePreset[];
  /** Merged into shopping vouchers when an amount is present (not selectable by the model). */
  folded: NewTablePreset[];
}

const textOf = (pages: readonly TextPage[]) =>
  pages.flatMap((p) => p.lines.map((l) => l.text)).join('\n');

/** Does the text contain an amount: numbers with currency symbols or codes, or "number.two decimal places". */
function hasMoney(text: string): boolean {
  if (
    /(?:[$€£¥￥₹]|\b(?:usd|eur|gbp|cny|rmb|chf|cad|aud|inr)\b)\s?\d|\d\s?(?:[$€£¥￥₹元]|(?:usd|eur|gbp|cny|rmb|chf|cad|aud|inr)\b)/i.test(
      text,
    )
  )
    return true;
  return /(?:^|\s)\d{1,3}(?:[ .,]\d{3})*[.,]\d{2}(?:\s|$)/m.test(text);
}

/** Rules sort presets. No presets are demoted when no text is read. */
export function rankPresets(pages: readonly TextPage[]): PresetRanking {
  const text = textOf(pages);
  if (!text.trim()) return { likely: [...NEW_TABLE_PRESETS], unlikely: [], folded: [] };
  const sure: NewTablePreset[] = [];
  if (/P<[A-Z<]{3}[A-Z<]{5,}/.test(text.replace(/ /g, ''))) sure.push('identity');
  if (/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9*]{4}){2,}/.test(text)) sure.push('bank');
  const money = hasMoney(text) || ruleMoney(text);
  const unlikely = money ? [] : NEEDS_MONEY.filter((p) => !sure.includes(p));
  return {
    likely: [
      ...sure,
      ...NEW_TABLE_PRESETS.filter((p) => !sure.includes(p) && !unlikely.includes(p)),
    ],
    unlikely,
    folded: money && TOTAL_WORDS.test(text) ? [...FOLDED] : [],
  };
}

const ruleMoney = (text: string) =>
  text
    .split('\n')
    .some((row) =>
      ruleCandidates(row, 'en').some((c) => c.kind === 'amount' && /[.,]\d{2}\b/.test(c.raw)),
    );

/** Words on receipts such as "total", "change", "payment method", "tax" (English, French, Spanish, Chinese, Japanese). */
const TOTAL_WORDS =
  /\b(?:sub-?total|total|montant|importe|totale?)\b|amount due|[àa] payer|合计|合計|总计|總計|小計|小计|应付|實付|实付|税込/i;
const PAY_WORDS =
  /\b(?:invoice|facture|bill|loan|payslip|salary|salaire|net pay|statement|relev[eé]|iban|imp[oô]ts?|taxe|impuestos?|mortgage|expense|due date|cash|change|visa|mastercard|card|debit|credit|tax|vat|tva|iva|carte|esp[eè]ces|monnaie|efectivo|cambio|tarjeta|receipt|ticket|re[cç]u)\b|找零|找钱|现金|現金|微信|支付宝|支付寶|刷卡|税|稅|小票|小票|收据|收據|账单|賬單|发票|發票|贷款|报销|工资|薪资|对账单|銀行|银行|請求書|レシート|領収|お釣り|クレジット/i;
/** Insurance policies and contracts are not amount categories and have their own templates: skipped by rule recommendations when seen (D-480). */
const NOT_RECEIPT = /\b(?:policy|agreement|contract)\b|合同/i;

/**
 * When there is no on-device model, very obvious receipts should still be recommended as
 * "shopping vouchers" (the rule part of D-444): must simultaneously have words in the "total"
 * category, an amount, and payment method / tax / receipt keywords (or at least two lines of
 * prices with two decimal places). Return null if unsure; better not to recommend than to
 * recommend incorrectly.
 */
export function rulePreset(pages: readonly TextPage[]): NewTablePreset | null {
  const text = textOf(pages);
  if (!text.trim() || NOT_RECEIPT.test(text)) return null;
  if (!TOTAL_WORDS.test(text) || !(hasMoney(text) || ruleMoney(text))) return null;
  const prices = text.split('\n').filter((r) => /\d[.,]\d{2}\b/.test(r)).length;
  return PAY_WORDS.test(text) || prices >= 3 ? 'purchase' : null;
}

/** Request to the model: file text + catalog, answering with only an ID (third-round frozen prompt P3, catalog ordered by ranking). */
export function presetMatchRequest(
  pages: readonly TextPage[],
  ids: readonly NewTablePreset[],
): ModelRequest {
  const rows = pages.flatMap((p) =>
    [...p.lines].sort((a, b) => a.y - b.y || a.x - b.x).map((l) => l.text.trim()),
  );
  const document = fitText(rows.filter(Boolean), MODEL_LIMITS.textChars).join('\n');
  const catalog = ids.map((id) => `${id}: ${DESCRIPTIONS[id]}`).join('\n');
  return {
    prompt:
      '<|im_start|>system\nYou classify documents for a personal records app. ' +
      'Decide what kind of document this is from its content, even without a title. Answer one ID.\n' +
      `Templates:\n${catalog}\nnone: not one of these kinds, such as personal writing or general information<|im_end|>\n` +
      `<|im_start|>user\nDocument:\n${document}\n\nWhich ID describes this document?<|im_end|>\n` +
      '<|im_start|>assistant\n<think>\n\n</think>\n\n',
    grammar: `root ::= ${[...ids, 'none'].map((id) => `"${id}"`).join(' | ')}\n`,
    temperature: 0,
    seed: 42,
    nPredict: 6,
    stop: ['<|im_end|>'],
  };
}

/** Model response -> preset; none, unrecognized items, and items not in the catalog all yield null. */
export function presetAnswer(
  answer: string,
  ids: readonly NewTablePreset[],
): NewTablePreset | null {
  const id = answer.trim() as NewTablePreset;
  return ids.includes(id) ? id : null;
}

/**
 * On-device model recommends a preset. If uninstalled, insufficient memory, loading failure,
 * timeout, or cancellation: quietly returns null, allowing the user to still select from the
 * rule-sorted list or tap the field name.
 */
export async function recommendPreset(
  open: OpenModel,
  pages: readonly TextPage[],
  signal?: AbortSignal,
): Promise<NewTablePreset | null> {
  const ranking = rankPresets(pages);
  const likely = ranking.likely.filter((p) => !ranking.folded.includes(p));
  if (!textOf(pages).trim() || likely.length === 0 || signal?.aborted) return null;
  const stop = new AbortController();
  const abort = () => stop.abort();
  signal?.addEventListener('abort', abort);
  const total = setTimeout(abort, MODEL_LIMITS.totalMs);
  let session: Awaited<ReturnType<OpenModel>> | undefined;
  try {
    const opening = open(stop.signal);
    session = await bounded(opening, stop.signal, MODEL_LIMITS.openMs);
    if (session === undefined) {
      void opening.then((late) => late && free(late)).catch(() => undefined);
      stop.abort();
      return null;
    }
    if (session === null) return null;
    const answer = await bounded(
      session.generate(presetMatchRequest(pages, likely), stop.signal),
      stop.signal,
      MODEL_LIMITS.callMs,
    );
    return answer === undefined ? null : presetAnswer(answer, likely);
  } catch {
    return null;
  } finally {
    clearTimeout(total);
    signal?.removeEventListener('abort', abort);
    if (session) free(session);
  }
}
