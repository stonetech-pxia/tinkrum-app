#!/usr/bin/env node
// Android release package smoke test (health check 4.4, task 10): Install, launch, verify process
// stays alive for a while, check logcat for crashes, take a screenshot. Unit tests and simulator
// development builds cannot catch release-only crashes (R8 dead code stripping, missing environment
// variables in builds, native modules); this script only answers "does this package open and stay
// open without crashing?". Excluded from npm run check; run manually before releasing, see
// docs/RELEASE_CHECKLIST.md.
//
// Usage: node scripts/smoke-release-android.mjs --apk <file.apk> --serial <adb serial> [--wait 20]
// [--out <dir>] --serial is required: do not guess devices. The founder's phone is only used when
// he explicitly requests it (AGENTS.md). adb uses $ADB, falling back to
// $ANDROID_HOME/platform-tools/adb, and then adb in PATH.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PACKAGE = 'dev.stonetech.tinkrum';

function parseArgs(argv) {
  const args = { wait: 20, out: null, apk: null, serial: null, package: PACKAGE };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[++i];
    if (!(key in args) || value === undefined)
      throw new Error(`Unknown or empty option: ${argv[i - 1]}`);
    args[key] = key === 'wait' ? Number(value) : value;
  }
  if (!args.apk || !args.serial) throw new Error('Both --apk and --serial are required.');
  if (!existsSync(args.apk)) throw new Error(`APK not found: ${args.apk}`);
  if (!Number.isFinite(args.wait) || args.wait < 1)
    throw new Error('--wait must be a number of seconds');
  return args;
}

const adbPath = () =>
  process.env.ADB ||
  (process.env.ANDROID_HOME && existsSync(join(process.env.ANDROID_HOME, 'platform-tools', 'adb'))
    ? join(process.env.ANDROID_HOME, 'platform-tools', 'adb')
    : 'adb');

function adb(serial, args, { binary = false } = {}) {
  const r = spawnSync(adbPath(), ['-s', serial, ...args], {
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: binary ? '' : r.stderr };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Crashes and app-not-responding errors for this package in logcat. */
export function crashesIn(logcat, pkg) {
  const lines = logcat.split('\n');
  const found = [];
  lines.forEach((line, i) => {
    if (
      /FATAL EXCEPTION/.test(line) &&
      lines.slice(i, i + 3).some((l) => l.includes(`Process: ${pkg}`))
    )
      found.push(lines.slice(i, i + 8).join('\n'));
    if (new RegExp(`ANR in ${pkg.replace(/\./g, '\\.')}`).test(line)) found.push(line);
  });
  return found;
}

export async function smoke(argv, log = console.log) {
  const opts = parseArgs(argv);
  const { serial, package: pkg } = opts;
  const out = resolve(opts.out ?? `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);

  // adb may not be connected immediately upon startup: retry a few times.
  let state = adb(serial, ['get-state']);
  for (let i = 0; i < 5 && state.stdout.trim() !== 'device'; i++) {
    await sleep(2000);
    state = adb(serial, ['get-state']);
  }
  if (state.stdout.trim() !== 'device')
    throw new Error(`Device ${serial} is not ready: ${state.stdout}${state.stderr}`);

  log(`Installing ${opts.apk} on ${serial} …`);
  const install = adb(serial, ['install', '-r', opts.apk]);
  // Start only when adb reports Success (AGENTS.md).
  if (!/\bSuccess\b/.test(install.stdout)) {
    return { ok: false, reason: `install failed: ${(install.stdout + install.stderr).trim()}` };
  }

  adb(serial, ['logcat', '-c']);
  adb(serial, ['shell', 'am', 'force-stop', pkg]);
  // Query the system for the starting Activity (do not hardcode class names); use am start -W to wait for startup, considering it started only when Status: ok is reported.
  const activity = adb(serial, [
    'shell',
    'cmd',
    'package',
    'resolve-activity',
    '--brief',
    '-c',
    'android.intent.category.LAUNCHER',
    pkg,
  ])
    .stdout.trim()
    .split('\n')
    .pop()
    ?.trim();
  if (!activity?.startsWith(`${pkg}/`)) {
    return { ok: false, reason: `no launcher activity for ${pkg}: ${activity ?? ''}` };
  }
  const launch = adb(serial, ['shell', 'am', 'start', '-W', '-n', activity]);
  if (!/Status: ok/.test(launch.stdout)) {
    return { ok: false, reason: `launch failed: ${(launch.stdout + launch.stderr).trim()}` };
  }

  // Monitor for wait seconds: process remains alive.
  let alive = true;
  for (let t = 0; t < opts.wait; t += 2) {
    await sleep(2000);
    if (!adb(serial, ['shell', 'pidof', pkg]).stdout.trim()) {
      alive = false;
      break;
    }
  }
  const crashes = crashesIn(adb(serial, ['logcat', '-d']).stdout, pkg);

  mkdirSync(out, { recursive: true });
  const shot = adb(serial, ['exec-out', 'screencap', '-p'], { binary: true }).stdout;
  writeFileSync(join(out, 'screen.png'), shot);

  if (!alive || crashes.length) {
    const reason = [!alive ? `${pkg} is no longer running` : '', ...crashes]
      .filter(Boolean)
      .join('\n\n');
    writeFileSync(join(out, 'crash.txt'), reason);
    return { ok: false, reason, out };
  }
  return { ok: true, out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  smoke(process.argv.slice(2))
    .then((r) => {
      if (r.ok) console.log(`PASS: started and stayed up; screenshot in ${r.out}`);
      else console.error(`FAIL: ${r.reason}${r.out ? `\n(details in ${r.out})` : ''}`);
      process.exitCode = r.ok ? 0 : 1;
    })
    .catch((e) => {
      console.error(String(e.message ?? e));
      process.exitCode = 2;
    });
}
