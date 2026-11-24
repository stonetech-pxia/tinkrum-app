import type { Registry } from '../registry';
import type { WorkspaceConfig } from '../schema';
import { viewOf, type AppView } from './capabilities';
import type { Scenario } from './scenarios';

export * from './capabilities';
export * from './scenarios';

// Scoring for personal record capability acceptance: config comes in, whether each requirement passes, core passing all is considered qualified. Pure function, read-only config.

export interface RequirementScore {
  id: string;
  core: boolean;
  pass: boolean;
}

export interface ScenarioScore {
  scenario: string;
  requirements: RequirementScore[];
  passed: number;
  total: number;
  corePassed: number;
  coreTotal: number;
  /** All core items passed. */
  qualified: boolean;
  /** Core items not yet passed (in scenario order). */
  missingCore: string[];
  /** Tool check blockers: do not affect qualification, workbench uses these to trigger "fill these in". */
  blockers: { code: string; target: string; message: string }[];
}

function scoreView(scenario: Scenario, view: AppView): ScenarioScore {
  const requirements = scenario.requirements.map(({ id, core, cap }) => ({
    id,
    core,
    pass: cap(view),
  }));
  const core = requirements.filter((r) => r.core);
  const missingCore = core.filter((r) => !r.pass).map((r) => r.id);
  return {
    scenario: scenario.id,
    requirements,
    passed: requirements.filter((r) => r.pass).length,
    total: requirements.length,
    corePassed: core.length - missingCore.length,
    coreTotal: core.length,
    qualified: missingCore.length === 0,
    missingCore,
    blockers: view.health.issues
      .filter((i) => i.severity === 'blocker')
      .map(({ code, target, message }) => ({ code, target, message })),
  };
}

export function scoreScenario(
  scenario: Scenario,
  config: WorkspaceConfig,
  registry: Registry,
): ScenarioScore {
  return scoreView(scenario, viewOf(config, registry));
}

/**
 * What the user should say next: unpassed core items in order, one sentence at a time; previously
 * spoken ones are skipped, restarts from the beginning once all spoken. Returns null if all
 * passed.
 */
export function nextAsk(
  scenario: Scenario,
  score: ScenarioScore,
  asked: ReadonlySet<string>,
): { id: string; text: string } | null {
  const missing = score.missingCore;
  const id = missing.find((x) => !asked.has(x)) ?? missing[0];
  if (id === undefined) return null;
  const requirement = scenario.requirements.find((r) => r.id === id)!;
  return { id, text: requirement.ask[scenario.locale] };
}
