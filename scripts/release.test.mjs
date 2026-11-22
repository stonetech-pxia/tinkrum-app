import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
    JSON.stringify({
      scripts: {
        check: 'node scripts/check.mjs --full',
        'check:full': 'node --test behavior.test.cjs',
      },
    }),
  );
  writeFileSync(join(repo, 'behavior.test.cjs'), "require('node:assert/strict').equal(1, 1);\n");
  mkdirSync(join(repo, '.githooks'));
  copyFileSync(join(source, '.githooks/pre-push'), join(repo, '.githooks/pre-push'));
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(join(source, 'scripts/install-hooks.sh'), join(repo, 'scripts/install-hooks.sh'));
  copyFileSync(join(source, 'scripts/check.mjs'), join(repo, 'scripts/check.mjs'));
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

test('a second dry-run push reuses successful checks for the same clean commit', () => {
  const f = fixture(),
    remote = join(f.root, 'remote.git');
  git(f.root, 'init', '--bare', remote);
  git(f.repo, 'remote', 'add', 'fixture', remote);
  assert.equal(cmd('sh', [join(source, 'scripts/install-hooks.sh')], f.repo).status, 0);
  const push = () => cmd('git', ['push', '--dry-run', 'fixture', 'HEAD:main'], f.repo);
  assert.equal(push().status, 0);
  const result = push();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reusing successful checks/);
  assert.doesNotMatch(result.stdout, /running npm run check/);
});

test('full validation always reruns and its clean result can be reused by pre-push', () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const result = cmd('npm', ['run', 'check'], f.repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /running npm run check:full/);
    assert.doesNotMatch(result.stdout, /reusing/);
  }
  const result = hook(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reusing successful checks/);
});

function hook(f, remote = '0'.repeat(40), env = process.env, remoteRef = 'refs/heads/topic') {
  return spawnSync('sh', [join(f.repo, '.githooks/pre-push')], {
    cwd: f.repo,
    encoding: 'utf8',
    env,
    input: `refs/heads/topic ${git(f.repo, 'rev-parse', 'HEAD')} ${remoteRef} ${remote}\n`,
  });
}

test('environment and dependency install changes invalidate successful push checks', () => {
  const f = fixture();
  writeFileSync(join(f.repo, '.gitignore'), 'node_modules\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'ignore dependencies');
  assert.equal(hook(f).status, 0);
  let result = hook(f, undefined, { ...process.env, TZ: 'Pacific/Honolulu' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /running npm run check:full/);
  mkdirSync(join(f.repo, 'node_modules'));
  writeFileSync(join(f.repo, 'node_modules/.package-lock.json'), '{}');
  result = hook(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /running npm run check:full/);
});

test('caller tool-call metadata does not invalidate checks in an otherwise identical environment', () => {
  const f = fixture();
  assert.equal(hook(f, undefined, { ...process.env, CODEX_TOOL_CALL_ID: 'first-call' }).status, 0);
  const result = hook(f, undefined, { ...process.env, CODEX_TOOL_CALL_ID: 'second-call' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reusing successful checks/);
});

test('failed, dirty and damaged-cache runs never supply a successful receipt', () => {
  const f = fixture();
  writeFileSync(join(f.repo, 'behavior.test.cjs'), "require('node:assert/strict').equal(1, 2);\n");
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'failing');
  for (let i = 0; i < 2; i++) {
    const result = hook(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /running npm run check:full/);
  }
  writeFileSync(join(f.repo, 'behavior.test.cjs'), "require('node:assert/strict').equal(1, 1);\n");
  assert.equal(cmd('npm', ['run', 'check'], f.repo).status, 0);
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'passing');
  assert.match(hook(f).stdout, /running npm run check:full/);
  const cache = join(f.repo, '.git/morph-checks');
  for (const path of readdirSync(cache)) writeFileSync(join(cache, path), 'broken receipt');
  assert.match(hook(f).stdout, /running npm run check:full/);
});

test('a checkout modified by a check blocks the push and is not cached', () => {
  const f = fixture();
  writeFileSync(
    join(f.repo, 'behavior.test.cjs'),
    "require('node:fs').writeFileSync('unexpected.txt', 'changed');\n",
  );
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'check modifies checkout');
  const result = hook(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changed while checks were running/);
  assert.equal(existsSync(join(f.repo, '.git/morph-checks')), false);
});

test('a failed full recheck revokes an older successful receipt for the same commit', () => {
  const f = fixture(),
    marker = join(f.root, 'fail-marker');
  writeFileSync(
    join(f.repo, 'behavior.test.cjs'),
    "require('node:assert/strict').equal(require('node:fs').existsSync(process.env.FAIL_MARKER), false);\n",
  );
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'transient check failure');
  const env = { ...process.env, FAIL_MARKER: marker };
  assert.equal(cmd('npm', ['run', 'check'], f.repo, env).status, 0);
  assert.match(hook(f, undefined, env).stdout, /reusing successful checks/);
  writeFileSync(marker, 'fail');
  assert.notEqual(cmd('npm', ['run', 'check'], f.repo, env).status, 0);
  const result = hook(f, undefined, env);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /running npm run check:full/);
});

test('deleted and renamed prose files are not passed to the formatter at their old paths', () => {
  const f = fixture(),
    bin = join(f.root, 'bin'),
    trace = join(f.root, 'trace');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'npm'),
    '#!/bin/sh\nif [ "$1" = --version ]; then echo fixture; else echo "$*" >> "$TEST_TRACE"; fi\n',
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, TEST_TRACE: trace };
  mkdirSync(join(f.repo, 'docs'));
  writeFileSync(join(f.repo, 'docs/removed.md'), 'removed\n');
  writeFileSync(join(f.repo, 'docs/renamed.md'), 'renamed\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'docs before');
  const base = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'rm', 'docs/removed.md');
  git(f.repo, 'mv', 'docs/renamed.md', 'docs/new name.md');
  git(f.repo, 'commit', '-m', 'docs after');
  let result = hook(f, base, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(trace, 'utf8'), /prettier.*docs\/new name.md/);
  assert.doesNotMatch(readFileSync(trace, 'utf8'), /removed.md|renamed.md/);
  // 即使文档缓存已通过，推送 main 或标签仍必须升级成全量。
  result = hook(f, base, env, 'refs/heads/main');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /running npm run check:full/);
});

test('deletion-only pushes skip checks even in a dirty checkout', () => {
  const f = fixture();
  writeFileSync(join(f.repo, 'dirty.txt'), 'dirty\n');
  const result = spawnSync('sh', [join(f.repo, '.githooks/pre-push')], {
    cwd: f.repo,
    encoding: 'utf8',
    input: `delete ${'0'.repeat(40)} refs/heads/topic ${f.target}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('push ranges include earlier commits and every ref; new, missing and rewound bases use full checks', () => {
  const f = fixture();
  const bin = join(f.root, 'bin'),
    trace = join(f.root, 'trace');
  mkdirSync(bin);
  // npm 的选择记录用替身；其余 Git/钩子/缓存走真实路径，不安装或联网下载任何依赖。
  writeFileSync(
    join(bin, 'npm'),
    '#!/bin/sh\nif [ "$1" = --version ]; then echo fixture; else echo "$*" >> "$TEST_TRACE"; fi\n',
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, TEST_TRACE: trace };
  mkdirSync(join(f.repo, 'docs'));
  writeFileSync(join(f.repo, 'docs/older.md'), 'old\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'baseline docs');
  const baseline = git(f.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(f.repo, 'unknown-source.txt'), 'earlier code commit\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'earlier code');
  const code = git(f.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(f.repo, 'docs/new.md'), 'new\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'latest docs');
  let result = hook(f, code, env);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(readFileSync(trace, 'utf8'), /check:full/);
  assert.match(readFileSync(trace, 'utf8'), /prettier.*docs\/new.md/);
  // 同一 HEAD，另一个远端基线还包含前一个代码提交；文档检查的缓存不能当全量。
  result = hook(f, baseline, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /running npm run check:full/);
  // 同时推两个 ref，不能只看最后一条文档范围。
  rmSync(join(f.repo, '.git/morph-checks'), { recursive: true });
  result = spawnSync('sh', [join(f.repo, '.githooks/pre-push')], {
    cwd: f.repo,
    env,
    encoding: 'utf8',
    input:
      `refs/heads/topic ${git(f.repo, 'rev-parse', 'HEAD')} refs/heads/one ${baseline}\n` +
      `refs/heads/topic ${git(f.repo, 'rev-parse', 'HEAD')} refs/heads/two ${code}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /running npm run check:full/);
  for (const base of ['0'.repeat(40), '1'.repeat(40)]) {
    rmSync(join(f.repo, '.git/morph-checks'), { recursive: true });
    assert.match(hook(f, base, env).stdout, /running npm run check:full/);
  }
  // 远端不在 HEAD 的祖先链：模拟强推。
  git(f.repo, 'checkout', '--detach', baseline);
  writeFileSync(join(f.repo, 'docs/diverged.md'), 'diverged\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'diverged');
  assert.match(hook(f, code, env).stdout, /running npm run check:full/);
});

test('a real scoped hook invokes workspace suites and the cross-workspace core guard', () => {
  const f = fixture(),
    bin = join(f.root, 'bin'),
    trace = join(f.root, 'trace');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'npm'),
    '#!/bin/sh\nif [ "$1" = --version ]; then echo fixture; else echo "$*" >> "$TEST_TRACE"; fi\n',
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, TEST_TRACE: trace };
  writeFileSync(
    join(f.repo, 'apps/api/package.json'),
    JSON.stringify({
      name: '@morph/api',
      scripts: { typecheck: 'tsc', test: 'vitest' },
    }),
  );
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'workspace manifest');
  const base = git(f.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(f.repo, 'apps/api/main.txt'), 'scoped code change\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'workspace code');
  let result = hook(f, base, env);
  assert.equal(result.status, 0, result.stderr);
  const commands = readFileSync(trace, 'utf8');
  for (const expected of [
    'run lint',
    'run check:locales',
    'run typecheck --workspace @morph/api',
    'run test --workspace @morph/api',
    'exec --workspace @morph/core -- vitest run src/invariants.test.ts',
  ])
    assert.ok(commands.includes(expected), commands);
  assert.doesNotMatch(commands, /check:full/);
  result = hook(f, base, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reusing successful checks/);
  assert.equal(readFileSync(trace, 'utf8'), commands);
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
