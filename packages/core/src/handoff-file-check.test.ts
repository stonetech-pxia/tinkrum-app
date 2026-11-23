import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';

import { checkHandoffFileText } from './handoff-file-check';
import { appLinkPayload, readAppLink } from './app-link';
import { BUILTIN_TOOLS } from './tools';
import { createRegistry } from './registry';
import { createStarterWorkspace } from './starter';
import { appConfigFile } from './config-file';

const registry = createRegistry(BUILTIN_TOOLS);
const ctx = { registry, locale: 'en' as const, now: new Date(2026, 10, 23) };
const app = readFileSync(
  new URL('./fixtures/portal-apps/tinkrum-app-wallet.json', import.meta.url),
  'utf8',
);
const setup = appConfigFile(createStarterWorkspace('en', registry), ctx.now);

it('checks both an app and the whole setup with the same import validators', () => {
  expect(checkHandoffFileText(app, ctx).ok).toBe(true);
  expect(checkHandoffFileText(setup, ctx).ok).toBe(true);
  const broken = JSON.parse(setup);
  broken.config.nav.bar = [];
  expect(checkHandoffFileText(JSON.stringify(broken), ctx).ok).toBe(false);
  expect(checkHandoffFileText('invalid', ctx).ok).toBe(false);
  expect(checkHandoffFileText('中'.repeat(700_000), ctx).ok).toBe(false);
});

it('the standalone checker prints a usable link only on success for both formats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinkrum-check-'));
  try {
    const script = join(dir, 'tinkrum-check.cjs');
    buildSync({
      entryPoints: [new URL('../../../scripts/agent-kit/check-cli.ts', import.meta.url).pathname],
      outfile: script,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
    for (const text of [app, setup, 'invalid']) {
      const file = join(dir, 'app.json');
      writeFileSync(file, text);
      const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
      if (text === 'invalid') {
        expect(result.status).toBe(1);
        expect(result.stdout).not.toContain('Open in Tinkrum:');
      } else {
        expect(result.status, result.stdout + result.stderr).toBe(0);
        const link = /^Open in Tinkrum: (.+)$/m.exec(result.stdout)?.[1];
        expect(link).toBeTruthy();
        expect(JSON.parse(readAppLink(appLinkPayload(link!)!))).toEqual(JSON.parse(text));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
