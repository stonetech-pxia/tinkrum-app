// Compute text readability (text-classify.ts) and rule matching (text-rules.ts) for each text
// segment using the same app code, for Python evaluation use. Usage (repository root): npx tsx
// tests/local-model-eval/classification/ts_features.ts <cases.jsonl> Outputs to stdout, one JSON
// object per line: `{"id","readability","rules"}`; text content itself is not output.
import { readFileSync } from 'node:fs';

import { textReadability } from '../../../packages/core/src/text-classify';
import { extractFirst, type TextRule } from '../../../packages/core/src/text-rules';

const RULES: TextRule[] = ['amount', 'date', 'invoiceNo', 'phone', 'email', 'url'];

for (const line of readFileSync(process.argv[2]!, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const row = JSON.parse(line) as { id: string; lang: 'zh' | 'en' | 'fr'; text: string };
  const rules = Object.fromEntries(
    RULES.map((rule) => [rule, extractFirst(row.text, rule, row.lang) !== null]),
  );
  console.log(JSON.stringify({ id: row.id, readability: textReadability(row.text), rules }));
}
