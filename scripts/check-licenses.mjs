// Scan the license field of all installed packages in node_modules, exiting with code 1 if any
// license incompatible with AGPL-3.0 or unknown is found. Usage: npm run check:licenses
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Licenses compatible with AGPL-3.0 (matched verbatim by SPDX expression). Before adding new entries, verify compatibility and record it in docs/DECISIONS.md.
const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Unlicense',
  'Python-2.0',
  'MPL-2.0',
  'AGPL-3.0-only',
  'MIT AND Apache-2.0',
  '(MIT AND Zlib)', // pako (dependency of pdf-lib): Zlib is a permissive license, compatible with GPL.
  'MIT AND OFL-1.1', // @expo-google-fonts/sora, karla: Code is MIT, font files are OFL-1.1 (fonts can be distributed with any software).
  '(MIT OR Apache-2.0)',
  '(MIT OR CC0-1.0)',
  '(BSD-2-Clause OR MIT OR Apache-2.0)',
  '(BSD-3-Clause OR GPL-2.0)', // node-forge: Used under BSD-3-Clause.
  '(MIT OR GPL-3.0-or-later)', // jszip (dependency of mammoth, D-186): Used under MIT.
  'BSD', // duck (dependency of mammoth, D-186): package.json specifies BSD, LICENSE file is original BSD-2-Clause.
]);

// Exception rule for this package only: Public Domain is not a clear license, so it is not allowed globally.
const ALLOWED_FOR = new Map([
  ['jsonify', 'Public Domain'], // patch-package dependency (D-399): Used for patching during installation, not included in the app.
]);

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  return 'UNKNOWN';
}

const problems = [];
const seen = new Set();

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const pkgDir = path.join(dir, name);
    if (name.startsWith('@')) {
      walk(pkgDir);
      continue;
    }
    const manifest = path.join(pkgDir, 'package.json');
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const id = `${pkg.name}@${pkg.version}`;
      const license = licenseOf(pkg);
      if (!seen.has(id) && !ALLOWED.has(license) && ALLOWED_FOR.get(pkg.name) !== license)
        problems.push(`${id}: ${license}`);
      seen.add(id);
    }
    walk(path.join(pkgDir, 'node_modules'));
  }
}

walk('node_modules');

// Local C libraries are not in the npm manifest: also check SPDX, and cross-check manually reviewed upstream source code and license text.
const dspRoot = 'apps/mobile/modules/morph-media/dsp';
const nativeLibraries = JSON.parse(
  fs.readFileSync(path.join(dspRoot, 'dependencies.json'), 'utf8'),
);
for (const lib of nativeLibraries) {
  if (!ALLOWED.has(lib.license)) problems.push(`${lib.name}@${lib.version}: ${lib.license}`);
  for (const file of lib.files) {
    const hash = createHash('sha256')
      .update(fs.readFileSync(path.join(dspRoot, file.path)))
      .digest('hex');
    if (hash !== file.sha256) problems.push(`${lib.name}: source or license changed: ${file.path}`);
  }
}

if (problems.length > 0) {
  console.error(
    'The following dependency licenses are not in the allowlist and need manual AGPL-3.0 compatibility review:',
  );
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `Checked ${seen.size} dependencies (all licenses allowed) and ${nativeLibraries.length} local C dependencies with source/license checksums.`,
);
