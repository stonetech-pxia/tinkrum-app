import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { selectChecks } from './check.mjs';

const workspace = (name, dependencies = []) => ({
  name: `@morph/${name}`,
  path: `${['api', 'mobile'].includes(name) ? 'apps' : 'packages'}/${name}`,
  dependencies: dependencies.map((n) => `@morph/${n}`),
  scripts: { typecheck: 'tsc', test: 'test' },
});
const workspaces = [
  workspace('api', ['core', 'planner']),
  workspace('mobile', ['core', 'planner', 'tool-office', 'tool-image', 'tool-pdf', 'tool-archive']),
  workspace('core'),
  workspace('planner', ['core']),
  workspace('tool-image', ['core']),
  workspace('tool-office', ['tool-image']),
  workspace('tool-pdf'),
  workspace('tool-archive'),
];
const ids = (...paths) => selectChecks(paths, workspaces).map((s) => s.id);

test('prose only checks formatting, but executable docs and unknown inputs require full checks', () => {
  assert.deepEqual(
    ids('docs/DEPLOY.md', 'README.md').map((id) => id.split(':')[0]),
    ['format'],
  );
  for (const path of [
    'docs/agent/tinkrum-app-guide.md',
    'docs/MOCK_AI_PHRASES.md',
    'docs/example.json',
    'tools/job-apply/manifest.json',
    'new-area/file.ts',
  ])
    assert.deepEqual(ids(path), ['full'], path);
});

test('package checks include transitive consumers without testing unrelated packages', () => {
  const selected = ids('packages/tool-image/src/math.ts');
  for (const name of ['tool-image', 'tool-office', 'mobile'])
    for (const check of ['typecheck', 'test'])
      assert.ok(selected.includes(`@morph/${name}:${check}`));
  for (const name of ['api', 'planner', 'tool-pdf'])
    assert.ok(!selected.includes(`@morph/${name}:test`));
  assert.ok(selected.includes('core:invariants'));
  assert.ok(selected.includes('check:locales'));
});

test('mobile and API changes still run the core guards that inspect their source', () => {
  for (const name of ['mobile', 'api']) {
    const selected = ids(`apps/${name}/src/example.ts`);
    assert.ok(selected.includes(`@morph/${name}:test`));
    assert.ok(selected.includes('core:invariants'));
    assert.ok(!selected.includes('@morph/tool-office:test'));
  }
});

test('core, dependencies and shared test configuration fall back to full checks', () => {
  for (const path of [
    'packages/core/src/math.ts',
    'package-lock.json',
    'package.json',
    'eslint.config.js',
    '.prettierignore',
    'packages/tool-office/vitest.config.ts',
    'apps/mobile/jest.setup.js',
    'apps/mobile/package.json',
    'scripts/check.mjs',
    '.githooks/pre-push',
  ])
    assert.deepEqual(ids(path), ['full'], path);
});

test('native algorithm changes include their compilations and license verification', () => {
  assert.ok(ids('apps/mobile/modules/morph-media/dsp/MorphDsp.c').includes('test:native-dsp'));
  assert.ok(
    ids('apps/mobile/modules/morph-media/dsp/dependencies.json').includes('check:licenses'),
  );
  assert.ok(
    ids('apps/mobile/modules/morph-archive/ios/ZipCodec.swift').includes('test:native-archive'),
  );
});

test('fixtures, renames across packages and mixed prose/code changes retain all owners', () => {
  const selected = ids(
    'packages/tool-office/src/fixtures/office/a.docx',
    'packages/tool-pdf/src/old-name.ts',
    'apps/api/src/new-name.ts',
    'docs/DEPLOY.md',
  );
  for (const name of ['tool-office', 'tool-pdf', 'api', 'mobile'])
    assert.ok(selected.includes(`@morph/${name}:test`));
  assert.deepEqual(ids(), []);
});
