import { describe, expect, it } from 'vitest';

import { describeChange } from './describe';
import { usesOf, USES_FEATURES } from './file-uses';
import { OpSchema, type Op } from './ops';
import { ThemeSchema, type ThemeCard, type WorkspaceConfig } from './schema';
import { apply, registry, workspace } from './test-helpers';
import {
  cardRoleColors,
  contrastProblems,
  customCardParts,
  DEFAULT_THEME,
  resolveColors,
} from './theme';
import { validateWorkspace } from './validate';

// 卡片的边框和阴影用参数写（D-new-extensibility-1）：theme.card 替换 cardStyle 的边框和阴影，底色仍跟 cardStyle；
// 颜色只能是角色；只换 cardStyle 时 card 一起去掉。

const BRUTAL_LIKE: ThemeCard = {
  border: { width: 2, color: 'text' },
  shadows: [{ x: 4, y: 4, blur: 0, color: 'text' }],
};

const themeWith = (card: unknown) => ({ ...DEFAULT_THEME, cardStyle: 'flat', card });

describe('theme.card schema (D-new-extensibility-1)', () => {
  it('accepts a border, shadows or both', () => {
    expect(ThemeSchema.safeParse(themeWith(BRUTAL_LIKE)).success).toBe(true);
    expect(
      ThemeSchema.safeParse(themeWith({ border: { width: 0.5, color: 'border' } })).success,
    ).toBe(true);
    expect(
      ThemeSchema.safeParse(
        themeWith({
          shadows: [
            { x: 0, y: 12, blur: 24, color: 'shadow', opacity: 0.16 },
            { x: 0, y: 6, blur: 10, color: 'white', opacity: 0.7, inset: true },
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects a hex colour, a fourth shadow, an empty card and values out of range', () => {
    const shadow = { x: 0, y: 4, blur: 8, color: 'shadow' };
    for (const card of [
      { border: { width: 2, color: '#FF0000' } },
      { shadows: [shadow, shadow, shadow, shadow] },
      {},
      { shadows: [] },
      { border: { width: 5, color: 'text' } },
      { border: { width: 2, color: 'text', opacity: 0 } },
      { shadows: [{ ...shadow, blur: 41 }] },
      { shadows: [{ ...shadow, inset: false }] },
      { border: { width: 2, color: 'text' }, glow: true },
    ]) {
      expect(ThemeSchema.safeParse(themeWith(card)).success, JSON.stringify(card)).toBe(false);
    }
  });

  it('a theme without card is still valid (old configs)', () => {
    expect(ThemeSchema.safeParse(DEFAULT_THEME).success).toBe(true);
  });
});

describe('setTheme card (D-new-extensibility-1)', () => {
  it('sets it, removes it with null, and a cardStyle-only change removes it too', () => {
    const custom = apply(workspace(), [{ op: 'setTheme', cardStyle: 'flat', card: BRUTAL_LIKE }]);
    expect(custom.theme).toMatchObject({ cardStyle: 'flat', card: BRUTAL_LIKE });
    expect(validateWorkspace(custom, registry).ok).toBe(true);

    // 别的键不动 card。
    expect(apply(custom, [{ op: 'setTheme', radius: 4 }]).theme.card).toEqual(BRUTAL_LIKE);
    expect(apply(custom, [{ op: 'setTheme', card: null }]).theme).not.toHaveProperty('card');
    expect(apply(custom, [{ op: 'setTheme', cardStyle: 'outline' }]).theme).not.toHaveProperty(
      'card',
    );
    expect(apply(custom, [{ op: 'setTheme', preset: 'neon' }]).theme).not.toHaveProperty('card');
    expect(apply(custom, [{ op: 'setTheme', reset: true }]).theme).not.toHaveProperty('card');
  });

  it('works the same on an app theme and leaves the home theme alone', () => {
    const withApp = apply(workspace('en'), [
      { op: 'addContainer', app: { id: 'fit', name: 'Fitness' } },
    ]);
    const appTheme = (c: WorkspaceConfig) => c.nav.apps?.find((a) => a.id === 'fit')?.theme;
    const custom = apply(withApp, [
      { op: 'setTheme', app: 'fit', cardStyle: 'glass', card: BRUTAL_LIKE },
    ]);
    expect(appTheme(custom)?.card).toEqual(BRUTAL_LIKE);
    expect(custom.theme).not.toHaveProperty('card');
    expect(
      appTheme(apply(custom, [{ op: 'setTheme', app: 'fit', card: null }])),
    ).not.toHaveProperty('card');
    expect(
      appTheme(apply(custom, [{ op: 'setTheme', app: 'fit', cardStyle: 'shadow' }])),
    ).not.toHaveProperty('card');
  });

  it('keeps the {preset} / {reset} alone rule', () => {
    expect(OpSchema.safeParse({ op: 'setTheme', card: null }).success).toBe(true);
    expect(OpSchema.safeParse({ op: 'setTheme', preset: 'neon', card: BRUTAL_LIKE }).success).toBe(
      false,
    );
    expect(OpSchema.safeParse({ op: 'setTheme', reset: true, card: null }).success).toBe(false);
    expect(
      OpSchema.safeParse({ op: 'setTheme', card: { border: { width: 2, color: '#000000' } } })
        .success,
    ).toBe(false);
  });
});

describe('customCardParts (D-new-extensibility-1)', () => {
  it('builds the border and a CSS box-shadow from roles, in light and dark', () => {
    for (const dark of [false, true]) {
      const c = resolveColors(DEFAULT_THEME, dark);
      const roles = cardRoleColors(c, c);
      const parts = customCardParts(BRUTAL_LIKE, (role) => roles[role]);
      const ink = dark ? '243, 236, 228' : '42, 36, 32';
      expect(parts).toEqual({
        borderWidth: 2,
        borderColor: `rgba(${ink}, 1)`,
        boxShadow: `4px 4px 0px rgba(${ink}, 1)`,
      });
    }
  });

  it('writes inset and opacity, joins several shadows, and leaves out what is not set', () => {
    const parts = customCardParts(
      {
        shadows: [
          { x: 0, y: 12, blur: 24, color: 'black', opacity: 0.2 },
          { x: 0, y: -6, blur: 12, color: 'white', opacity: 0.5, inset: true },
        ],
      },
      (role) => (role === 'white' ? '#FFFFFF' : '#000000'),
    );
    expect(parts).toEqual({
      boxShadow: '0px 12px 24px rgba(0, 0, 0, 0.2), inset 0px -6px 12px rgba(255, 255, 255, 0.5)',
    });
    expect(
      customCardParts({ border: { width: 1, color: 'primary', opacity: 0.5 } }, () => '#C8623A'),
    ).toEqual({
      borderWidth: 1,
      borderColor: 'rgba(200, 98, 58, 0.5)',
    });
  });

  it('text is the page text, border and shadow come from the card palette', () => {
    const page = resolveColors(DEFAULT_THEME, false);
    const card = { ...page, text: '#111111', border: '#222222', shadow: '#333333' };
    const roles = cardRoleColors(card, page);
    expect(roles).toMatchObject({
      text: page.text,
      border: '#222222',
      shadow: '#333333',
      primary: page.primary,
      white: '#FFFFFF',
      black: '#000000',
    });
  });
});

describe('theme.card elsewhere (D-new-extensibility-1)', () => {
  it('does not change the contrast check: border and shadow leave the fill alone', () => {
    for (const cardStyle of ['flat', 'glass', 'chrome'] as const) {
      const theme = {
        ...DEFAULT_THEME,
        mode: 'system' as const,
        backdrop: 'aurora' as const,
        cardStyle,
      };
      expect(contrastProblems({ ...theme, card: BRUTAL_LIKE })).toEqual(contrastProblems(theme));
    }
  });

  it('an app file with a custom card lists themeCard', () => {
    expect(USES_FEATURES).toContain('themeCard');
    const custom = apply(workspace(), [{ op: 'setTheme', card: BRUTAL_LIKE }]);
    expect(usesOf(custom).features).toContain('themeCard');
    expect(usesOf(workspace()).features ?? []).not.toContain('themeCard');
  });

  it('describes setting and removing it in three languages', () => {
    const before = workspace();
    const ctx = (locale: 'en' | 'zh' | 'fr') => ({ registry, locale, now: new Date(2026, 10, 23) });
    const set: Op = { op: 'setTheme', cardStyle: 'flat', card: BRUTAL_LIKE };
    const removed: Op = { op: 'setTheme', card: null };
    expect(describeChange([set], before, [], ctx('en'))).toContain(
      'Cards: custom border and shadow',
    );
    expect(describeChange([set], before, [], ctx('zh'))).toContain('卡片：自定义边框和阴影');
    expect(describeChange([set], before, [], ctx('fr'))).toContain(
      'Cartes : bordure et ombre personnalisées',
    );
    expect(describeChange([removed], before, [], ctx('en'))).toEqual([
      'Cards: back to the border and shadow of the card style',
    ]);
    expect(describeChange([removed], before, [], ctx('zh'))).toEqual([
      '卡片：边框和阴影回到卡片样式自带的',
    ]);
    expect(describeChange([removed], before, [], ctx('fr'))).toEqual([
      'Cartes : retour à la bordure et à l’ombre du style de carte',
    ]);
  });
});
