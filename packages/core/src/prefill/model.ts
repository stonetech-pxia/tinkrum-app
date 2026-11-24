import type { Field } from '../schema';
import { checkAnswer, keepForModel, squash } from './check';
import { categoryAnswers, categoryRequest } from './category';
import { conceptOf, type ConceptId } from './concepts';

// Single text generation. prompt is already the complete prompt; preceding identical sections are
// cached and reused by the implementation. On-device model candidate generation (D-396, D-401):
// Qwen3.5-2B, querying only uncertain fields identified by code, once per field. Text generation is
// injected externally (llama.rn in-app, llama-server for desktop benchmarking), keeping only
// prompts, grammars, and response reading here. Model responses must pass verification one by one
// (check.ts), ensuring no generation of values absent from the text; results enter candidates only,
// filled only upon user tap (D-394). Prompts, grammars, parameters, and benchmarks match previous
// measurements (side-session-notes/prefill-model/per-field/sibr/pf9.ts); re-benchmarking is
// required if modified.

/** A text generation request. prompt is already the complete prompt; preceding identical sections are cached and reused by the implementation. */
export interface ModelRequest {
  prompt: string;
  grammar: string;
  temperature: number;
  seed: number;
  nPredict: number;
  stop: readonly string[];
}

/** A loaded model session. The engine calls release upon completion (called on success, failure, or cancellation). */
export interface ModelSession {
  /** generate(request: ModelRequest, signal: AbortSignal): Promise<string>; implementation should stop as soon as signal aborts; the engine does not wait for it, so non-stopping tasks will not hang the form. */
  generate(request: ModelRequest, signal: AbortSignal): Promise<string>;
  release(): Promise<void>;
}

/** Load model; returns null if uninstalled or low memory. Released by the engine when done, not resident in memory. */
export type OpenModel = (signal: AbortSignal) => Promise<ModelSession | null>;

export const MODEL_LIMITS = {
  /** Maximum character count for text sent to the model: 4096 token context, reserving space for prompts, questions, and responses; Chinese is approximately one character per token. */
  textChars: 3000,
  /** Time limit for loading the model, asking about a single field, or processing an entire document (stops if exceeded, keeping existing candidates). */
  openMs: 60_000,
  callMs: 30_000,
  totalMs: 120_000,
};
export type ModelLimits = typeof MODEL_LIMITS;

const SYSTEM =
  'You read the OCR text of one document. Then you are asked for one field at a time. ' +
  'Answer with the value of that field copied from the text exactly as written, without its label, ' +
  'or null only when the text does not show it. ' +
  'Use only what is written in the text: no guessing, no outside knowledge. ' +
  'A value next to a label for something else is not this field. Output only the value.';

// Add a hint for recognized fields; user-created fields rely solely on their field name.
const HINTS: Partial<Record<ConceptId, string>> = {
  jobTitle: 'the job title of the person on the card; not the company',
  amount:
    'the final amount paid (after rounding and discounts); not subtotal, tax, change, cash tendered or item prices',
  tax: 'a separate tax amount; not a tax rate and not a total that includes tax',
  issueDate: 'the date of the document',
  merchant: 'the shop or issuer name; not an address, slogan or sample text',
  company: 'the organization name; not a person name or address',
  name: 'a person name; on a business card the person, not the company',
  number: 'a document number written next to its label; not a phone, address, item or sample code',
  phone: 'a phone number',
  email: 'an email address',
  address: 'a postal address',
  category: 'only when the text names it',
};

/** The prompt sentence used to ask the model about this field. */
export function fieldQuestion(f: Field): string {
  const kind = f.type === 'money' || f.type === 'number' ? 'amount' : f.type;
  const concept = conceptOf(f);
  const hint = concept ? HINTS[concept] : undefined;
  const how =
    f.type === 'date'
      ? 'Give it as YYYY-MM-DD, reading the day and month order of the document.'
      : f.type === 'money' || f.type === 'number'
        ? 'Copy the amount as written.'
        : 'Copy its value from the text.';
  return `Field "${f.name}" (${kind})${hint ? `: ${hint}` : ''}. ${how} List up to 3 different values from the text that could be this field, most likely first, separated by " | ". Answer null only if the text shows none.`;
}

/** At most 3 candidates separated by " | "; or null. */
export const MODEL_GRAMMAR =
  'root ::= "null" | item (" | " item)? (" | " item)?\nitem ::= [^\\n<|]+';

/** Language of the document (determined purely from text; UI language and document language often differ): 'zh' if Chinese characters are present, 'fr' if French phrasing is present, otherwise 'en'. */
export function documentLanguage(rows: readonly string[]): 'zh' | 'fr' | 'en' {
  const text = rows.join('\n');
  if (/[㐀-鿿]/.test(text)) return 'zh';
  if (/[éèêàçùœ]|\b(tva|montant|facture|reçu|espèces|ttc)\b/i.test(text)) return 'fr';
  return 'en';
}

/** Remove the middle rows when text is too long: store name at the beginning, total at the end. */
export function fitText(rows: readonly string[], limit: number): string[] {
  const size = (list: readonly string[]) => list.reduce((n, r) => n + r.length + 1, 0);
  if (size(rows) <= limit) return [...rows];
  const take = (list: readonly string[], budget: number) => {
    const out: string[] = [];
    let used = 0;
    for (const row of list) {
      // Split rows that exceed the budget (long text in PDFs without line breaks).
      const piece = row.slice(0, Math.max(0, budget - used - 1));
      if (piece) out.push(piece);
      used += piece.length + 1;
      if (used >= budget) break;
    }
    return out;
  };
  const head = take(rows, Math.floor(limit * 0.6));
  const tail = take([...rows].reverse(), limit - Math.floor(limit * 0.6)).reverse();
  return [...head, ...tail];
}

/** The shared prefix when querying each field of a document (system prompt + text; a field's own rows are only included when querying it); the model is loaded once, and the identical prefix is read only once. */
function documentPrefix(f: Field, rows: readonly string[], limits: ModelLimits): string {
  const kept = fitText(
    rows.filter((r) => keepForModel(r, f)),
    limits.textChars,
  );
  return (
    `<|im_start|>system\n${SYSTEM}<|im_end|>\n` +
    `<|im_start|>user\nDocument language: ${documentLanguage(rows)}.\nTEXT:\n${kept.join('\n')}\n\n`
  );
}

/** Complete request to query a single field. Hand-written ChatML: empty think block disables thinking, llama.rn jinja path omits assistant prefix. */
export function modelRequest(
  f: Field,
  rows: readonly string[],
  limits: ModelLimits = MODEL_LIMITS,
): ModelRequest {
  // For choice fields (single select), the question asks "which option to select", not copying values from the text (D-405).
  if (f.type === 'choice') return categoryRequest(f, rows, limits.textChars);
  return {
    prompt:
      `${documentPrefix(f, rows, limits)}${fieldQuestion(f)}<|im_end|>\n` +
      '<|im_start|>assistant\n<think>\n\n</think>\n\n',
    grammar: MODEL_GRAMMAR,
    temperature: 0,
    seed: 42,
    nPredict: 120,
    stop: ['\n', '<|im_end|>'],
  };
}

/** Model answers -> validated values (form formatting, deduplicated, max 3). */
export function modelAnswers(
  f: Field,
  answer: string,
  rows: readonly string[],
  locale: Parameters<typeof checkAnswer>[3],
): string[] {
  if (f.type === 'choice') return categoryAnswers(f, answer);
  const out: string[] = [];
  for (const part of answer.split('|')) {
    const value = checkAnswer(f, part, rows, locale);
    if (value !== null && !out.some((v) => squash(v) === squash(value))) out.push(value);
  }
  return out.slice(0, 3);
}
