import type { Registry } from '../registry';
import type { Workflow, WorkflowStep } from '../schema';
import {
  actionAccepts,
  handedFileTypeOf,
  handedTypeOf,
  isSourceAction,
  outputTypeOf,
  type ActionDefinition,
  type HandedType,
  type ValueType,
} from './contract';

// Workflow static checks (D-060): action registration, parameters, runtime-prompted parameters, and
// type compatibility between adjacent steps. Shared by the validator, editor (listing insertable
// actions only), and executor.

export interface StepProblem {
  stepId: string;
  code: 'unknown-action' | 'params' | 'ask' | 'binding' | 'source';
  message: string;
}

/**
 * What input this quick action expects from the container (D-428): when the first step is not an
 * input action and accepts text, records, or files, it is that value type; otherwise null (manual
 * input selection). Such quick actions can only run from containers that can supply such values:
 * record page buttons, record blocks, single record blocks.
 */
export function handedInput(steps: readonly WorkflowStep[], registry: Registry): HandedType | null {
  const first = steps[0] && registry.actions.get(steps[0].action);
  return first && !isSourceAction(first) ? handedTypeOf(first) : null;
}

/**
 * The value type supplied by the container as viewed by the first step: text, records, or the
 * file type accepted by the first step (pdf, images, etc.). handedInput specifies the category,
 * while this defines types for subsequent steps.
 */
export function handedValueType(
  steps: readonly WorkflowStep[],
  registry: Registry,
): ValueType | null {
  const first = steps[0] && registry.actions.get(steps[0].action);
  if (!first || isSourceAction(first)) return null;
  const handed = handedTypeOf(first);
  return handed === 'files' ? handedFileTypeOf(first) : handed;
}

/**
 * Value type after executing each step (index i = output of step i). Returns null upon
 * encountering undetermined steps (unregistered or type mismatch).
 */
export function typesAlong(
  steps: readonly WorkflowStep[],
  registry: Registry,
): (ValueType | null)[] {
  const out: (ValueType | null)[] = [];
  let current: ValueType | null = handedValueType(steps, registry);
  let broken = false;
  for (const [i, step] of steps.entries()) {
    const action = registry.actions.get(step.action);
    if (broken || !action) {
      broken = true;
      out.push(null);
      continue;
    }
    if (isSourceAction(action) ? i !== 0 : current === null || !actionAccepts(action, current)) {
      broken = true;
      out.push(null);
      continue;
    }
    current = outputTypeOf(action, step.params, current);
    out.push(current);
  }
  return out;
}

/** Actions insertable before the given index (step 0 can only be an input action; subsequent steps must bridge preceding and succeeding steps). */
export function insertableActions(
  steps: readonly WorkflowStep[],
  index: number,
  registry: Registry,
): ActionDefinition[] {
  const types = typesAlong(steps, registry);
  const before = index === 0 ? null : (types[index - 1] ?? null);
  if (index > 0 && before === null) return [];
  const next = steps[index] ? registry.actions.get(steps[index]!.action) : undefined;
  return [...registry.actions.values()].filter((action) => {
    if (index === 0) {
      // The first step can only be an input action, and the original first step (also an input action) cannot be pushed down.
      return isSourceAction(action) && (!next || !isSourceAction(next));
    }
    if (isSourceAction(action) || !actionAccepts(action, before!)) return false;
    if (!next) return true;
    const defaults = defaultParams(action);
    const produced = outputTypeOf(action, defaults ?? {}, before);
    return produced !== null && !isSourceAction(next) && actionAccepts(next, produced);
  });
}

/**
 * Parameters when inserting a new step: default parameters, or initial values generated from UI
 * metadata per parameter (first option, minimum number, toggle off, empty text). Results may not
 * pass validation (e.g., required text), prompting the user to fill them in the editor.
 */
export function initialParams(action: ActionDefinition): Record<string, unknown> {
  const defaults = defaultParams(action);
  if (defaults) return defaults;
  const params: Record<string, unknown> = {};
  for (const f of action.fields) {
    if (f.showIf || f.kind === 'secret') continue;
    if (f.kind === 'choice') params[f.key] = f.options?.[0]?.value;
    else if (f.kind === 'number') params[f.key] = f.initial ?? f.min ?? 0;
    else if (f.kind === 'toggle') params[f.key] = false;
    else if (f.kind === 'fields') params[f.key] = [];
    else params[f.key] = '';
  }
  return params;
}

/** Default action parameters: first preset, or {} if the parameter schema accepts an empty object. */
export function defaultParams(action: ActionDefinition): Record<string, unknown> | null {
  const preset = action.presets?.[0]?.values;
  if (preset && action.params.safeParse(preset).success) return { ...preset };
  return action.params.safeParse({}).success ? {} : null;
}

export function workflowProblems(wf: Workflow, registry: Registry): StepProblem[] {
  const problems: StepProblem[] = [];
  let current: ValueType | null = handedValueType(wf.steps, registry);
  let broken = false;
  for (const [i, step] of wf.steps.entries()) {
    const problem = (code: StepProblem['code'], message: string) =>
      problems.push({ stepId: step.id, code, message: `${wf.id}/${step.id}: ${message}` });
    const action = registry.actions.get(step.action);
    if (!action) {
      problem('unknown-action', `action ${step.action} is not registered`);
      broken = true;
      continue;
    }
    const parsed = action.params.safeParse(step.params);
    if (!parsed.success) {
      problem(
        'params',
        parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; '),
      );
    }
    const keys = new Set(action.fields.map((f) => f.key));
    for (const key of step.ask ?? []) {
      if (action.fields.some((f) => f.key === key && (f.bindsInput || f.fixed)))
        problem('ask', `${key} is fixed in the quick action settings`);
      if (!keys.has(key)) problem('ask', `${key} is not a parameter of ${action.id}`);
    }
    if (isSourceAction(action)) {
      if (i !== 0) {
        problem('source', `${action.id} chooses the input and must be the first step`);
        broken = true;
      }
    } else if (i === 0) {
      // Actions that receive text or records do not require input steps (D-428): executed upon container tap.
      if (current === null) {
        problem(
          'source',
          `the first step must choose the input (photos or files), not ${action.id}`,
        );
        broken = true;
      }
    } else if (!broken && current !== null && !actionAccepts(action, current)) {
      problem(
        'binding',
        action.rejects?.includes(current)
          ? `${action.id} does not take ${current}`
          : `${action.id} needs ${action.input.join(' or ')} but the previous step gives ${current}`,
      );
      broken = true;
    }
    if (!broken)
      current = outputTypeOf(action, parsed.success ? parsed.data : step.params, current);
  }
  return problems;
}
