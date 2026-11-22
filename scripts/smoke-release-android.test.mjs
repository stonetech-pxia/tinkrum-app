// release 包冒烟脚本（smoke-release-android.mjs）：用一个假的 adb 跑它的判断。真设备上的那一次见发版清单。
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { crashesIn, smoke } from './smoke-release-android.mjs';

/** 假 adb：按场景回答，记下每次调用。 */
function fakeAdb(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-adb-'));
  const calls = join(dir, 'calls.log');
  const script = join(dir, 'adb');
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require('node:fs');
const s = ${JSON.stringify(scenario)};
const args = process.argv.slice(4);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
const cmd = args.join(' ');
if (cmd === 'get-state') process.stdout.write('device\\n');
else if (args[0] === 'install') process.stdout.write(s.install);
else if (cmd.startsWith('shell cmd package resolve-activity')) process.stdout.write('priority=0 preferredOrder=0\\ndev.stonetech.tinkrum/.MainActivity\\n');
else if (cmd.startsWith('shell am start')) process.stdout.write(s.launch ?? 'Starting: Intent\\nStatus: ok\\nLaunchState: COLD\\n');
else if (cmd.startsWith('shell pidof')) process.stdout.write(s.alive ? '4242\\n' : '');
else if (cmd === 'logcat -d') process.stdout.write(s.logcat ?? '');
else if (cmd.startsWith('exec-out screencap')) process.stdout.write('PNG');
`,
  );
  chmodSync(script, 0o755);
  const apk = join(dir, 'app.apk');
  writeFileSync(apk, 'apk');
  return { script, apk, out: join(dir, 'out'), calls: () => readFileSync(calls, 'utf8') };
}

async function run(scenario) {
  const fake = fakeAdb(scenario);
  process.env.ADB = fake.script;
  const result = await smoke(
    ['--apk', fake.apk, '--serial', 'emulator-5570', '--wait', '2', '--out', fake.out],
    () => {},
  );
  return { ...fake, result };
}

test('passes when the app installs, starts and stays up without a crash', async () => {
  const { result, out } = await run({
    install: 'Performing Streamed Install\nSuccess\n',
    alive: true,
  });
  assert.equal(result.ok, true);
  assert.ok(existsSync(join(out, 'screen.png')));
});

test('does not launch when adb did not print Success', async () => {
  const { result, calls } = await run({
    install: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]\n',
    alive: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /INSTALL_FAILED_UPDATE_INCOMPATIBLE/);
  assert.doesNotMatch(calls(), /am start/);
});

test('fails on a fatal exception of this app, with the stack saved', async () => {
  const logcat = [
    'E AndroidRuntime: FATAL EXCEPTION: main',
    'E AndroidRuntime: Process: dev.stonetech.tinkrum, PID: 4242',
    'E AndroidRuntime: java.lang.NoClassDefFoundError: com.google.mlkit.Foo',
  ].join('\n');
  const { result, out } = await run({ install: 'Success\n', alive: true, logcat });
  assert.equal(result.ok, false);
  assert.match(readFileSync(join(out, 'crash.txt'), 'utf8'), /NoClassDefFoundError/);
});

test('fails when the activity does not start', async () => {
  const { result } = await run({
    install: 'Success\n',
    alive: true,
    launch: 'Error: Activity not started, unable to resolve Intent\n',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /launch failed/);
});

test('fails when the process is gone, even without a stack', async () => {
  const { result } = await run({ install: 'Success\n', alive: false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no longer running/);
});

test('ignores crashes of other apps', () => {
  const logcat =
    'E AndroidRuntime: FATAL EXCEPTION: main\nE AndroidRuntime: Process: com.other.app, PID: 1';
  assert.deepEqual(crashesIn(logcat, 'dev.stonetech.tinkrum'), []);
  assert.equal(
    crashesIn('I ActivityManager: ANR in dev.stonetech.tinkrum (x)', 'dev.stonetech.tinkrum')
      .length,
    1,
  );
});

test('refuses to run without a device serial', async () => {
  const fake = fakeAdb({ install: 'Success\n', alive: true });
  process.env.ADB = fake.script;
  await assert.rejects(smoke(['--apk', fake.apk]), /--serial/);
});
