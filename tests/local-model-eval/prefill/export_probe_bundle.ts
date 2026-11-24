// For simulator probe: pack 477 ocr.txt files in data/ into a single JSON (id, language, text) to
// be read temporarily in the app. Usage (repository root): npx tsx
// tests/local-model-eval/prefill/export_probe_bundle.ts <output-path> The output file is for probes
// only and should not be committed.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const data = join(import.meta.dirname, '..', 'data');
const out: { id: string; lang: string; text: string }[] = [];
for (const name of readdirSync(data).sort()) {
  try {
    const meta = JSON.parse(readFileSync(join(data, name, 'meta.json'), 'utf8'));
    out.push({
      id: name,
      lang: meta.language,
      text: readFileSync(join(data, name, 'ocr.txt'), 'utf8'),
    });
  } catch {
    // manifest.json and similar files are not samples.
  }
}
writeFileSync(process.argv[2]!, JSON.stringify(out));
console.log(out.length, 'samples');
