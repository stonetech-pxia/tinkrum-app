import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { functionFirst, splitOps } from './ai/kinds';
import { appFileOfApp, appFileOps, appUpdateOps, type AppFile } from './app-file';
import { checkAppFileText } from './app-file-check';
import { scopeProblems } from './app-scope';
import { prepareOps } from './change';
import { describeChange } from './describe';
import type { DrawnIcon } from './drawn-icons';
import { missingUses, usesOf, USES_FEATURES } from './file-uses';
import type { Op } from './ops';
import { presetSnapshot, preparePreset } from './saved-presets';
import {
  IconValueSchema,
  ListedIconValueSchema,
  WorkspaceConfigSchema,
  type WorkspaceConfig,
} from './schema';
import { createStarterWorkspace } from './starter';
import { registry } from './test-helpers';
import { ToolManifestSchema } from './tool-download';
import { validateWorkspace } from './validate';

// Incorporating drawn icons into configuration (D-625): icon library, my:<id> references, setTheme
// patches, separating features and appearance, App files travelling along, presets travelling
// along.

const ctx = { registry, locale: 'en' as const, now: new Date('2026-11-23T10:00:00Z') };
const PAW: DrawnIcon = {
  paths: [
    'M12 13c-3 0-6 3-6 5.5S8 22 12 21s6 1 6-2.5S15 13 12 13z',
    'M5 7a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM19 7a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
  ],
};
const RING: DrawnIcon = { paths: ['M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z'], stroke: true };

const start = () => createStarterWorkspace('en', registry);
const run = (config: WorkspaceConfig, ops: Op[], extra: object = {}) => {
  const result = prepareOps(config, ops, { ...ctx, ...extra });
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.after;
};
const PETS = {
  id: 'pets',
  name: 'Pets',
  fields: [{ id: 'name', name: 'Name', type: 'text' }],
} as const;

describe('the icon library in the config', () => {
  it('a my:<id> that is not in the library is a reference error, and a removal that leaves one is rejected', () => {
    const config = start();
    config.containers.pages[0]!.icon = 'my:paw';
    const bad = validateWorkspace(config, registry);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.issues).toContainEqual({
      code: 'unknown-icon',
      message: 'containers.pages.home.icon: icon my:paw is not in the icon library (icons)',
    });
    config.icons = { paw: PAW };
    expect(validateWorkspace(config, registry).ok).toBe(true);
    const removed = prepareOps(config, [{ op: 'setTheme', icons: { paw: null } }], ctx);
    expect(removed.ok).toBe(false);
    expect(!removed.ok && removed.issues.join()).toContain(
      'icon my:paw is not in the icon library',
    );
  });

  it('every place in the config schema that takes an icon value is a key named icon (the walk finds them all)', () => {
    const keys = new Set<string>();
    const seen = new Set<unknown>();
    const visit = (schema: z.ZodType, key: string | null) => {
      if (schema === IconValueSchema) {
        keys.add(key ?? '');
        return;
      }
      if (seen.has(schema)) return;
      seen.add(schema);
      const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
      const child = (s: unknown, k: string | null) => s && visit(s as z.ZodType, k);
      switch (def.type) {
        case 'object':
          for (const [k, v] of Object.entries(def.shape as object)) child(v, k);
          break;
        case 'array':
          child(def.element, key);
          break;
        case 'union':
          for (const o of def.options as unknown[]) child(o, key);
          break;
        case 'record':
          child(def.valueType, key);
          break;
        case 'lazy':
          child((def.getter as () => unknown)(), key);
          break;
        case 'pipe':
          child(def.in, key);
          child(def.out, key);
          break;
        case 'intersection':
          child(def.left, key);
          child(def.right, key);
          break;
        default:
          child(def.innerType, key);
      }
    };
    visit(WorkspaceConfigSchema, null);
    expect([...keys]).toEqual(['icon']);
    // my: is not accepted outside the icon library (e.g., in downloaded tools).
    expect(IconValueSchema.safeParse('my:paw').success).toBe(true);
    expect(ListedIconValueSchema.safeParse('my:paw').success).toBe(false);
    const workflow = ToolManifestSchema.shape.workflows.element.shape.icon;
    expect(workflow.safeParse('my:paw').success).toBe(false);
    expect(workflow.safeParse('star').success).toBe(true);
  });
});

describe('setTheme {icons}', () => {
  it('adds, replaces and removes; an empty library is not stored; preset and reset leave it', () => {
    const added = run(start(), [{ op: 'setTheme', icons: { paw: PAW, ring: RING } }]);
    expect(added.icons).toEqual({ paw: PAW, ring: RING });
    const replaced = run(added, [{ op: 'setTheme', icons: { paw: RING } }]);
    expect(replaced.icons?.paw).toEqual(RING);
    const emptied = run(added, [{ op: 'setTheme', icons: { paw: null, ring: null } }]);
    expect(emptied).not.toHaveProperty('icons');
    expect(run(added, [{ op: 'setTheme', preset: 'neon' }]).icons).toEqual(added.icons);
    expect(run(added, [{ op: 'setTheme', reset: true }]).icons).toEqual(added.icons);
  });

  it('is one library: setTheme with app writes the same library, and the app may add icons', () => {
    const withApp = run(start(), [{ op: 'addContainer', app: { id: 'fit', name: 'Fitness' } }]);
    const ops: Op[] = [
      { op: 'setTheme', app: 'fit', icons: { ring: RING } },
      { op: 'updateContainer', app: { id: 'fit', icon: 'my:ring' } },
    ];
    const after = run(withApp, ops, { scope: { appId: 'fit' } });
    expect(after.icons).toEqual({ ring: RING });
    expect(scopeProblems(withApp, after, 'fit', registry)).toEqual([]);
    // Icons used on the home screen cannot be changed within the app.
    const homeUses = run(start(), [
      { op: 'setTheme', icons: { ring: RING } },
      { op: 'addContainer', app: { id: 'fit', name: 'Fitness' } },
      { op: 'updateContainer', page: 'home', changes: { icon: 'my:ring' } },
    ]);
    const changed = run(homeUses, [{ op: 'setTheme', app: 'fit', icons: { ring: PAW } }]);
    expect(scopeProblems(homeUses, changed, 'fit', registry).join()).toContain('out of scope');
  });

  it('rejects bad path data in the op, naming the icon', () => {
    const result = prepareOps(
      start(),
      [{ op: 'setTheme', icons: { paw: { paths: ['M0 0 <script>'] } } }] as unknown as Op[],
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join()).toContain('icon paw: path 1');
  });

  it('describes each icon on its own line, also inside an app', () => {
    const config = run(start(), [{ op: 'addContainer', app: { id: 'fit', name: 'Fitness' } }]);
    expect(
      describeChange([{ op: 'setTheme', icons: { paw: PAW, ring: null } }], config, [], ctx),
    ).toEqual(['Icon “paw”: drawn', 'Icon “ring”: drawing removed']);
    expect(
      describeChange([{ op: 'setTheme', app: 'fit', icons: { paw: PAW } }], config, [], ctx),
    ).toEqual(['Icon “paw”: drawn']);
  });
});

describe('function or look (rule 26)', () => {
  const icons: Op = { op: 'setTheme', icons: { paw: PAW } };
  const table: Op = { op: 'addData', table: { ...PETS, icon: 'my:paw' } } as unknown as Op;

  it('a setTheme that only adds icons is a look change on its own', () => {
    expect(splitOps([icons])).toEqual({ function: [], look: [icons] });
    expect(functionFirst(start(), [icons], ctx)).toEqual({ kind: 'look' });
  });

  it('goes with the function ops when there are any, and the mixed change applies and validates', () => {
    const page: Op = { op: 'updateContainer', page: 'home', changes: { title: 'Pets' } };
    expect(splitOps([icons, table, page])).toEqual({ function: [icons, table], look: [page] });
    const first = functionFirst(start(), [icons, table, page], ctx);
    expect(first).toEqual({ kind: 'function', ops: [icons, table], deferred: [page] });
    const after = run(start(), [icons, table]);
    expect(after.data.tables.find((t) => t.id === 'pets')?.icon).toBe('my:paw');
    expect(validateWorkspace(after, registry).ok).toBe(true);
  });
});

describe('saved presets and file uses', () => {
  it('a saved preset keeps the icon library', () => {
    const config = run(start(), [
      { op: 'setTheme', icons: { paw: PAW } },
      { op: 'updateContainer', page: 'home', changes: { icon: 'my:paw' } },
    ]);
    const snapshot = presetSnapshot(config);
    expect(snapshot.icons).toEqual({ paw: PAW });
    const back = preparePreset(JSON.parse(JSON.stringify(snapshot)), registry);
    expect(back.ok && back.after.icons).toEqual({ paw: PAW });
  });

  it('lists drawnIcons as a feature, never my:<id> as a listed icon name', () => {
    expect(USES_FEATURES).toContain('drawnIcons');
    const uses = usesOf({ icons: { paw: PAW }, pages: [{ id: 'p', icon: 'my:paw' }] });
    expect(uses.features).toContain('drawnIcons');
    expect(uses.icons ?? []).not.toContain('my:paw');
    expect(usesOf({ pages: [{ id: 'p', icon: 'my:paw' }] }).features).toContain('drawnIcons');
    expect(missingUses(JSON.stringify({ uses: { features: ['drawnIcons'] } }), registry)).toEqual(
      [],
    );
  });
});

describe('app files carry their drawn icons', () => {
  function file(icons?: Record<string, DrawnIcon>): AppFile {
    return {
      format: 'tinkrum-app',
      version: 1,
      exportedAt: '2026-11-23T10:00:00.000Z',
      schemaVersion: start().schemaVersion,
      app: {
        id: 'pets',
        name: 'Pets',
        icon: 'my:paw',
        bar: ['page:pets-home', 'ai'],
        theme: start().theme,
      },
      tables: [{ ...PETS, id: 'pets-pets', icon: 'my:paw' }],
      pages: [{ id: 'pets-home', title: 'Pets', icon: 'my:paw', blocks: [] }],
      tools: [],
      ...(icons ? { icons } : {}),
    } as unknown as AppFile;
  }
  const install = (config: WorkspaceConfig, f: AppFile) => {
    const plan = appFileOps(f, config);
    if (!plan.ok) throw new Error(plan.error);
    return { ops: plan.ops, after: run(config, plan.ops, { fromAppFile: true }) };
  };

  it('imports: setTheme {icons} first, then the content using it; exports only the icons the app uses', () => {
    const { ops, after } = install(start(), file({ paw: PAW, ring: RING }));
    expect(ops[0]).toEqual({ op: 'setTheme', icons: { paw: PAW, ring: RING } });
    expect(after.icons).toEqual({ paw: PAW, ring: RING });
    expect(appFileOfApp(after, 'pets')?.icons).toEqual({ paw: PAW });
  });

  it('a file that uses my:<id> without defining it is invalid, with a clear message', () => {
    const plan = appFileOps(file(), start());
    expect(plan).toEqual({
      ok: false,
      error: expect.stringContaining("app.icon: icon my:paw is not defined in the file's icons"),
    });
    const checked = checkAppFileText(JSON.stringify(file()), ctx);
    expect(!checked.ok && checked.problems.join()).toContain("is not defined in the file's icons");
    expect(checkAppFileText(JSON.stringify(file({ paw: PAW })), ctx).ok).toBe(true);
  });

  it('same id: reuses an identical icon, renames a different one in use and rewrites its references', () => {
    const same = run(start(), [
      { op: 'setTheme', icons: { paw: PAW } },
      { op: 'updateContainer', page: 'home', changes: { icon: 'my:paw' } },
    ]);
    const reused = install(same, file({ paw: PAW }));
    expect(reused.ops.some((op) => op.op === 'setTheme')).toBe(false);
    expect(reused.after.icons).toEqual({ paw: PAW });

    const different = run(start(), [
      { op: 'setTheme', icons: { paw: RING } },
      { op: 'updateContainer', page: 'home', changes: { icon: 'my:paw' } },
    ]);
    const renamed = install(different, file({ paw: PAW }));
    expect(renamed.after.icons).toEqual({ paw: RING, 'paw-2': PAW });
    expect(renamed.after.containers.pages.find((p) => p.id === 'pets-home')?.icon).toBe('my:paw-2');
    expect(renamed.after.data.tables.find((t) => t.id === 'pets-pets')?.icon).toBe('my:paw-2');
    expect(renamed.after.nav.apps?.find((a) => a.id === 'pets')?.icon).toBe('my:paw-2');
    expect(renamed.after.containers.pages.find((p) => p.id === 'home')?.icon).toBe('my:paw');
  });

  it('updating the same app replaces an icon only it used, keeping the id', () => {
    const { after } = install(start(), file({ paw: PAW }));
    const plan = appUpdateOps(file({ paw: RING }), after, registry);
    if (!plan.ok) throw new Error(plan.error);
    const updated = run(after, plan.ops, { fromAppFile: true });
    expect(updated.icons).toEqual({ paw: RING });
    expect(updated.data.tables.find((t) => t.id === 'pets-pets')?.icon).toBe('my:paw');
  });
});
