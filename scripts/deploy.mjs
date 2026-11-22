import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 没有 --apply 时只看计划；检查在临时 worktree 里做，不读取生产 .env 或请求记录。
const usage =
  'Usage: scripts/deploy.sh --ref <commit-or-tag> --tag <api-release-tag> [--repo <path>] [--apply]';
const options = { repo: join(homedir(), 'projects/morph-prod'), apply: false };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help') {
    console.log(usage);
    process.exit(0);
  } else if (arg === '--apply') options.apply = true;
  else if (
    ['--ref', '--tag', '--repo'].includes(arg) &&
    process.argv[i + 1] &&
    !process.argv[i + 1].startsWith('--')
  ) {
    options[arg.slice(2)] = process.argv[++i];
  } else {
    console.error(usage);
    process.exit(1);
  }
}

function command(name, args, cwd, capture = false) {
  const result = spawnSync(name, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? '1' },
  });
  // launchctl print 的输出可能有环境变量：失败时也不能把整个输出塞进错误。
  if (result.error || result.status !== 0)
    throw new Error(`${name} failed (exit ${result.status ?? 'unavailable'}).`);
  return result.stdout?.trim() ?? '';
}
function health() {
  const response = spawnSync(
    'curl',
    ['--fail', '--silent', '--show-error', '--max-time', '3', 'http://127.0.0.1:8788/health'],
    { encoding: 'utf8' },
  );
  if (response.status !== 0) return false;
  try {
    return JSON.parse(response.stdout).ok === true;
  } catch {
    return false;
  }
}
async function waitHealthy() {
  for (let i = 0; i < 10; i++) {
    if (health()) return;
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error('Relay health check failed.');
}

let lock;
let staging;
let stagingAdded = false;
let previous;
let mutated = false;
let repo;
let service;
let receipt;
try {
  if (!options.ref || !options.tag || !/^api-[A-Za-z0-9._-]+$/.test(options.tag))
    throw new Error(usage);
  repo = realpathSync(resolve(options.repo));
  const git = (args) => command('git', args, repo, true);
  if (git(['rev-parse', '--show-toplevel']) !== repo)
    throw new Error('Use the repository root as --repo.');
  if (git(['status', '--porcelain'])) throw new Error('Deployment checkout is not clean.');
  previous = git(['rev-parse', 'HEAD']);
  const target = git(['rev-parse', '--verify', `${options.ref}^{commit}`]);
  const tagExists = () =>
    spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/tags/${options.tag}`], { cwd: repo })
      .status === 0;
  if (tagExists()) throw new Error('Release tag already exists; tags are never overwritten.');
  service = `gui/${process.getuid()}/dev.stonetech.morph-api`;
  const job = command('launchctl', ['print', service], repo, true);
  const directory = /^\s*working directory = (.+)$/m.exec(job)?.[1];
  if (!directory || realpathSync(directory) !== realpathSync(join(repo, 'apps/api'))) {
    throw new Error('The loaded relay service does not use this repository.');
  }
  console.log(
    `Repository: ${repo}\nCurrent: ${previous}\nTarget: ${target}\nRelease tag: ${options.tag}`,
  );
  console.log(
    'Plan: isolated checkout → npm ci → npm run check → tag → production checkout/npm ci → relay restart → health check.',
  );
  if (!options.apply) {
    console.log(
      'Plan only. No files, tags or services changed. Add --apply only for an authorised deployment.',
    );
  } else {
    if (!health()) throw new Error('Current relay is not healthy; resolve that before deploying.');
    const gitDir = git(['rev-parse', '--absolute-git-dir']);
    const lockPath = join(gitDir, 'morph-deploy.lock');
    mkdirSync(lockPath);
    lock = lockPath; // 已有锁时退出，不替另一个部署删锁。
    receipt = join(gitDir, 'morph-deployments.jsonl');
    staging = mkdtempSync(join(tmpdir(), 'morph-deploy-'));
    command('git', ['worktree', 'add', '--detach', staging, target], repo);
    stagingAdded = true;
    command('npm', ['ci'], staging);
    command('npm', ['run', 'check'], staging);
    if (git(['rev-parse', 'HEAD']) !== previous || git(['status', '--porcelain'])) {
      throw new Error('Production checkout changed during validation.');
    }
    if (tagExists()) throw new Error('Release tag appeared during validation.');
    command(
      'git',
      [
        'tag',
        '-a',
        options.tag,
        target,
        '-m',
        `Validated relay deployment candidate; previous=${previous}. Health status is in morph-deployments.jsonl.`,
      ],
      repo,
    );
    command('git', ['checkout', '--no-overwrite-ignore', '--detach', target], repo);
    mutated = true;
    command('npm', ['ci'], repo);
    command('launchctl', ['kickstart', '-k', service], repo);
    await waitHealthy();
    appendFileSync(
      receipt,
      JSON.stringify({
        at: new Date().toISOString(),
        status: 'succeeded',
        tag: options.tag,
        commit: target,
        previous,
      }) + '\n',
    );
    mutated = false;
    console.log(`Relay deployed and healthy: ${options.tag}`);
  }
} catch (error) {
  console.error(error.message);
  if (mutated) {
    console.error('Restoring the previous relay checkout and dependencies.');
    try {
      command('git', ['checkout', '--no-overwrite-ignore', '--detach', previous], repo);
      command('npm', ['ci'], repo);
      command('launchctl', ['kickstart', '-k', service], repo);
      await waitHealthy();
      appendFileSync(
        receipt,
        JSON.stringify({
          at: new Date().toISOString(),
          status: 'rolledBack',
          tag: options.tag,
          previous,
        }) + '\n',
      );
      console.error(
        'Previous relay restored and healthy. Failed candidate tag retained for audit.',
      );
    } catch (rollbackError) {
      console.error(`Automatic rollback failed: ${rollbackError.message}`);
    }
  }
  process.exitCode = 1;
} finally {
  if (stagingAdded) {
    try {
      command('git', ['worktree', 'remove', '--force', staging], repo);
    } catch {
      console.error(`Remove temporary validation worktree manually: ${staging}`);
    }
  } else if (staging) rmSync(staging, { recursive: true, force: true });
  if (lock) rmSync(lock, { recursive: true, force: true });
}
