// Evaluations and acceptance (for development, excluded from the app): real model evaluation sets,
// personal record capability acceptance scenarios, and scoring. Not exported from the @morph/core
// main entry point (R12): almost all app imports come from the main entry point, and the evaluation
// set has over seven thousand lines, so it should not be bundled. Usage: import { EVAL_CASES,
// runEvalCase } from '@morph/core/src/eval'; (following the src path just like
// @morph/tool-office/src/test-helpers). Mock AI (ai/mock) is an offline app feature and remains in
// the main entry point.

export * from './ai/eval-cases';
export * from './acceptance';
