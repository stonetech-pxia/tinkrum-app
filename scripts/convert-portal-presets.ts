// Convert portal display presets (full workspace app configurations) into "App files" (tinkrum-app,
// D-485): Each preset is an app, ID is prefixed with the app prefix, home page becomes the first
// page of the app, and during import it is added to the existing workspace without replacing
// anything. Usage: npx tsx scripts/convert-portal-presets.ts <old preset directory (with
// manifest.json)> <output directory>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { prepareOps, prepareSnapshot } from '../packages/core/src/change';
import {
  appFileFromWorkspace,
  appFileOps,
  appFileText,
  readAppFile,
} from '../packages/core/src/app-file';
import { readAppConfigFile } from '../packages/core/src/config-file';
import { createRegistry } from '../packages/core/src/registry';
import { createStarterWorkspace } from '../packages/core/src/starter';
import { BUILTIN_TOOLS } from '../packages/core/src/tools';
import type { IconValue } from '../packages/core/src/schema-base';

// Old preset ID (from manifest) → App ID and icon (graphical icons included in assets/preset-icons).
const APPS: Record<string, { id: string; icon: IconValue }> = {
  neon: { id: 'wallet', icon: 'wallet' },
  orbs: { id: 'habits', icon: 'rings' },
  soft: { id: 'rest', icon: 'moon' },
  terminal: { id: 'focus', icon: 'timer' },
  editorial: { id: 'reading', icon: 'book' },
  brutal: { id: 'sprint', icon: 'board' },
  glass: { id: 'trip', icon: 'suitcase' },
  y2k: { id: 'crate', icon: 'vinyl' },
};

const [inDir, outDir] = process.argv.slice(2);
if (!inDir || !outDir) throw new Error('usage: convert-portal-presets.ts <in> <out>');
const registry = createRegistry(BUILTIN_TOOLS);
const manifest = JSON.parse(readFileSync(join(inDir, 'manifest.json'), 'utf8')) as {
  presets: Record<string, unknown>[];
};
mkdirSync(outDir, { recursive: true });
const NOW = new Date('2026-11-07T12:00:00');
const index: unknown[] = [];
for (const entry of manifest.presets) {
  const old = String(entry.id);
  const meta = APPS[old];
  if (!meta) throw new Error(`no app mapping for preset ${old}`);
  // First migrate to the current version, then validate.
  const raw = readAppConfigFile(readFileSync(join(inDir, String(entry.file)), 'utf8'));
  const prepared = prepareSnapshot(raw, registry);
  if (!prepared.ok) throw new Error(`${old}: ${prepared.issues.join('; ')}`);
  const file = appFileFromWorkspace(prepared.after, {
    id: meta.id,
    name: String(entry.name),
    icon: meta.icon,
  });
  const text = appFileText(file, NOW);
  // Converted files must be readable and successfully importable into a new user's workspace (preview valid).
  const back = readAppFile(text);
  if (!back) throw new Error(`${old}: written file does not read back`);
  const plan = appFileOps(back, createStarterWorkspace('en', registry));
  if (!plan.ok) throw new Error(`${old}: ${plan.error}`);
  const check = prepareOps(createStarterWorkspace('en', registry), plan.ops, {
    registry,
    locale: 'en',
    now: NOW,
  });
  if (!check.ok) throw new Error(`${old}: ${check.issues.join('; ')}`);
  const name = `tinkrum-app-${meta.id}.json`;
  writeFileSync(join(outDir, name), text);
  index.push({
    ...entry,
    id: meta.id,
    file: name,
    icon: meta.icon,
    schemaVersion: file.schemaVersion,
  });
  console.log('OK', old, '→', name, `${plan.ops.length} steps`);
}
writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify({ format: 'tinkrum-app-index', version: 1, apps: index }, null, 2),
);
