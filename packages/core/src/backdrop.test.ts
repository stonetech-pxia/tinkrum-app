import { describe, expect, it } from 'vitest';

import { describeChange } from './describe';
import { applyOps, OpSchema, type Op } from './ops';
import { THEME_PRESETS } from './presets';
import type { WorkspaceConfig } from './schema';
import { registry, workspace } from './test-helpers';
import {
  DEFAULT_THEME,
  MIN_TEXT_CONTRAST,
  OVERLAY_OPACITY,
  contrast,
  overlayContrast,
  overlayOpacity,
  resolveColors,
} from './theme';
import { validateWorkspace } from './validate';

// Image background (D-258): card block style.backdrop and page backdrop (v34: updateContainer changes).

function apply(config: WorkspaceConfig, ops: Op[]): WorkspaceConfig {
  const result = applyOps(config, ops, { registry, locale: 'en' });
  if (!result.ok) throw new Error(result.error);
  return result.config;
}
const ctx = (locale: 'en' | 'zh' | 'fr') => ({ registry, locale, now: new Date(2026, 9, 27) });

const NOTE: Op = {
  op: 'addContainer',
  page: 'home',
  block: { id: 'tip', look: 'notice', show: { text: 'Hello' } },
};
const style = (backdrop: unknown): Op =>
  ({
    op: 'updateContainer',
    page: 'home',
    block: 'tip',
    changes: { style: { backdrop } },
  }) as Op;
const pageBackdrop = (backdrop: unknown): Op =>
  ({ op: 'updateContainer', page: 'home', changes: { backdrop } }) as Op;
const home = (c: WorkspaceConfig) => c.containers.pages[0]!;
const tip = (c: WorkspaceConfig) =>
  home(c).blocks.find((x) => x.id === 'tip') as { style?: Record<string, unknown> };

describe('backdrop ops', () => {
  it('AI turns it on and sets the overlay; the picture the user chose stays', () => {
    const on = apply(workspace('en'), [NOTE, style({ overlay: 'strong' })]);
    expect(tip(on).style).toEqual({ backdrop: { overlay: 'strong' } });
    expect(validateWorkspace(on, registry).ok).toBe(true);

    // User selected an image in long-press edit.
    const picked = apply(on, [style({ assetId: 'abc123def' })]);
    expect(tip(picked).style).toEqual({ backdrop: { overlay: 'strong', assetId: 'abc123def' } });
    // Adjust only overlay after AI: image remains unchanged.
    const lighter = apply(picked, [style({ overlay: 'light' })]);
    expect(tip(lighter).style).toEqual({ backdrop: { overlay: 'light', assetId: 'abc123def' } });
    // Remove image: image background remains enabled; turn off: removes it entirely.
    expect(tip(apply(lighter, [style({ assetId: null })])).style).toEqual({
      backdrop: { overlay: 'light' },
    });
    expect(tip(apply(lighter, [style(null)])).style).toBeUndefined();
  });

  it('choosing a picture first turns it on with the medium overlay', () => {
    const picked = apply(workspace('en'), [NOTE, style({ assetId: 'abc123def' })]);
    expect(tip(picked).style).toEqual({ backdrop: { overlay: 'medium', assetId: 'abc123def' } });
  });

  it('pages: the page backdrop merges the same way', () => {
    const op = pageBackdrop;
    const on = apply(workspace('en'), [op({ overlay: 'light' })]);
    expect(home(on).backdrop).toEqual({ overlay: 'light' });
    const picked = apply(on, [op({ assetId: 'abc123def' })]);
    expect(home(apply(picked, [op({ overlay: 'strong' })])).backdrop).toEqual({
      overlay: 'strong',
      assetId: 'abc123def',
    });
    expect(home(apply(picked, [op(null)])).backdrop).toBeUndefined();
    expect(validateWorkspace(picked, registry).ok).toBe(true);
  });

  it('only card blocks can have one; a bad overlay or a file name is refused', () => {
    const header = apply(workspace('en'), [
      {
        op: 'updateContainer',
        page: 'home',
        block: 'welcome',
        changes: { style: { backdrop: { overlay: 'medium' } } },
      },
    ]);
    const result = validateWorkspace(header, registry);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(
      /can't have a picture background: style.backdrop is only for .*notice/,
    );
    for (const bad of [{ overlay: 'black' }, { assetId: 'photo.jpg' }, { color: '#000000' }]) {
      expect(OpSchema.safeParse(style(bad)).success, JSON.stringify(bad)).toBe(false);
      expect(OpSchema.safeParse(pageBackdrop(bad)).success).toBe(false);
    }
  });

  it('describes the change in all three languages', () => {
    const before = apply(workspace('en'), [NOTE]);
    expect(describeChange([style({ overlay: 'medium' })], before, [], ctx('zh'))).toEqual([
      expect.stringContaining('开启图片背景（长按选择图片）'),
    ]);
    const on = apply(before, [style({ overlay: 'medium' })]);
    expect(describeChange([style({ overlay: 'strong' })], on, [], ctx('en'))[0]).toContain(
      'picture overlay strong',
    );
    expect(describeChange([style(null)], on, [], ctx('fr'))[0]).toContain(
      'image de fond désactivée',
    );
    expect(describeChange([pageBackdrop({ assetId: 'abc123def' })], on, [], ctx('zh'))[0]).toMatch(
      /^页面「.*」：更换背景图片$/,
    );
  });
});

describe('overlay contrast', () => {
  it('worst case is the overlay over pure black or pure white', () => {
    expect(overlayContrast('#000000', '#FFFFFF', 1)).toBeCloseTo(21);
    // Very faint white overlay: dark text at the darkest point of the image has only a dark grey background.
    expect(overlayContrast('#000000', '#FFFFFF', 0.3)).toBeLessThan(MIN_TEXT_CONTRAST);
    // Text luminance between the two extremes: image brightness matches text brightness at a certain point.
    expect(overlayContrast('#777777', '#FFFFFF', 0.3)).toBe(1);
  });

  const themes = [
    ['default', DEFAULT_THEME],
    ...Object.entries(THEME_PRESETS).map(([id, p]) => [id, p.theme] as const),
  ] as const;

  it('every style, light and dark, every card color and level: text passes the contrast check over any picture', () => {
    for (const [id, theme] of themes) {
      for (const dark of [false, true]) {
        const c = resolveColors(theme, dark);
        for (const bg of [
          c.background,
          c.surface,
          c.primaryTint,
          c.secondaryTint,
          c.tertiaryTint,
        ]) {
          for (const level of ['light', 'medium', 'strong'] as const) {
            const opacity = overlayOpacity(level, bg, c.text);
            const where = `${id} ${dark ? 'dark' : 'light'} ${bg} ${level}`;
            expect(opacity, where).toBeGreaterThanOrEqual(OVERLAY_OPACITY[level]);
            // Passes existing contrast check (4.5) on solid background, and passes when overlaid on any image; does not worsen items that already fall short.
            const need = Math.min(MIN_TEXT_CONTRAST, contrast(c.text, bg)) - 0.01;
            expect(overlayContrast(c.text, bg, opacity), where).toBeGreaterThanOrEqual(need);
            if (bg === c.surface || bg === c.background)
              expect(overlayContrast(c.text, bg, opacity), where).toBeGreaterThanOrEqual(
                MIN_TEXT_CONTRAST,
              );
          }
        }
      }
    }
  });

  it('a stronger level is never more transparent', () => {
    const c = resolveColors(DEFAULT_THEME, false);
    const [l, m, s] = (['light', 'medium', 'strong'] as const).map((x) =>
      overlayOpacity(x, c.surface, c.text),
    );
    expect(l).toBeLessThanOrEqual(m!);
    expect(m).toBeLessThanOrEqual(s!);
    expect(s).toBeLessThanOrEqual(1);
    // The three tiers in the default style are genuinely distinct (images won't be obscured beyond recognition).
    expect(new Set([l, m, s]).size).toBe(3);
  });
});
