import { describe, expect, it } from 'vitest';

import { prepareOps } from '../change';
import { quickActionsOf, type Locale, type Workflow } from '../schema';
import { apply, registry, workspace } from '../test-helpers';
import {
  WORKFLOW_PRESETS,
  builtInWorkflows,
  presetById,
  presetWorkflow,
} from '../workflows/presets';
import { expandPresetWorkflows } from './preset-ops';

// Preset shorthand addTool {tool: {preset, params?}} (D-259; v33 used addWorkflow {presetId}).

const LOCALES: Locale[] = ['en', 'zh', 'fr'];
const ctx = (locale: Locale) => ({ registry, locale, now: new Date(2026, 9, 27) });
const expand = (ops: unknown[], locale: Locale = 'en', config = workspace(locale)) =>
  expandPresetWorkflows({ kind: 'ops', ops }, config, locale);
const added = (value: unknown) => (value as { ops: { tool: Workflow }[] }).ops.map((o) => o.tool);
const short = (preset: string, extra: Record<string, unknown> = {}) => ({
  op: 'addTool',
  tool: { preset, ...extra },
});

describe('addTool {tool: {preset}}', () => {
  it('every preset expands to exactly what the user gets when adding it, in every language', () => {
    for (const locale of LOCALES) {
      const config = workspace(locale);
      // When a user modifies a built-in quick action in the quick action library, the version added to the config is this one from builtInWorkflows.
      const userAdds = builtInWorkflows(quickActionsOf(config), locale);
      for (const preset of WORKFLOW_PRESETS) {
        const { value, issues } = expand([short(preset.id)], locale);
        expect(issues).toEqual([]);
        const [workflow] = added(value);
        expect(workflow).toEqual(userAdds.find((w) => w.id === preset.id));
        expect(workflow).toEqual(presetWorkflow(preset, locale, preset.id));
        expect(prepareOps(config, (value as { ops: unknown }).ops, ctx(locale)).ok, preset.id).toBe(
          true,
        );
      }
    }
  });

  it('params override parameters by step id; everything else stays the preset', () => {
    const { value, issues } = expand([short('visa-photo', { params: { photo: { maxKB: 100 } } })]);
    expect(issues).toEqual([]);
    const [workflow] = added(value);
    const preset = presetWorkflow(presetById('visa-photo')!, 'en', 'visa-photo');
    expect(workflow!.steps[1]).toEqual({
      ...preset.steps[1],
      params: { ...preset.steps[1]!.params, maxKB: 100 },
    });
    expect(workflow!.steps.filter((_, i) => i !== 1)).toEqual(
      preset.steps.filter((_, i) => i !== 1),
    );
    expect(prepareOps(workspace('en'), (value as { ops: unknown }).ops, ctx('en')).ok).toBe(true);
  });

  it('a second copy gets a free id (also next to reminders); id and name can be given; the long form still works', () => {
    const { value } = expand([
      short('visa-photo'),
      short('visa-photo', { name: 'Schengen photo' }),
      short('visa-photo', { id: 'kid-photo', kind: 'quickAction' }),
      // Keys can also be written directly on the operation (same as v33's addWorkflow {presetId}).
      { op: 'addTool', preset: 'scan-document', name: 'Scan' },
    ]);
    expect(added(value).map((w) => [w.id, w.name])).toEqual([
      ['visa-photo', 'Visa / ID photo'],
      ['visa-photo-2', 'Schengen photo'],
      ['kid-photo', 'Visa / ID photo'],
      ['scan-document', 'Scan'],
    ]);
    // Quick actions and reminders share a set of IDs: replace if there is already a reminder named visa-photo.
    const withReminder = apply(workspace('en'), [
      {
        op: 'addTool',
        tool: {
          id: 'visa-photo',
          kind: 'reminder',
          title: 'Photo',
          enabled: true,
          when: { every: 'day', at: '09:00' },
          opens: 'page:home',
        },
      },
    ]);
    expect(added(expand([short('visa-photo')], 'en', withReminder).value)[0]!.id).toBe(
      'visa-photo-2',
    );
    const full = { op: 'addTool', tool: presetWorkflow(presetById('visa-photo')!, 'en', 'x') };
    expect(expand([full]).value).toEqual({ kind: 'ops', ops: [full] });
    // Reminders also have a preset key, but it is not shorthand.
    const reminder = {
      op: 'addTool',
      tool: { id: 'r', kind: 'reminder', preset: 'visa-photo', title: 'R' },
    };
    expect(expand([reminder]).value).toEqual({ kind: 'ops', ops: [reminder] });
  });

  it('a wrong preset id, step id or key is sent back; a wrong parameter value fails validation', () => {
    expect(expand([short('visa-foto')]).issues).toEqual([
      expect.stringContaining('ops.0.preset: unknown preset "visa-foto"'),
    ]);
    expect(expand([short('visa-photo', { params: { idPhoto: { maxKB: 1 } } })]).issues).toEqual([
      'ops.0.params.idPhoto: preset "visa-photo" has no step "idPhoto" (steps: pick, photo, name)',
    ]);
    expect(
      expand([{ op: 'addTool', preset: 'visa-photo', steps: [] as unknown[] }]).issues,
    ).toEqual(['ops.0: unknown key "steps" in addTool {preset}']);
    expect(expand([short('visa-photo', { title: 'x' })]).issues).toEqual([
      'ops.0: unknown key "title" in addTool {preset}',
    ]);
    const bad = expand([short('visa-photo', { params: { photo: { maxKB: 'small' } } })]);
    expect(bad.issues).toEqual([]);
    expect(prepareOps(workspace('en'), (bad.value as { ops: unknown }).ops, ctx('en')).ok).toBe(
      false,
    );
  });

  it('a button that runs a quick action can run a built-in one by its preset id (nothing added)', () => {
    const runner = (tool: string) => [
      {
        op: 'addContainer',
        page: 'home',
        block: { id: 'run-it', look: 'button', tools: [{ tool }] },
      },
    ];
    const ok = prepareOps(workspace('en'), runner('visa-photo'), ctx('en'));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.after.tools).toEqual(workspace('en').tools);
    expect(prepareOps(workspace('en'), runner('visa-foto'), ctx('en')).ok).toBe(false);
  });
});
