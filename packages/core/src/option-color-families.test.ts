import { describe, expect, it } from 'vitest';

import { CHART_COLORS, optionColor } from './chart';
import { CHART_COLOR_FAMILIES, OPTION_COLORS, type OptionColor } from './option-colors';

// D-571: when a single-choice field has options with explicit colors, uncolored options avoid
// picking category colors from the same color family (Simulator QA checklist P1: expense red,
// income green, uncolored "transfer" gets teal, avoiding confusion with income). Behaves exactly as
// before when zero options have colors.

type Option = { id: string; color?: OptionColor };
const options: Option[] = [
  { id: 'expense', color: 'red' },
  { id: 'income', color: 'green' },
  { id: 'transfer' },
  { id: 'refund' },
];

const familiesOf = (hex: string, dark: boolean): readonly OptionColor[] => {
  const scheme: readonly string[] = dark ? CHART_COLORS.dark : CHART_COLORS.light;
  return CHART_COLOR_FAMILIES[scheme.indexOf(hex)] ?? [];
};

describe('option colours avoid the hue families named in the same field', () => {
  it('every palette colour has its family declared once', () => {
    expect(CHART_COLOR_FAMILIES).toHaveLength(CHART_COLORS.light.length);
    expect(CHART_COLORS.dark).toHaveLength(CHART_COLORS.light.length);
    for (const families of CHART_COLOR_FAMILIES) {
      expect(families.length).toBeGreaterThan(0);
      for (const f of families) expect(Object.keys(OPTION_COLORS)).toContain(f);
    }
    // Teal and green belong to the same color family (the P1 pair).
    expect(CHART_COLOR_FAMILIES[2]).toContain('green');
  });

  it('an option without a colour is not in the family of a named sibling (light and dark)', () => {
    for (const dark of [false, true]) {
      const transfer = optionColor(options[2], 2, dark, options);
      const refund = optionColor(options[3], 3, dark, options);
      for (const hex of [transfer, refund]) {
        expect(familiesOf(hex, dark)).not.toContain('green');
        expect(familiesOf(hex, dark)).not.toContain('red');
      }
      // Two uncolored options remain distinct from each other, while named ones behave as usual.
      expect(transfer).not.toBe(refund);
      expect(optionColor(options[0], 0, dark, options)).toBe(
        OPTION_COLORS.red[dark ? 'dark' : 'light'],
      );
    }
    // The first uncolored option gets the remaining first color (blue).
    expect(optionColor(options[2], 2, false, options)).toBe(CHART_COLORS.light[0]);
  });

  it('the same option gets the same colour wherever it is drawn (any index)', () => {
    expect(optionColor(options[2], 0, false, options)).toBe(
      optionColor(options[2], 5, false, options),
    );
  });

  it('when no option of the field has a colour, the colours are exactly the by-order ones', () => {
    const plain: Option[] = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}` }));
    for (const dark of [false, true]) {
      const scheme: readonly string[] = dark ? CHART_COLORS.dark : CHART_COLORS.light;
      plain.forEach((o, i) => {
        const expected = scheme[i] ?? CHART_COLORS.other[dark ? 'dark' : 'light'];
        expect(optionColor(o, i, dark, plain)).toBe(expected);
        expect(optionColor(o, i, dark)).toBe(expected);
      });
      expect(optionColor(undefined, -1, dark, plain)).toBe(
        CHART_COLORS.other[dark ? 'dark' : 'light'],
      );
    }
  });

  it('when every family is taken, the rest are neutral grey', () => {
    const named: OptionColor[] = ['red', 'green', 'blue', 'yellow', 'pink', 'purple', 'orange'];
    const crowded: Option[] = [...named.map((color, i) => ({ id: `n${i}`, color })), { id: 'x' }];
    expect(optionColor(crowded[7], 7, false, crowded)).toBe(CHART_COLORS.other.light);
  });
});
