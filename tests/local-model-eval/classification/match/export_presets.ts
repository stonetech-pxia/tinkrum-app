// Export candidates for "content-based recommendation" evaluations (name, description, supported
// file types) from repository preset quick actions. Usage (repository root): npx tsx
// tests/local-model-eval/classification/match/export_presets.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { WORKFLOW_PRESETS } from '../../../../packages/core/src/workflows/presets';

// Only include preset quick actions related to file contents; presets sorted by file type and count (already covered in D-237) are not compared here.
const CONTENT_PRESETS = ['receipt-archive', 'expense-report', 'sign-return', 'redact-screenshots'];

const accepts = (first: { action: string; params: Record<string, unknown> }) =>
  first.action === 'in.files' && first.params.accept === 'pdf' ? ['pdf'] : ['image'];

const out = CONTENT_PRESETS.map((id) => {
  const preset = WORKFLOW_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`missing preset ${id}`);
  return {
    id,
    name: preset.name,
    description: preset.description,
    accepts: accepts(preset.steps('en')[0]!),
  };
});
writeFileSync(join(import.meta.dirname, 'presets.json'), JSON.stringify(out, null, 2) + '\n');
console.log(out.map((p) => `${p.id} ${p.accepts.join(',')}`).join('\n'));
