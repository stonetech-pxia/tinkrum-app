import { redactFileRefs } from '../file-refs';
import type { Registry } from '../registry';
import type { WorkspaceConfig } from '../schema';

export { REDACTED_FILE } from '../file-refs';

// Configuration sent to AI (D-065): user-authored text in quick action parameters (watermarks, text
// stamps) is replaced with placeholders; user file IDs are also replaced with placeholders
// (invariant 3).

export const REDACTED_TEXT = '<user text>';

export function redactForAI(config: WorkspaceConfig, registry: Registry): WorkspaceConfig {
  const files = redactFileRefs(config);
  return {
    ...files,
    tools: files.tools.map((tool) =>
      tool.kind !== 'quickAction'
        ? tool
        : {
            ...tool,
            steps: tool.steps.map((step) => {
              const fields = registry.actions.get(step.action)?.fields ?? [];
              const hidden = fields.filter((f) => f.private && step.params[f.key] !== undefined);
              if (hidden.length === 0) return step;
              const params = { ...step.params };
              for (const f of hidden) params[f.key] = REDACTED_TEXT;
              return { ...step, params };
            }),
          },
    ),
  };
}
