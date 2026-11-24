import { t } from './messages';
import { localize } from './localization';
import type { Registry } from './registry';
import type { Locale, Workflow } from './schema';
import { formatParamValue } from './workflow/format';

// Suggestions based on usage habits (D-127): when the same choice is made in "Ask every run" for a
// quick action across several consecutive runs (e.g., always compressing to 200 KB), the result
// screen prompts whether to save it as a quick action that skips prompting and place it on the home
// screen. Statistics are kept entirely on-device, never sent to the AI, and never modify the app
// autonomously: an undoable modification is generated only when the user taps "Create one".

/** Number of consecutive identical choices required before suggesting. */
export const HABIT_RUNS = 3;

/** The answer provided for an "Ask every run" prompt during a single run. */
export interface AskedAnswer {
  stepId: string;
  values: Record<string, unknown>;
}

/** Local statistical record (one per quick action). */
export interface HabitRecord {
  /** Most recent answer (habitKey). */
  key: string;
  /** Number of consecutive times this answer was given. */
  count: number;
  /** Answers dismissed by the user via "No thanks", which will no longer be suggested. */
  dismissed: string[];
}

/** Only numbers, choices, and toggles are tracked; inputs like filenames, user-typed text, and colors are ignored. */
const REMEMBERED = new Set(['number', 'choice', 'toggle']);

/** Strip out answers that should not be tracked; returns null if nothing remains (this run is ignored). */
export function rememberedAnswers(
  workflow: Workflow,
  answers: readonly AskedAnswer[],
  registry: Registry,
): AskedAnswer[] | null {
  const out: AskedAnswer[] = [];
  for (const answer of answers) {
    const step = workflow.steps.find((s) => s.id === answer.stepId);
    const action = step ? registry.actions.get(step.action) : undefined;
    if (!action) continue;
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(answer.values)) {
      const field = action.fields.find((f) => f.key === key);
      if (!field || field.private || !REMEMBERED.has(field.kind)) continue;
      if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean')
        continue;
      values[key] = value;
    }
    if (Object.keys(values).length > 0) out.push({ stepId: answer.stepId, values });
  }
  return out.length > 0 ? out : null;
}

/** Stable representation of answers (keys sorted alphabetically), used to compare whether two runs match. */
export function habitKey(answers: readonly AskedAnswer[]): string {
  return JSON.stringify(
    [...answers]
      .sort((a, b) => a.stepId.localeCompare(b.stepId))
      .map((a) => [
        a.stepId,
        Object.keys(a.values)
          .sort()
          .map((k) => [k, a.values[k]]),
      ]),
  );
}

/** Log a run: increment count if identical to the last run, reset to 1 if different; clears if there are no trackable answers. */
export function recordHabit(prev: HabitRecord | null, key: string | null): HabitRecord {
  const dismissed = prev?.dismissed ?? [];
  if (key === null) return { key: '', count: 0, dismissed };
  return { key, count: prev?.key === key ? prev.count + 1 : 1, dismissed };
}

export const shouldSuggest = (record: HabitRecord): boolean =>
  record.count >= HABIT_RUNS && !record.dismissed.includes(record.key);

/** User tapped "No thanks": this answer will no longer be suggested. */
export const dismissHabit = (record: HabitRecord): HabitRecord => ({
  ...record,
  dismissed: [...record.dismissed.filter((k) => k !== record.key), record.key].slice(-10),
});

/** Format the answer into a short descriptive phrase: uses common specification names ("500 KB", "Passport 35x45"), falling back to the raw value. */
export function habitLabel(
  workflow: Workflow,
  answers: readonly AskedAnswer[],
  registry: Registry,
  locale: Locale,
  now: Date,
): string {
  const parts: string[] = [];
  for (const answer of answers) {
    const step = workflow.steps.find((s) => s.id === answer.stepId);
    const action = step ? registry.actions.get(step.action) : undefined;
    if (!action) continue;
    const keys = Object.keys(answer.values);
    const preset = action.presets?.find((p) => keys.every((k) => p.values[k] === answer.values[k]));
    if (preset) {
      parts.push(localize(preset.label, locale));
      continue;
    }
    for (const field of action.fields) {
      if (field.key in answer.values)
        parts.push(formatParamValue(field, answer.values[field.key], locale, now));
    }
  }
  return parts.join(t(locale, 'separatorList'));
}

/**
 * Newly created quick action: copies original steps, embeds the answers into parameters to skip
 * prompting for those items (while prompting for remaining ones like filenames). Treated as a
 * user-created quick action (without a package), so it will not disappear when removing a tool.
 */
export function habitWorkflow(
  workflow: Workflow,
  answers: readonly AskedAnswer[],
  id: string,
  name: string,
): Workflow {
  return {
    id,
    kind: 'quickAction',
    name,
    ...(workflow.icon ? { icon: workflow.icon } : {}),
    steps: workflow.steps.map((step) => {
      const answer = answers.find((a) => a.stepId === step.id);
      if (!answer) return step;
      const ask = (step.ask ?? []).filter((k) => !(k in answer.values));
      const { ask: _old, ...rest } = step;
      return {
        ...rest,
        params: { ...step.params, ...answer.values },
        ...(ask.length > 0 ? { ask } : {}),
      };
    }),
  };
}

/** Suppress suggestions if an identical quick action (matching steps and parameters) already exists among user quick actions. */
export function hasSameWorkflow(workflows: readonly Workflow[], candidate: Workflow): boolean {
  const shape = (w: Workflow) =>
    JSON.stringify(w.steps.map((s) => [s.action, s.params, s.ask ?? []]));
  return workflows.some((w) => !w.package && shape(w) === shape(candidate));
}
