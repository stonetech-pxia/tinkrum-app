import type { Field } from '../schema';
import { receiptRules } from './doc-context';
import type { ModelRequest } from './model';

// Category field (single-choice, category concept) candidates (D-405): first use the code lexicon
// (store name area and terms printed on the receipt), and fall back to asking the local model if
// uncertain. The lexicon and prompts were measured and tuned in research directory
// prefill-rules-research/step6-classify before being ported over; modifications require
// re-measurement. Recognized only when option IDs match default category IDs (the six in the
// receipt template); user-added options rely solely on names for model selection. Results enter
// candidates only, filled only upon user tap (D-394, D-396).

export type ChoiceField = Extract<Field, { type: 'choice' }>;

/** Default category option IDs; if the user changes the option name, the ID remains the same and is still recognized. */
export const CATEGORY_IDS = [
  'dining',
  'grocery',
  'pharmacy',
  'other-shopping',
  'transport',
  'other',
] as const;
type CategoryId = (typeof CATEGORY_IDS)[number];
const isKnown = (id: string): id is CategoryId => (CATEGORY_IDS as readonly string[]).includes(id);

// Latin word start must be at a word boundary (avoiding lookbehinds, which Hermes may not support).
const L = (s: string) => `(?:^|[^\\p{L}\\p{N}])(?:${s})`;
const R = (...parts: string[]) => new RegExp(parts.join('|'), 'iu');

interface Lexicon {
  id: CategoryId;
  /** Score 3 if appearing in the store name area (first 6 rows), score 1 if appearing elsewhere. */
  name?: RegExp;
  /** Words indicating this category is printed on the receipt, score 3 for full-text appearance. */
  strong?: RegExp;
  /** +1 point for full-text appearance. */
  body?: RegExp;
}

const LEXICON: readonly Lexicon[] = [
  {
    id: 'dining',
    name: R(
      L(
        'restaur|bistro|brasserie|brewery|caf[eé]|caff|coffee|pizz|burger|sushi|ramen|grill|kitchen|diner|steak|taverna|trattoria|osteria|pub\\b|bar\\b|bakery|boulangerie|patisserie|noodle|kebab|bbq|taqueria|cantina|gasthaus|canteen|cafeteria|donut|doughnut',
      ),
      '餐|饭店|饭馆|面馆|酒楼|酒家|火锅|咖啡|茶饮|奶茶|小馆|食堂|居酒屋|寿司|鮨|ラーメン|焼肉|焼鳥|レストラン|カフェ|珈琲|うどん|そば|丼|定食|天ぷら|麺|ドーナツ',
    ),
    strong: R(
      L('service charge|gratuity|pourboire|couverts?\\b|propina|trinkgeld|covers?\\b'),
      '桌号|桌台|サービス料|お通し|テーブル|席料',
    ),
    body: R(L('table|tip\\b|guests?\\b|mesa|servicio'), '人数|ドリンク|飲食'),
  },
  {
    id: 'grocery',
    name: R(
      L(
        'supermarket|supermarch|hypermarch|supermercado|grocery|groceries|convenience|carrefour|lidl|aldi|leclerc|auchan|intermarch|monoprix|walmart|costco|tesco|kroger|safeway|trader joe|whole foods|7-?eleven|familymart|lawson|ministop|mart\\b|market\\b|march[eé]\\b|[eé]picerie',
      ),
      '超市|便利店|商超|生鲜|全家|罗森|スーパー|コンビニ|マート|マーケット|生協|イオン|セブン|ローソン|ファミリーマート|ファミマ|ミニストップ|デイリーヤマザキ',
    ),
  },
  {
    id: 'pharmacy',
    name: R(
      L('pharmac|farmac|apothek|chemist|parapharmacie|boots\\b|cvs|walgreens|rite aid|rossmann'),
      'drug|药|藥|薬|ドラッグ|クスリ|調剤|ファーマシー|化粧品|コスメ',
    ),
  },
  {
    id: 'transport',
    name: R(
      L(
        'parking|parcm[eè]tre|taxi|uber|lyft|didi|grab\\b|sncf|railway|metro\\b|m[eé]tro\\b|airline|airways|toll|p[eé]age|autoroute|tankstelle|gasolinera|shell\\b|esso\\b|total ?energies|bp\\b|eneos|idemitsu|cosmo ?oil|gas station|petrol station|station.service',
      ),
      '停车|停車|駐車|パーキング|出租|打车|滴滴|加油|铁路|鉄道|地铁|高铁|高速|航空|エネオス|出光|タクシー|ガソリンスタンド|ガスステーション|コスモ石油|石油',
    ),
    strong: R(
      L(
        'fuel|gasoline|petrol|diesel|gazole|carburant|unleaded|litres?\\b|liters?\\b|essence\\b|parking|taxi|fare\\b',
      ),
      '汽油|柴油|ガソリン|軽油|ハイオク|レギュラー|リットル|給油|運賃|メーター|乗車|入庫|出庫|駐車|车牌|里程',
    ),
  },
  {
    id: 'other-shopping',
    name: R(
      L(
        'bookstore|librairie|electronics|apparel|clothing|fashion|shoes|furniture|hardware|bricolage|stationery|papeterie|boutique|outlet|decathlon|ikea|zara|h&m|uniqlo|muji',
      ),
      '书店|書店|服饰|服装|鞋|家居|电器|ユニクロ|無印|ニトリ|百均|ダイソー|セリア|ホームセンター|家電|文具|ブック',
    ),
  },
  {
    id: 'other',
    name: R(
      L(
        'cinema|karaoke|hotel|hospital|clinic|dental|salon|barber|laundry|repair|post ?office|fitness|gym\\b|school|university|museum|theat(er|re)|lawyer|insurance|bank\\b',
      ),
      '电影|影院|映画|シネマ|カラオケ|ホテル|病院|医院|クリニック|歯科|美容|ヘアカラー|理髪|クリーニング|修理|郵便|役所|市役所|区役所|ジム|学校|保険|銀行|旅館|宿|酒店|诊所|保险|银行',
    ),
  },
];

/** Confidence threshold in code (measured: 1st place >= 3 points, lead >= 2 points). */
const SURE_TOP = 3;
const SURE_GAP = 2;

/** Default category ID recognized by lexicon; null when uncertain. */
export function categoryByLexicon(rows: readonly string[]): CategoryId | null {
  const lines = rows.map((r) => r.normalize('NFKC').trim()).filter(Boolean);
  const head = lines.slice(0, 6).join('\n');
  const all = lines.join('\n');
  const scores: [CategoryId, number][] = [];
  for (const r of LEXICON) {
    let s = 0;
    if (r.name?.test(head)) s += 3;
    else if (r.name?.test(all)) s += 1;
    if (r.strong?.test(all)) s = Math.max(s, 3);
    if (r.body?.test(all)) s += 1;
    if (s > 0) scores.push([r.id, s]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  const first = scores[0];
  if (!first || first[1] < SURE_TOP || first[1] - (scores[1]?.[1] ?? 0) < SURE_GAP) return null;
  return first[0];
}

/** Category recognized by code, mapped to the corresponding option ID in this field (null if the option was deleted). */
export function categoryByCode(field: ChoiceField, rows: readonly string[]): string | null {
  // Lexicon originates from receipts (D-405), applies only to receipts.
  if (!receiptRules()) return null;
  const id = categoryByLexicon(rows);
  return id !== null && field.options.some((o) => o.id === id) ? id : null;
}

/** Whether this field can query the model: at least two options to distinguish names. */
export const canAskCategory = (field: ChoiceField): boolean => categoryChoices(field).length >= 2;

// Descriptions in prompt (English; model reads English most reliably; during measurement, Chinese and French names performed worse than English names, so recognized default categories uniformly use English names).
const DESCRIPTIONS: Record<CategoryId, string> = {
  dining:
    'restaurant, cafe, bar, bakery counter, takeaway or any place that serves prepared food and drinks. Signs: table, guests, service charge, tip, dishes and drinks as items.',
  grocery:
    'supermarket, convenience store or discount store. Signs: many small items of food, drink, snacks and daily goods, loyalty points, reduced-rate food items.',
  pharmacy:
    'drugstore or pharmacy. Signs: medicine, cosmetics, skin care, toiletries, health and beauty products, daily goods, loyalty points.',
  'other-shopping':
    'any other shop selling goods: clothes, shoes, electronics, books, stationery, furniture, hardware, sports, gifts, variety stores, department stores.',
  transport: 'trains, buses, taxis, parking, tolls, highway, fuel, flights, rides.',
  other:
    'services and places that do not sell goods: post office, government office, cinema, karaoke, hotel, hospital, hair salon, repair, school, gym, bills, rent, contracts, letters, reports, notes, work, or nothing in the text shows a shop or a trip.',
};

const cleanName = (label: string) =>
  label
    .replace(/[\r\n]+/g, ' ')
    .replace(/<\|/g, '')
    .replace(/["\\]/g, '')
    .trim();

/** Option labels when querying the model: recognized default categories use English names, others use user-defined names; duplicates keep only the first. */
function categoryChoices(field: ChoiceField): { id: string; name: string; known: boolean }[] {
  const out: { id: string; name: string; known: boolean }[] = [];
  for (const o of field.options) {
    const known = isKnown(o.id);
    const name = known ? o.id.replace(/-/g, '_') : cleanName(o.label);
    if (name && !out.some((c) => c.name === name)) out.push({ id: o.id, name, known });
  }
  return out;
}

/** Options when querying the model: name (used in grammar) and a line in the prompt (spoken text also uses this copy, D-575). */
export function categoryPromptOptions(
  field: ChoiceField,
): { id: string; name: string; line: string }[] {
  return categoryChoices(field).map((c) => ({
    id: c.id,
    name: c.name,
    line: `- ${c.name}${c.known ? `: ${DESCRIPTIONS[c.id as CategoryId]}` : ''}`,
  }));
}

const SYSTEM =
  'You read the OCR text of one receipt or document and choose the one category it belongs to. ' +
  'Use only what is written in the text. Output only the category.';

/** Complete request for category query: grammar restricts answers to current option names of this field. Hand-written ChatML; empty think block disables thinking. */
export function categoryRequest(
  field: ChoiceField,
  rows: readonly string[],
  textChars: number,
): ModelRequest {
  const choices = categoryChoices(field);
  const list = choices
    .map((c) => `- ${c.name}${c.known ? `: ${DESCRIPTIONS[c.id as CategoryId]}` : ''}`)
    .join('\n');
  return {
    prompt:
      `<|im_start|>system\n${SYSTEM}<|im_end|>\n` +
      `<|im_start|>user\nTEXT:\n${rows.join('\n').slice(0, textChars)}\n\nCategories:\n${list}\n\nWhich category?<|im_end|>\n` +
      '<|im_start|>assistant\n<think>\n\n</think>\n\n',
    grammar: `root ::= ${choices.map((c) => `"${c.name}"`).join(' | ')}`,
    temperature: 0,
    seed: 42,
    nPredict: 48,
    stop: ['\n', '<|im_end|>'],
  };
}

/** Model answer -> option ID; answers that are not option names are discarded (grammar already restricts, verified here again). */
export function categoryAnswers(field: ChoiceField, answer: string): string[] {
  const name = answer.trim();
  const hit = categoryChoices(field).find((c) => c.name === name);
  return hit ? [hit.id] : [];
}

// Currencies printed on receipts (D-429). ¥ can be either CNY or JPY: determined by which one is in the field options.
const CURRENCY_MARKS: readonly (readonly [RegExp, readonly string[]])[] = [
  [/(?:C|CA)\$/g, ['cad']],
  [/(?:A|AU)\$/g, ['aud']],
  [/HK\$/g, ['hkd']],
  [/S\$/g, ['sgd']],
  [/\$/g, ['usd']],
  [/€/g, ['eur']],
  [/£/g, ['gbp']],
  [/₩/g, ['krw']],
  [/₹/g, ['inr']],
  // Malaysian Ringgit (D-549): RM immediately followed by digits, uppercase (RMB is Chinese Yuan).
  [/\bRM(?=\s?\d)/g, ['myr']],
  [/円/g, ['jpy']],
  [/元|人民币|\bRMB\b/gi, ['cny']],
  [/[¥￥]/g, ['cny', 'jpy']],
];

/** Currency appearing most frequently in text (must be an option of this choice field); null if none. */
export function currencyInText(field: ChoiceField, rows: readonly string[]): string | null {
  const ids = new Set(field.options.map((o) => o.id));
  const counts = new Map<string, number>();
  const add = (id: string, n: number) => counts.set(id, (counts.get(id) ?? 0) + n);
  let text = rows.join('\n');
  for (const id of ids) {
    const hits = text.match(new RegExp(`\\b${id}\\b`, 'gi'))?.length ?? 0;
    if (hits > 0) add(id, hits);
  }
  for (const [mark, options] of CURRENCY_MARKS) {
    const hits = text.match(mark)?.length ?? 0;
    const id = options.find((o) => ids.has(o));
    if (hits > 0 && id) add(id, hits);
    // "CA$" has been counted, subsequent "$" is not counted again.
    text = text.replace(mark, ' ');
  }
  let best: string | null = null;
  for (const [id, n] of counts) if (best === null || n > counts.get(best)!) best = id;
  return best;
}
