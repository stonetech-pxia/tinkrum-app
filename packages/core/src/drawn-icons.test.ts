import { describe, expect, it } from 'vitest';

import {
  DrawnIconsSchema,
  MAX_DRAWN_ICON_CHARS,
  MAX_DRAWN_ICONS,
  drawnIconId,
  drawnIconUses,
  isDrawnIconRef,
  pathDataProblem,
  renameDrawnIcons,
} from './drawn-icons';

// Drawn icon path syntax (D-625): only accepts SVG path geometry commands and ordinary numbers.

describe('pathDataProblem', () => {
  it('accepts real icon paths, with arcs, relative commands, implicit repeats and compact numbers', () => {
    for (const d of [
      // Heart shape (Material Icons).
      'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
      // Donut shape (two arcs, even-odd fill).
      'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20zM12 6a6 6 0 1 1 0 12 6 6 0 1 1 0-12z',
      // Compact arc flags and chained decimals.
      'M2 2a1 1 0 00 1 1a.5.5 0 01.5.5',
      'm4 4h16v16H4z',
      'M3 12h18M12 3v18',
      'M4 4L20 20 L4 20Z',
      'M2 12Q6 2 12 12T22 12',
      'M2 12C2 6 8 6 8 12S14 18 14 12',
      'M5,5 L19,19',
      '  M1 1 V5 H5 z  ',
    ]) {
      expect(pathDataProblem(d), d).toBeNull();
    }
  });

  it('rejects markup, other letters, links, wrong argument counts, empty data and exponents', () => {
    for (const [d, says] of [
      ['<path d="M0 0"/>', 'must start with M'],
      ['M0 0 L<1 2', 'not allowed'],
      ['M0 0 X 4 4', '"X" is not allowed'],
      ['M0 0 url(#a)', '"u" is not allowed'],
      ['M0 0 L1', 'L needs 2 numbers'],
      ['M0 0 C1 2 3 4 5', 'C needs 6 numbers'],
      ['M0 0 A1 1 0 2 0 4 4', 'flag 0 or 1'],
      ['', 'is empty'],
      ['   ', 'is empty'],
      ['L0 0', 'must start with M'],
      ['M1e2 0', 'exponent'],
      ['M0 0 L1 2;', '";" is not allowed'],
    ] as const) {
      expect(pathDataProblem(d), d).toContain(says);
    }
  });
});

describe('DrawnIconsSchema', () => {
  const ok = { paths: ['M4 4h16v16H4z'] };

  it('takes up to 40 icons with valid ids and 1–8 paths', () => {
    expect(DrawnIconsSchema.safeParse({ paw: ok, 'cat-2': { ...ok, stroke: true } }).success).toBe(
      true,
    );
    const many = Object.fromEntries(
      Array.from({ length: MAX_DRAWN_ICONS + 1 }, (_, n) => [`i${n}`, ok]),
    );
    expect(DrawnIconsSchema.safeParse(many).success).toBe(false);
    for (const bad of [
      { Paw: ok },
      { '1paw': ok },
      { paw: { paths: [] } },
      { paw: { paths: Array(9).fill('M0 0') } },
      { paw: { ...ok, stroke: false } },
      { paw: { ...ok, fill: '#000000' } },
    ]) {
      expect(DrawnIconsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('names the icon when a path is wrong or the icon is too long', () => {
    const wrong = DrawnIconsSchema.safeParse({ paw: { paths: ['M0 0', 'M0 0 <script>'] } });
    expect(wrong.success).toBe(false);
    expect(wrong.error?.issues[0]?.message).toContain('icon paw: path 2');
    const long = 'M0 0' + ' L1 1'.repeat(MAX_DRAWN_ICON_CHARS / 5);
    const tooLong = DrawnIconsSchema.safeParse({ big: { paths: [long] } });
    expect(tooLong.error?.issues[0]?.message).toContain('icon big:');
    expect(tooLong.error?.issues[0]?.message).toContain(`at most ${MAX_DRAWN_ICON_CHARS}`);
  });
});

describe('references', () => {
  it('reads my:<id> and nothing else', () => {
    expect(isDrawnIconRef('my:paw')).toBe(true);
    expect(drawnIconId('my:paw-2')).toBe('paw-2');
    for (const v of ['paw', 'my:', 'my:Paw', 'my:paw!', '🐾', 'star', 3]) {
      expect(drawnIconId(v), String(v)).toBeNull();
    }
  });

  it('finds every icon key at any depth, skips the library and renames', () => {
    const content = {
      icons: { paw: { paths: ['M0 0'] } },
      data: { tables: [{ id: 'pets', icon: 'my:paw' }] },
      containers: {
        pages: [{ id: 'home', icon: 'star', blocks: [{ id: 'b', show: { icon: 'my:dot' } }] }],
      },
    };
    expect(drawnIconUses(content)).toEqual([
      { id: 'paw', where: 'data.tables.pets.icon' },
      { id: 'dot', where: 'containers.pages.home.blocks.b.show.icon' },
    ]);
    const renamed = renameDrawnIcons(content, new Map([['paw', 'paw-2']]));
    expect(renamed.data.tables[0]!.icon).toBe('my:paw-2');
    expect(renamed.containers.pages[0]!.blocks[0]!.show.icon).toBe('my:dot');
    expect(renamed.icons).toEqual(content.icons);
  });
});
