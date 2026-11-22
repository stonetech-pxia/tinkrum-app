import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function cmd(bin, args, cwd, env = process.env) {
  // 子进程中的 node --test 是独立命令，不能继承父测试 runner 的递归标记。
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  return spawnSync(bin, args, { cwd, env: childEnv, encoding: 'utf8' });
}
function git(repo, ...args) {
  const result = cmd('git', args, repo);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'morph-release-test-')));
  roots.push(root);
  const repo = join(root, 'checkout with spaces');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Release test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  mkdirSync(join(repo, 'apps/api'), { recursive: true });
  writeFileSync(join(repo, 'apps/api/main.txt'), 'first\n');
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ scripts: { check: 'node --test behavior.test.cjs' } }),
  );
  writeFileSync(join(repo, 'behavior.test.cjs'), "require('node:assert/strict').equal(1, 1);\n");
  mkdirSync(join(repo, '.githooks'));
  copyFileSync(join(source, '.githooks/pre-push'), join(repo, '.githooks/pre-push'));
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(join(source, 'scripts/install-hooks.sh'), join(repo, 'scripts/install-hooks.sh'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'first');
  const previous = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'apps/api/main.txt'), 'second\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'second');
  const target = git(repo, 'rev-parse', 'HEAD');
  return { root, repo, previous, target };
}
function deployFixture() {
  const f = fixture();
  git(f.repo, 'checkout', '--detach', f.previous);
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const trace = join(f.root, 'trace');
  const executable = (name, body) =>
    writeFileSync(join(bin, name), '#!/bin/sh\nset -eu\n' + body, { mode: 0o755 });
  // 真实 Git 操作；npm、launchd 和 health 只用替身，绝不接触生产进程或端口。
  executable(
    'npm',
    'echo "npm:$*:$(pwd)" >> "$TEST_TRACE"\nif [ "$*" = "run check" ] && [ "${TEST_FAIL_CHECK:-0}" = 1 ]; then exit 7; fi\n',
  );
  executable(
    'launchctl',
    'echo "launchctl:$*" >> "$TEST_TRACE"\nif [ "$1" = print ]; then echo "working directory = ${TEST_SERVICE_DIRECTORY:-$TEST_REPO/apps/api}"; else git -C "$TEST_REPO" rev-parse --verify refs/tags/api-test >> "$TEST_TRACE"; fi\n',
  );
  executable(
    'curl',
    'head=$(git -C "$TEST_REPO" rev-parse HEAD)\nif [ "$head" = "${TEST_FAIL_HEALTH:-never}" ]; then echo \'{"ok":false}\'; else echo \'{"ok":true}\'; fi\n',
  );
  const env = {
    ...process.env,
    PATH: bin + ':' + process.env.PATH,
    TEST_TRACE: trace,
    TEST_REPO: f.repo,
  };
  const deploy = (extra = [], changes = {}) =>
    cmd(
      'sh',
      [
        join(source, 'scripts/deploy.sh'),
        '--repo',
        f.repo,
        '--ref',
        f.target,
        '--tag',
        'api-test',
        ...extra,
      ],
      f.root,
      { ...env, ...changes },
    );
  return { ...f, trace, deploy };
}

test('a real git push --dry-run runs the check, blocks a failing test, and never publishes', () => {
  const f = fixture(),
    remote = join(f.root, 'remote.git');
  git(f.root, 'init', '--bare', remote);
  git(f.repo, 'remote', 'add', 'fixture', remote);
  assert.equal(cmd('sh', [join(source, 'scripts/install-hooks.sh')], f.repo).status, 0);
  let result = cmd('git', ['push', '--dry-run', 'fixture', 'HEAD:main'], f.repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pre-push: running npm run check/);
  writeFileSync(join(f.repo, 'behavior.test.cjs'), "require('node:assert/strict').equal(1, 2);\n");
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'a deliberately failing test');
  result = cmd('git', ['push', '--dry-run', 'fixture', 'HEAD:main'], f.repo);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /npm run check/);
  assert.equal(cmd('git', ['show-ref'], remote).status, 1);
});

test('hooks are installed only for the selected worktree', () => {
  const f = fixture(),
    other = join(f.root, 'linked');
  git(f.repo, 'worktree', 'add', '--detach', other, f.target);
  assert.equal(cmd('sh', [join(source, 'scripts/install-hooks.sh')], other).status, 0);
  assert.equal(
    git(other, 'config', '--worktree', '--get', 'core.hooksPath'),
    join(other, '.githooks'),
  );
  assert.equal(cmd('git', ['config', '--get', 'core.hooksPath'], f.repo).status, 1);
});

test('pre-push refuses dirty or different-commit checkouts', () => {
  const f = fixture(),
    hook = join(source, '.githooks/pre-push');
  const invoke = (oid) =>
    spawnSync('sh', [hook], {
      cwd: f.repo,
      encoding: 'utf8',
      input: `refs/heads/main ${oid} refs/heads/main ${'0'.repeat(40)}\n`,
    });
  assert.match(invoke(f.previous).stderr, /commit being sent/);
  writeFileSync(join(f.repo, 'apps/api/main.txt'), 'uncommitted\n');
  assert.match(invoke(f.target).stderr, /local changes/);
});

test('deployment preview does not change refs, HEAD, worktrees or services', () => {
  const f = deployFixture(),
    before = git(f.repo, 'worktree', 'list', '--porcelain');
  const result = f.deploy();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plan only/);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.previous);
  assert.equal(git(f.repo, 'tag', '--list'), '');
  assert.equal(git(f.repo, 'worktree', 'list', '--porcelain'), before);
  assert.doesNotMatch(readFileSync(f.trace, 'utf8'), /kickstart|npm:/);
});

test('failed validation leaves production checkout and release tags untouched', () => {
  const f = deployFixture(),
    result = f.deploy(['--apply'], { TEST_FAIL_CHECK: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.previous);
  assert.equal(git(f.repo, 'tag', '--list'), '');
  assert.doesNotMatch(readFileSync(f.trace, 'utf8'), /kickstart/);
  assert.equal(git(f.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
});

test('validated release is tagged before restart and records the previous commit', () => {
  const f = deployFixture(),
    result = f.deploy(['--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.target);
  assert.equal(git(f.repo, 'rev-parse', 'api-test^{commit}'), f.target);
  const lines = readFileSync(f.trace, 'utf8').trim().split('\n');
  const check = lines.findIndex((s) => s.startsWith('npm:run check:'));
  const productionInstall = lines.findIndex((s) => s === `npm:ci:${f.repo}`);
  const restart = lines.findIndex((s) => s.includes('kickstart'));
  assert.ok(check >= 0 && check < productionInstall && productionInstall < restart);
  const receipt = JSON.parse(readFileSync(join(f.repo, '.git/morph-deployments.jsonl'), 'utf8'));
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.previous, f.previous);
  assert.equal(git(f.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
});

test('an unhealthy candidate restores the previous relay and keeps an audit receipt', () => {
  const f = deployFixture(),
    result = f.deploy(['--apply'], { TEST_FAIL_HEALTH: f.target });
  assert.notEqual(result.status, 0);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.previous);
  assert.equal(
    JSON.parse(readFileSync(join(f.repo, '.git/morph-deployments.jsonl'), 'utf8')).status,
    'rolledBack',
  );
  assert.match(result.stderr, /Previous relay restored and healthy/);
});

test('an existing release tag cannot be overwritten', () => {
  const f = deployFixture();
  git(f.repo, 'tag', 'api-test', f.previous);
  assert.notEqual(f.deploy(['--apply']).status, 0);
  assert.equal(git(f.repo, 'rev-parse', 'api-test'), f.previous);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.previous);
  assert.equal(existsSync(f.trace), false);
});

test('a different loaded service directory prevents any deployment', () => {
  const f = deployFixture(),
    result = f.deploy(['--apply'], { TEST_SERVICE_DIRECTORY: f.root });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not use this repository/);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.previous);
  assert.doesNotMatch(readFileSync(f.trace, 'utf8'), /kickstart|npm:/);
});

test('ignored production environment files cannot be overwritten by a release', () => {
  const f = deployFixture();
  writeFileSync(join(f.repo, '.gitignore'), '.env\n');
  git(f.repo, 'add', '.gitignore');
  git(f.repo, 'commit', '-m', 'ignore production credentials');
  const previous = git(f.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(f.repo, '.env'), 'fixture-candidate-value\n');
  git(f.repo, 'add', '--force', '.env');
  git(f.repo, 'commit', '-m', 'bad candidate tracks env');
  const candidate = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'checkout', '--detach', previous);
  writeFileSync(join(f.repo, '.env'), 'fixture-production-value\n');
  const result = f.deploy(['--ref', candidate, '--apply']);
  assert.notEqual(result.status, 0);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), previous);
  assert.equal(readFileSync(join(f.repo, '.env'), 'utf8'), 'fixture-production-value\n');
  assert.doesNotMatch(readFileSync(f.trace, 'utf8'), /kickstart/);
});

test('another deployment lock is neither taken nor removed', () => {
  const f = deployFixture(),
    lock = join(f.repo, '.git/morph-deploy.lock');
  mkdirSync(lock);
  assert.notEqual(f.deploy(['--apply']).status, 0);
  assert.ok(existsSync(lock));
  assert.doesNotMatch(readFileSync(f.trace, 'utf8'), /kickstart|npm:/);
});

test('mobile release variables are required without ever printing their values', () => {
  const env = { ...process.env };
  const names = ['API_URL', 'TOOLS_URL', 'PACKS_URL', 'CLIENT_TOKEN'].map(
    (s) => 'EXPO_PUBLIC_MORPH_' + s,
  );
  for (const name of names) delete env[name];
  const invoke = () => cmd('node', [join(source, 'scripts/check-mobile-env.mjs')], source, env);
  let result = invoke();
  assert.notEqual(result.status, 0);
  for (const name of names) assert.match(result.stderr, new RegExp(name));
  for (const name of names)
    env[name] = name.endsWith('TOKEN')
      ? 'test-token-never-print'
      : 'https://example.invalid/private-build-setting';
  result = invoke();
  assert.equal(result.status, 0);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /test-token-never-print|private-build-setting/,
  );
  env[names[0]] = 'invalid-url-that-must-not-appear';
  result = invoke();
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /invalid-url-that-must-not-appear/);
});
