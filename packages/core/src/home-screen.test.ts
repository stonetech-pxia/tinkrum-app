import { describe, expect, it } from 'vitest';

import { splitOps } from './ai/kinds';
import { prepareOps, prepareSnapshot } from './change';
import { addedToHomeScreen, homeScreenFull, homeScreenItems, homeScreenOp } from './home-screen';
import type { Op } from './ops';
import { MAX_HOME_SCREEN, quickActionsOf, type WorkspaceConfig } from './schema';
import { apply, registry, workspace } from './test-helpers';
import { presetById, presetWorkflow } from './workflows/presets';

const ctx = { registry, locale: 'zh' as const, now: new Date(2026, 9, 28, 9) };

/** Pre-installed with the PDF tool, plus two custom quick actions for visa photos and scanned documents. */
function setup(): WorkspaceConfig {
  return apply(workspace('zh', { withPdf: true }), [
    { op: 'addTool', tool: presetWorkflow(presetById('visa-photo')!, 'zh', 'visa') },
    { op: 'addTool', tool: presetWorkflow(presetById('scan-document')!, 'zh', 'scan') },
  ]);
}

/** Switch in the long-press menu: adds or removes an item in a single operation (v34 operations specify the full list, while homeScreenOp calculates based on the current list). */
type Toggle = (config: WorkspaceConfig) => Op;
const on =
  (id: string): Toggle =>
  (config) =>
    homeScreenOp(config, id, true);
const off =
  (id: string): Toggle =>
  (config) =>
    homeScreenOp(config, id, false);
/** Toggles several switches on and off sequentially, coalescing them into a batch of operations (each calculated against the configuration resulting from the previous step). */
function toggles(before: WorkspaceConfig, list: (Toggle | Op)[]): Op[] {
  let config = before;
  return list.map((t) => {
    const op = typeof t === 'function' ? t(config) : t;
    config = apply(config, [op]);
    return op;
  });
}

function prepared(before: WorkspaceConfig, list: (Toggle | Op)[]): WorkspaceConfig {
  const result = prepareOps(before, toggles(before, list), ctx);
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result.after;
}

describe('home screen mark (D-271)', () => {
  it('puts a quick action on the home screen menu and takes it off again', () => {
    const before = setup();
    expect(homeScreenItems(before)).toEqual([]);
    const after = prepared(before, [on('visa')]);
    expect(after.nav.phoneHomeScreen).toEqual(['visa']);
    expect(homeScreenItems(after)).toEqual([
      {
        id: 'visa',
        kind: 'quickAction',
        title: quickActionsOf(after).find((w) => w.id === 'visa')!.name,
        icon: presetById('visa-photo')!.icon,
      },
    ]);
    expect(addedToHomeScreen(before, after)).toEqual(['visa']);
    const removed = prepared(after, [off('visa')]);
    // Removing the last item leaves no empty list; the configuration reverts to its state before any items were added.
    expect(removed).toEqual(before);
    expect(homeScreenItems(removed)).toEqual([]);
  });

  it('works for a quick action that comes with a tool; without its own icon it uses its kind', () => {
    const after = prepared(setup(), [on('pdf-merge')]);
    expect(homeScreenItems(after)).toEqual([
      { id: 'pdf-merge', kind: 'quickAction', title: '合并 PDF', icon: 'document' },
    ]);
  });

  it('describes the change in the interface language', () => {
    const result = prepareOps(setup(), toggles(setup(), [on('visa')]), ctx);
    expect(result.ok && result.lines.join('\n')).toContain('手机桌面');
    const en = prepareOps(workspace('en', { withPdf: true }), [on('pdf-merge')(workspace('en'))], {
      ...ctx,
      locale: 'en',
    });
    expect(en.ok && en.lines[0]).toMatch(/home screen/);
    const frBefore = apply(workspace('fr', { withPdf: true }), [on('pdf-merge')(workspace('fr'))]);
    const fr = prepareOps(frBefore, [off('pdf-merge')(frBefore)], {
      ...ctx,
      locale: 'fr',
    });
    expect(fr.ok && fr.lines[0]).toMatch(/écran d’accueil/);
  });

  it('is a function change: applied right away and undoable, not drafted', () => {
    const op = on('visa')(setup());
    expect(splitOps([op])).toEqual({ function: [op], look: [] });
  });

  it('refuses a quick action that does not exist', () => {
    const result = prepareOps(setup(), [on('nope')(setup())], ctx);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]).toMatch(/tool nope not found/);
  });

  it('only nav.phoneHomeScreen puts something there: addTool cannot carry a mark', () => {
    const result = prepareOps(
      setup(),
      [
        {
          op: 'addTool',
          tool: {
            ...presetWorkflow(presetById('visa-photo')!, 'zh', 'visa-2'),
            homeScreen: true,
          },
        },
      ],
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.stage).toBe('parse');
  });

  it(`allows at most ${MAX_HOME_SCREEN} quick actions on the home screen`, () => {
    const four = prepared(setup(), [on('visa'), on('scan'), on('pdf-merge'), on('pdf-split')]);
    expect(homeScreenFull(four)).toBe(true);
    expect(homeScreenItems(four)).toHaveLength(4);
    const fifth = quickActionsOf(four).find((w) => !four.nav.phoneHomeScreen!.includes(w.id))!;
    const result = prepareOps(four, toggles(four, [on(fifth.id)]), ctx);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join()).toMatch(/at most 4 quick actions/);
    // Removing an item first and then adding a new one is permitted within a single modification.
    expect(prepareOps(four, toggles(four, [off('scan'), on(fifth.id)]), ctx).ok).toBe(true);
  });

  it('deleting a quick action takes it off the home screen menu', () => {
    const after = prepared(setup(), [on('visa'), on('scan')]);
    const deleted = prepared(after, [{ op: 'removeTool', tool: 'visa' }]);
    expect(deleted.nav.phoneHomeScreen).toEqual(['scan']);
    expect(homeScreenItems(deleted).map((i) => i.id)).toEqual(['scan']);
  });

  it('removing the tool takes its quick actions off the home screen menu', () => {
    const after = prepared(setup(), [on('pdf-merge'), on('visa')]);
    const removed = prepared(after, [{ op: 'setPackage', package: 'pdf', do: 'remove' }]);
    expect(homeScreenItems(removed).map((i) => i.id)).toEqual(['visa']);
  });

  it('renaming a quick action renames its home screen item', () => {
    const after = prepared(setup(), [on('visa')]);
    const renamed = prepared(after, [
      { op: 'updateTool', tool: 'visa', changes: { name: '美签照片', icon: 'star' } },
    ]);
    expect(homeScreenItems(renamed)).toEqual([
      { id: 'visa', kind: 'quickAction', title: '美签照片', icon: 'star' },
    ]);
    // Saving the edit page (replacing steps globally) does not remove it from the desktop.
    const saved = prepared(renamed, [
      {
        op: 'updateTool',
        tool: 'visa',
        changes: {
          name: '签证',
          steps: quickActionsOf(renamed).find((w) => w.id === 'visa')!.steps,
        },
      },
    ]);
    expect(homeScreenItems(saved).map((i) => i.title)).toEqual(['签证']);
  });

  it('the menu follows the order of nav.phoneHomeScreen; addedToHomeScreen lists only new ones', () => {
    const after = prepared(setup(), [on('scan'), on('visa')]);
    expect(homeScreenItems(after).map((i) => i.id)).toEqual(['scan', 'visa']);
    const more = prepared(after, [on('pdf-merge')]);
    expect(addedToHomeScreen(after, more)).toEqual(['pdf-merge']);
  });

  it('undo goes back to the version before: the item is gone again', () => {
    // Undo = restore snapshot of the previous version; menus are derived entirely from the configuration.
    const before = setup();
    const after = prepared(before, [on('visa')]);
    const restored = prepareSnapshot(JSON.parse(JSON.stringify(before)), registry);
    expect(homeScreenItems(after)).toHaveLength(1);
    expect(restored.ok && homeScreenItems(restored.after)).toEqual([]);
  });
});

// Every new app starts out in the menu of the Tinkrum icon (D-new-apphome-4).
describe('a new app and the home screen menu', () => {
  const fit: Op = { op: 'addContainer', app: { id: 'fit', name: '健身', bar: ['ai'] } };

  it('goes into the menu, and the change says it can be dragged out on Android', () => {
    const result = prepareOps(setup(), [fit], ctx);
    if (!result.ok) throw new Error(result.issues.join('; '));
    expect(result.after.nav.phoneHomeScreen).toEqual(['app:fit']);
    expect(result.lines.join('\n')).toContain('「健身」');
    expect(result.lines.join('\n')).toContain('当普通 App 用');
  });

  it('stays out of a full menu', () => {
    const full = prepared(setup(), [on('visa'), on('scan'), on('pdf-merge'), on('pdf-split')]);
    const result = prepareOps(full, [fit], ctx);
    if (!result.ok) throw new Error(result.issues.join('; '));
    expect(result.after.nav.phoneHomeScreen).toEqual(full.nav.phoneHomeScreen);
    expect(result.lines.join('\n')).not.toContain('当普通 App 用');
  });

  it('is listed and told once when the same change already puts it there', () => {
    const before = setup();
    const result = prepareOps(
      before,
      [fit, { op: 'updateContainer', nav: { phoneHomeScreen: ['app:fit'] } }],
      ctx,
    );
    if (!result.ok) throw new Error(result.issues.join('; '));
    expect(result.after.nav.phoneHomeScreen).toEqual(['app:fit']);
    expect(result.lines.filter((line) => line.includes('当普通 App 用'))).toHaveLength(1);
  });

  it('is left out when an installed app is reinstalled after the user took it off', () => {
    const added = prepared(setup(), [fit]);
    const removed = prepared(added, [off('app:fit')]);
    const again = prepareOps(removed, [{ op: 'removeContainer', app: 'fit' }, fit], ctx);
    if (!again.ok) throw new Error(again.issues.join('; '));
    expect(again.after.nav.phoneHomeScreen).toBeUndefined();
  });
});
