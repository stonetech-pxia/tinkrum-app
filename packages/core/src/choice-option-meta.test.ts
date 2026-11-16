import { describe, expect, it } from 'vitest';

import { CHART_COLORS, optionColor } from './chart';
import { sortRecords, type DataRecord } from './data';
import { createDefaultWorkspace } from './defaults';
import { usesOf } from './file-uses';
import { applyOps } from './ops';
import { OPTION_COLORS, OPTION_COLOR_NAMES } from './option-colors';
import { CLAY, MIN_TEXT_CONTRAST, contrast } from './theme';
import { registry } from './test-helpers';
import { validateWorkspace } from './validate';
import { FieldSchema, fieldDefinition, type Collection } from './schema';

// D-568：单选选项可以带一个数（value）和一个有名字的颜色（color）。颜色只在 option-colors.ts 定义一次；
// 没写颜色的选项照旧按顺序取分类色。排序仍然按选项顺序，不看 value。

const plan: Collection = {
  id: 'subs',
  name: 'Subscriptions',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    {
      id: 'cycle',
      name: 'Billing cycle',
      type: 'choice',
      options: [
        { id: 'monthly', label: 'Monthly', value: 12, color: 'blue' },
        { id: 'yearly', label: 'Yearly', value: 1 },
        { id: 'weekly', label: 'Weekly', value: 52, color: 'red' },
      ],
    },
  ],
};

const withTable = (table: Collection) =>
  applyOps(createDefaultWorkspace('en'), [{ op: 'addData', table }], { registry, locale: 'en' });

describe('choice options carry a number and a named colour (D-568)', () => {
  it('the field accepts value and a named colour, and rejects hex codes and text numbers', () => {
    expect(FieldSchema.safeParse(plan.fields[1]).success).toBe(true);
    const bad = (option: object) =>
      FieldSchema.safeParse({
        id: 'c',
        name: 'C',
        type: 'choice',
        options: [{ id: 'a', label: 'A', ...option }],
      }).success;
    expect(bad({ color: '#ff0000' })).toBe(false);
    expect(bad({ color: 'teal' })).toBe(false);
    expect(bad({ value: '3' })).toBe(false);
    expect(bad({ value: -2.5, color: 'grey' })).toBe(true);
  });

  it('a table with them passes validation through the AI op', () => {
    const result = withTable(plan);
    expect(result.ok).toBe(true);
    if (result.ok) expect(validateWorkspace(result.config, registry).ok).toBe(true);
  });

  it('an option with a colour is drawn in it; the others keep the colour of their order', () => {
    const [monthly, yearly, weekly] = (plan.fields[1] as { options: object[] }).options;
    expect(optionColor(monthly, 0, false)).toBe(OPTION_COLORS.blue.light);
    expect(optionColor(monthly, 0, true)).toBe(OPTION_COLORS.blue.dark);
    expect(optionColor(yearly, 1, false)).toBe(CHART_COLORS.light[1]);
    expect(optionColor(weekly, 2, true)).toBe(OPTION_COLORS.red.dark);
    // 没选、第 8 个起：中性灰，和以前一样。
    expect(optionColor(undefined, -1, false)).toBe(CHART_COLORS.other.light);
    expect(optionColor({}, 7, true)).toBe(CHART_COLORS.other.dark);
  });

  it('every named colour reads on the default page and card colours in both modes', () => {
    expect(OPTION_COLOR_NAMES.length).toBeGreaterThanOrEqual(8);
    for (const name of OPTION_COLOR_NAMES) {
      const { light, dark } = OPTION_COLORS[name];
      for (const bg of [CLAY.light.background, CLAY.light.surface])
        expect(contrast(light, bg), `${name} light on ${bg}`).toBeGreaterThanOrEqual(
          MIN_TEXT_CONTRAST,
        );
      for (const bg of [CLAY.dark.background, CLAY.dark.surface])
        expect(contrast(dark, bg), `${name} dark on ${bg}`).toBeGreaterThanOrEqual(
          MIN_TEXT_CONTRAST,
        );
    }
  });

  it('sorting stays by option order, not by value', () => {
    const at = (id: string, cycle: string): DataRecord => ({
      id,
      collectionId: 'subs',
      values: { cycle },
      createdAt: 0,
      updatedAt: 0,
    });
    const sorted = sortRecords([at('w', 'weekly'), at('y', 'yearly'), at('m', 'monthly')], plan, {
      field: 'cycle',
      direction: 'asc',
    });
    expect(sorted.map((r) => r.id)).toEqual(['m', 'y', 'w']);
  });

  it('an exported file names them as features; a plain choice field does not', () => {
    const result = withTable(plan);
    if (!result.ok) throw new Error(result.error);
    expect(usesOf(result.config).features).toEqual(
      expect.arrayContaining(['choiceOptionValue', 'choiceOptionColor']),
    );
    const plain = withTable({
      ...plan,
      fields: [
        plan.fields[0]!,
        { id: 'c', name: 'C', type: 'choice', options: [{ id: 'a', label: 'A' }] },
      ],
    });
    if (!plain.ok) throw new Error(plain.error);
    expect(usesOf(plain.config).features ?? []).not.toContain('choiceOptionValue');
    expect(usesOf(plain.config).features ?? []).not.toContain('choiceOptionColor');
  });

  it('the AI is told about value and the colour names', () => {
    const prompt = fieldDefinition('choice').ai.doc;
    expect(prompt).toMatch(/value\?: a number the option stands for/);
    expect(prompt).toContain('red | orange | yellow | green | blue | purple | pink | grey');
  });
});
