// Portal "Clay" preset (App file, D-487): a refined version of the default interface for new
// users—quick actions for scanning and converting are placed first, files are organized by type,
// and the toolbox is on the bottom bar. Pure configuration, with no tables, no records, and no user
// files. Usage: npx tsx scripts/build-clay-app.ts <output_dir
// (packages/core/src/fixtures/portal-apps)>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { prepareOps } from '../packages/core/src/change';
import {
  appFileFromWorkspace,
  appFileOps,
  appFileText,
  readAppFile,
} from '../packages/core/src/app-file';
import { createRegistry } from '../packages/core/src/registry';
import {
  createStarterWorkspace,
  filesByTypePage,
  paperBlocks,
  toolboxPage,
} from '../packages/core/src/starter';
import { BUILTIN_TOOLS } from '../packages/core/src/tools';
import { validateWorkspace } from '../packages/core/src/validate';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: build-clay-app.ts <out dir>');
const registry = createRegistry(BUILTIN_TOOLS);
const NOW = new Date('2026-11-07T12:00:00');
const ctx = { registry, locale: 'en' as const, now: NOW };

// 1. The scanner layout (D-487, also the Paper app the guide builds, D-new-apphome-2) as a whole
// workspace: its blocks on the home page, the toolbox on the bottom bar, and a "Files" page
// that shelves files by type.
const starter = createStarterWorkspace('en', registry);
const config = structuredClone(starter);
const home = config.containers.pages.find((p) => p.id === 'home')!;
home.blocks = paperBlocks(config, 'en', 'Tinkrum');
// The Files page is generated according to the language and displays matching the interface language after import (D-582).
config.containers.pages.push(toolboxPage('en', registry), filesByTypePage('en'));
// D-552: preset page background uses solid sand color instead of STARTER_THEME's gradient (sage green in the bottom half appears grayish, resembling a color mist).
config.theme.backdrop = 'plain';
// The bottom bar of the entire configuration must include settings; settings are removed when converted to an app file (app bottom bars only contain pages and Tink).
config.nav.bar = ['page:home', 'page:files', 'page:toolbox', 'ai', 'settings'];

const valid = validateWorkspace(config, registry);
if (!valid.ok) throw new Error(valid.issues.map((i) => `${i.code}: ${i.message}`).join('\n'));

// 3. Convert to an app file, read it back, and test by importing it into a new user's workspace.
const file = appFileFromWorkspace(config, { id: 'clay', name: 'Clay', icon: 'paper' });
const text = appFileText(file, NOW);
const back = readAppFile(text);
if (!back) throw new Error('written file does not read back');
const plan = appFileOps(back, createStarterWorkspace('en', registry));
if (!plan.ok) throw new Error(plan.error);
const check = prepareOps(createStarterWorkspace('en', registry), plan.ops, ctx);
if (!check.ok) throw new Error(check.issues.join('; '));
writeFileSync(join(outDir, 'tinkrum-app-clay.json'), text);

// 4. Add (or update) an entry in the manifest, placed at the top.
const manifestPath = join(outDir, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { apps: { id: string }[] };
const entry = {
  id: 'clay',
  name: 'Clay',
  tagline: 'The Tinkrum look, refined: scan shortcuts up front, a shelf for every file',
  style: 'Clay',
  file: 'tinkrum-app-clay.json',
  schemaVersion: file.schemaVersion,
  pages: config.containers.pages.filter((p) => p.package === undefined).map((p) => p.title),
  tables: [],
  reminders: 0,
  quickActions: 0,
  features: [
    'One-tap scan to PDF, Word or Excel, and combine documents',
    'Open files from the photo library or Files',
    'Recent actions and recent files on the home page',
    'Files shelved by type: PDF, Word, Excel, pictures',
    'Toolbox in the bar; light and dark follow the phone',
  ],
  includesRecords: false,
  icon: 'paper',
};
manifest.apps = [entry, ...manifest.apps.filter((a) => a.id !== 'clay')];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log('OK clay', plan.ops.length, 'steps');
