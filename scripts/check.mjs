import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const full = () => [{ id: 'full', args: ['run', 'check:full'] }];
const task = (name) => ({ id: name, args: ['run', name] });

// Select checks by package; do not use import graphs to guess whether a test reads files, scans directories, or loads dynamically.
export function selectChecks(paths, workspaces) {
  const owners = new Set();
  let dsp = false,
    archive = false;
  for (const path of paths) {
    if (path.startsWith('docs/agent/') || path === 'docs/MOCK_AI_PHRASES.md') return full();
    if (/\.md$/.test(path) && (path.startsWith('docs/') || !path.includes('/'))) continue;
    const owner = workspaces.find((w) => path.startsWith(w.path + '/'));
    if (
      !owner ||
      owner.name === '@morph/core' ||
      /^(package\.json|.*(?:config|setup).*\.[cm]?[jt]s(?:on)?|tsconfig.*)$/.test(basename(path))
    )
      return full();
    owners.add(owner.name);
    dsp ||= path.startsWith('apps/mobile/modules/morph-media/dsp/');
    archive ||= path.startsWith('apps/mobile/modules/morph-archive/');
  }
  const format = {
    id: `format:${hash(JSON.stringify(paths))}`,
    args: ['exec', '--', 'prettier', '--check', '--ignore-unknown', '--', ...paths],
  };
  if (!owners.size) return paths.length ? [format] : [];
  // Transitively include all reverse dependencies, including dev and peer dependencies.
  for (let size = -1; size !== owners.size;) {
    size = owners.size;
    for (const w of workspaces)
      if (w.dependencies.some((name) => owners.has(name))) owners.add(w.name);
  }
  const selected = [task('lint'), format, task('check:locales')];
  for (const w of workspaces.filter((w) => owners.has(w.name))) {
    for (const script of ['typecheck', 'test'])
      if (w.scripts[script])
        selected.push({
          id: `${w.name}:${script}`,
          args: ['run', script, '--workspace', w.name],
        });
  }
  // Core network and other invariant tests also scan app/planner source files, which are not in the npm reverse dependency graph.
  selected.push({
    id: 'core:invariants',
    args: ['exec', '--workspace', '@morph/core', '--', 'vitest', 'run', 'src/invariants.test.ts'],
  });
  if (dsp) selected.push(task('test:native-dsp'), task('check:licenses'));
  if (archive) selected.push(task('test:native-archive'));
  return selected;
}

function checkEnvironment() {
  const env = { ...process.env };
  // Invocation metadata introduced by npm lifecycle and Git hooks does not affect checks; nested Git tests must not point to the outer repository either.
  for (const key of Object.keys(env))
    if (
      /^npm_/i.test(key) ||
      [
        'INIT_CWD',
        'PWD',
        'OLDPWD',
        'SHLVL',
        '_',
        'NODE_TEST_CONTEXT',
        'CODEX_TOOL_CALL_ID',
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_COMMON_DIR',
        'GIT_INDEX_FILE',
        'GIT_PREFIX',
        'GIT_EXEC_PATH',
      ].includes(key)
    )
      delete env[key];
  env.VITEST_MAX_WORKERS ??= '1';
  // npm run injects .bin, NODE, and COLOR; direct Git hooks and npm run check must run in the exact same environment.
  env.PATH = (env.PATH ?? '')
    .split(delimiter)
    .filter((path) => !/\/node_modules\/\.bin$|\/npm\/.*\/node-gyp-bin$/.test(path))
    .join(delimiter);
  env.NODE = process.execPath;
  env.COLOR = '0';
  env.EDITOR ??= 'vi';
  return env;
}
function command(bin, args, cwd, env, capture = true) {
  const r = spawnSync(bin, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0)
    throw new Error(`${bin} ${args.join(' ')} failed (exit ${r.status ?? 'unavailable'}).`);
  return r.stdout?.trimEnd() ?? '';
}
function installationState(path) {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return [
    realpathSync(path),
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
    stat.isFile() ? hash(readFileSync(path)) : null,
  ];
}
function fingerprint(repo, workspaces, env) {
  const installs = ['', ...workspaces.map((w) => w.path)].flatMap((path) => {
    const dir = join(repo, path, 'node_modules');
    return [installationState(dir), installationState(join(dir, '.package-lock.json'))];
  });
  return hash(
    JSON.stringify({
      node: [process.version, process.execPath],
      npm: command('npm', ['--version'], repo, env),
      system: [process.platform, process.arch],
      installs,
      env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    }),
  );
}
function readReceipt(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value.version === 1 && Array.isArray(value.passed) ? value.passed : [];
  } catch {
    return [];
  }
}

export function runChecks(mode, input = '') {
  const env = checkEnvironment();
  const here = process.cwd();
  const repo = command('git', ['rev-parse', '--show-toplevel'], here, env);
  const git = (...args) => command('git', args, repo, env);
  const head = git('rev-parse', 'HEAD');
  const clean = () => !git('status', '--porcelain');
  let paths,
    mustRunFull = false;
  if (mode === '--push') {
    let updates = 0;
    const changed = new Set();
    for (const line of input.trim().split('\n').filter(Boolean)) {
      const fields = line.split(/\s+/);
      if (fields.length !== 4) throw new Error('pre-push: invalid ref input.');
      const [, local, remoteRef, remote] = fields;
      if (/^0+$/.test(local)) continue;
      updates++;
      if (git('rev-parse', '--verify', `${local}^{commit}`) !== head)
        throw new Error('pre-push: push from the clean checkout of the commit being sent.');
      if (/^refs\/(?:tags\/|heads\/(?:main|master)$)/.test(remoteRef) || /^0+$/.test(remote)) {
        mustRunFull = true;
        continue;
      }
      // New branches, missing remote objects, and force pushes cannot be reliably scoped, so fall back to a full check without guessing local main.
      try {
        git('merge-base', '--is-ancestor', remote, head);
        const diff = git('diff', '--name-only', '-z', '--no-renames', remote, head);
        for (const path of diff.split('\0').filter(Boolean)) changed.add(path);
      } catch {
        mustRunFull = true;
      }
    }
    if (!updates) return;
    if (!clean())
      throw new Error(
        'pre-push: commit or set aside local changes before checking the pushed commit.',
      );
    paths = [...changed].sort();
    if (paths.length > 200) mustRunFull = true;
  }
  const manifests = git('ls-files', '-z', 'apps/*/package.json', 'packages/*/package.json')
    .split('\0')
    .filter(Boolean);
  const workspaces = manifests.map((path) => {
    const pkg = JSON.parse(readFileSync(join(repo, path), 'utf8'));
    return {
      name: pkg.name,
      path: dirname(path),
      scripts: pkg.scripts ?? {},
      dependencies: Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      }),
    };
  });
  const selected = (
    mode === '--full' || mustRunFull ? full() : selectChecks(paths, workspaces)
  ).flatMap((check) => {
    if (!check.id.startsWith('format:')) return [check];
    // Deleted files participate in scope determination, but since they no longer exist, they cannot be passed to prettier.
    const files = paths.filter((path) => existsSync(join(repo, path)));
    return files.length ? [{ ...check, args: [...check.args.slice(0, 6), ...files] }] : [];
  });
  const wasClean = clean();
  const before = fingerprint(repo, workspaces, env);
  const cacheDir = git('rev-parse', '--git-path', 'morph-checks');
  const cacheFile = resolve(repo, cacheDir, `${hash(head + before)}.json`);
  const passed = readReceipt(cacheFile);
  // Withdraw old credentials when actively re-running a full acceptance check; a failure must not allow bypassing push checks using a previous success.
  if (mode === '--full' && wasClean) rmSync(cacheFile, { force: true });
  const needed =
    mode === '--full'
      ? selected
      : selected.filter((s) => !passed.includes('full') && !passed.includes(s.id));
  if (!needed.length && selected.length)
    console.log('pre-push: reusing successful checks for this commit and environment.');
  for (const check of needed) {
    console.log(`${mode === '--push' ? 'pre-push' : 'check'}: running npm ${check.args.join(' ')}`);
    command('npm', check.args, repo, env, false);
  }
  const unchanged =
    git('rev-parse', 'HEAD') === head && clean() && fingerprint(repo, workspaces, env) === before;
  if (mode === '--push' && !unchanged)
    throw new Error(
      'pre-push: checkout or environment changed while checks were running; check the final commit again.',
    );
  if (wasClean && unchanged && selected.length) {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        version: 1,
        at: new Date().toISOString(),
        passed: [...new Set([...passed, ...selected.map((s) => s.id)])],
      }) + '\n',
      { mode: 0o600 },
    );
    renameSync(tmp, cacheFile);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (!['--full', '--push'].includes(mode))
      throw new Error('Usage: node scripts/check.mjs --full|--push');
    runChecks(mode, mode === '--push' ? readFileSync(0, 'utf8') : '');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
