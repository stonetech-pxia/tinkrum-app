import { withDocKind } from './doc-context';
import { mergedSuggestions, planDocument, type DocumentPlan, type FieldPlan } from './code-rules';
import {
  MODEL_LIMITS,
  modelAnswers,
  modelRequest,
  type ModelLimits,
  type ModelRequest,
  type ModelSession,
  type OpenModel,
} from './model';
import { isMultipleChoice, type Field } from '../schema';
import type { SuggestInput, ValueSuggestion } from './rank';
import { mergeSpoken, planSpoken } from './spoken';

// Where new record form candidate values originate (D-398): forms consult only this interface;
// rules and on-device models adhere to this schema so engine swaps do not affect forms. Input is
// page-based text with positions and table fields; output is structured candidates fed exclusively
// to forms, populated only upon user tap (D-394). User-spoken input for this entry (spoken, D-575)
// follows a separate rule set (spoken.ts), where confident candidates are marked sure and
// auto-filled by the form. This is not a quick action step: steps pass a single value, files are
// gone by this stage, and outputs flow into subsequent steps like sharing or saving files (D-396).

/** Single-line text fields cannot wrap lines (multiline addresses): commas separate values displayed and entered in forms. */
export const suggestionForField = (field: Pick<Field, 'type'>, s: ValueSuggestion) =>
  field.type === 'text' && s.value.includes('\n')
    ? { ...s, value: s.value.replace(/\n+/g, ', ') }
    : s;

/** Field ID -> candidates (highest quality first, up to MAX_SUGGESTIONS). */
export type FieldSuggestions = Record<string, ValueSuggestion[]>;

/**
 * Engines should terminate promptly when signal is cancelled; results and errors are discarded.
 * Engines running longer tasks provide intermediate results via onMultiple/onPartial callbacks
 * (invoked multiple times with all current candidates), returning final results in the return
 * value.
 */
export type PrefillEngine = (
  input: SuggestInput,
  signal?: AbortSignal,
  onPartial?: (suggestions: FieldSuggestions) => void,
) => Promise<FieldSuggestions>;

function suggestionsOf(
  plan: DocumentPlan,
  model: ReadonlyMap<FieldPlan, readonly string[]>,
): FieldSuggestions {
  const out: FieldSuggestions = {};
  for (const f of plan.fields) {
    const list = mergedSuggestions(f, model.get(f) ?? [], plan.pickOf);
    if (list.length > 0) out[f.field.id] = list;
  }
  return out;
}

/** Job execution state: current candidates and fields to query model against (one query/verification at a time; answers set to true when used). */
interface Job {
  current(): FieldSuggestions;
  asks: { request(): ModelRequest; take(answer: string): boolean }[];
}

/** Text read from files: rules score based on layout, followed by model queries for uncertain fields. */
function documentJob(input: SuggestInput, limits: ModelLimits): Job {
  const plan = planDocument(input);
  const answers = new Map<FieldPlan, readonly string[]>();
  // No text (image with QR code only, OCR uninstalled): model has nothing to read, do not load.
  const asks = plan.rows.length === 0 ? [] : plan.fields.filter((f) => f.ask);
  return {
    current: () => suggestionsOf(plan, answers),
    asks: asks.map((f) => ({
      request: () => withDocKind(plan.kind, () => modelRequest(f.field, plan.rows, limits)),
      take: (answer) => {
        const found = withDocKind(plan.kind, () =>
          modelAnswers(f.field, answer, plan.rows, input.locale),
        );
        if (found.length === 0) return false;
        answers.set(f, found);
        return true;
      },
    })),
  };
}

/** User-spoken utterance (D-575): code reads values, model extracts text and selects options. */
function spokenJob(input: SuggestInput): Job {
  const plan = planSpoken(input);
  const answers = new Map<string, readonly ValueSuggestion[]>();
  return {
    current: () => mergeSpoken(plan, answers),
    asks: plan.asks.map((a) => ({
      request: () => a.request,
      take: (answer) => {
        const found = a.read(answer);
        if (found.length === 0) return false;
        answers.set(a.fieldId, found);
        return true;
      },
    })),
  };
}

/** Multi-select fields (D-607) receive no candidates: candidates represent single values populated on tap, whereas multi-select requires users to pick multiple items. */
const jobOf = (raw: SuggestInput, limits: ModelLimits): Job => {
  const input = { ...raw, fields: raw.fields.filter((f) => !isMultipleChoice(f)) };
  return input.spoken ? spokenJob(input) : documentJob(input, limits);
};

/** Code-only engine: rule scoring, arithmetic, Chinese rules, and value memory. Used when no model is installed. */
export const ruleEngine: PrefillEngine = async (input) => jobOf(input, MODEL_LIMITS).current();

/**
 * Wait for work, but stop waiting if cancelled or timeout occurs (returns undefined). Work itself
 * might never return (native hang), and the form must not wait indefinitely (cancellation must
 * ensure the Promise settles).
 */
export function bounded<T>(
  work: Promise<T>,
  stop: AbortSignal,
  ms: number,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      stop.removeEventListener('abort', finish);
      resolve(undefined);
    };
    const timer = setTimeout(finish, ms);
    if (stop.aborted) return finish();
    stop.addEventListener('abort', finish);
    work.then(
      (value) => {
        clearTimeout(timer);
        stop.removeEventListener('abort', finish);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        stop.removeEventListener('abort', finish);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export const free = (session: ModelSession) => void session.release().catch(() => undefined);

/**
 * Code + on-device model (D-396): provide candidates from code first, then query the model field
 * by field for uncertain ones, supplying them one by one. If uninstalled, low memory, load
 * failure, timeout, or cancellation: silently finish, retain existing candidates, and do not
 * throw errors.
 */
export function modelEngine(open: OpenModel, limits: ModelLimits = MODEL_LIMITS): PrefillEngine {
  return async (input, signal, onPartial) => {
    const job = jobOf(input, limits);
    let current = job.current();
    onPartial?.(current);
    if (job.asks.length === 0 || signal?.aborted) return current;

    // Caller cancellation and total timeout both use this single signal, stopping generation as well.
    const stop = new AbortController();
    const abort = () => stop.abort();
    signal?.addEventListener('abort', abort);
    const total = setTimeout(abort, limits.totalMs);
    let session: ModelSession | null | undefined;
    try {
      const opening = open(stop.signal);
      // Stop waiting for loading (cancellation, timeout): release resources once it returns.
      session = await bounded(opening, stop.signal, limits.openMs);
      if (session === undefined) {
        void opening.then((late) => late && free(late)).catch(() => undefined);
        stop.abort();
        return current;
      }
      if (session === null) return current;
      for (const ask of job.asks) {
        const answer = await bounded(
          session.generate(ask.request(), stop.signal),
          stop.signal,
          limits.callMs,
        );
        // Hang or cancellation: do not query subsequent fields.
        if (answer === undefined) {
          stop.abort();
          break;
        }
        if (!ask.take(answer)) continue;
        current = job.current();
        onPartial?.(current);
      }
    } catch {
      // Fall back to existing candidates (D-396): model issues do not affect the form.
    } finally {
      clearTimeout(total);
      signal?.removeEventListener('abort', abort);
      if (session) free(session);
    }
    return current;
  };
}
