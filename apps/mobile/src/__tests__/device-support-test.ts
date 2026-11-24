import {
  BUILTIN_TOOLS,
  createDefaultWorkspace,
  createRegistry,
  deskToolbar,
  quickActionsOf,
  type SharedFileInfo,
  type Workflow,
} from '@morph/core';

import { toolEntries } from '../desk/DeskToolbar';
import { runsHere } from '../runtime/device-support';
import { shareRecommendations } from '../share/recommendations';

// PDF passwords (add/remove password) implemented only on iOS (P-025). No native module on Android
// (nor in tests), entry not shown: founder 2026-10-31 "Identify Android, do not show this feature".

const registry = createRegistry(BUILTIN_TOOLS);
const config = createDefaultWorkspace('zh');
const pdf: SharedFileInfo = { name: 'a.pdf', mimeType: 'application/pdf', size: 10 };
const PASSWORD = ['pdf.protect', 'pdf.unlock'];

const protect: Workflow = {
  kind: 'quickAction',
  id: 'mine-protect',
  name: 'mine',
  steps: [
    { id: 'pick', action: 'in.files', params: { accept: 'pdf', min: 1, max: 10 } },
    { id: 'run', action: 'pdf.protect', params: {} },
  ],
};

describe('Phones without PDF password module', () => {
  it('Quick actions using passwords cannot run here', () => {
    expect(runsHere(protect)).toBe(false);
    expect(runsHere({ ...protect, steps: protect.steps.slice(0, 1) })).toBe(true);
  });

  it('PDF desk toolbar lacks add/remove password', () => {
    const file = {
      id: 'f',
      name: 'a',
      ext: 'pdf',
      mimeType: 'application/pdf',
      size: 10,
      uri: 'file:///a.pdf',
    } as never;
    const groups = toolEntries(
      deskToolbar('pdf', {}, registry, quickActionsOf(config), 'zh'),
      [file],
      registry,
      quickActionsOf(config),
      'zh',
    );
    const items = groups.flatMap((g) => g.entries.map((e) => e.item));
    const actions = items.flatMap((i) => (typeof i === 'object' ? [i.action] : []));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.filter((a) => PASSWORD.includes(a))).toEqual([]);
    expect(items.filter((i) => i === 'pdf-protect' || i === 'pdf-unlock')).toEqual([]);
  });

  it('Inbox does not recommend, nor is it present in "View all"', () => {
    const result = shareRecommendations(
      [...quickActionsOf(config), protect],
      [pdf],
      new Map([['mine-protect', { count: 9, lastAt: 1 }]]),
      'zh',
    );
    const ids = result.all.map((r) => r.wf.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => ['mine-protect', 'pdf-protect', 'pdf-unlock'].includes(id))).toEqual(
      [],
    );
  });
});
