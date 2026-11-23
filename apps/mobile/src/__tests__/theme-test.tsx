import { DEFAULT_THEME, type Theme } from '@morph/core';
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { makePalette } from '../renderer/theme';
import { Card } from '../renderer/ui';

const card = (patch: Partial<Theme>) =>
  makePalette({ ...DEFAULT_THEME, ...patch }, false).cardStyle();

describe('card styles', () => {
  it('keeps the classic shadow, outline and flat cards on the old shadow props', () => {
    expect(card({})).toMatchObject({ shadowRadius: 15 });
    expect(card({ cardStyle: 'outline' })).toMatchObject({ borderWidth: 1 });
    expect(card({ cardStyle: 'flat' })).not.toHaveProperty('boxShadow');
  });

  it('brutal: thick outline and a hard shadow in the text color', () => {
    const style = card({ cardStyle: 'brutal', colors: { text: '#111111' } });
    expect(style).toMatchObject({ borderWidth: 2, borderColor: '#111111' });
    expect(style.boxShadow).toBe('4px 4px 0px #111111');
  });

  it('soft: a light shadow at the top left and a dark one at the bottom right', () => {
    const style = card({
      cardStyle: 'soft',
      colors: { background: '#E0E5EC', surface: '#E0E5EC' },
    });
    expect(style.boxShadow).toMatch(/^-5px -5px 12px #[0-9A-F]{6}, 6px 6px 14px rgba\(/);
    expect(card({ cardStyle: 'soft', mode: 'dark' }).boxShadow).toContain(
      'rgba(255, 255, 255, 0.06)',
    );
  });

  it('glass: translucent card with a light edge, clipped so the glass layer follows the corners', () => {
    const palette = makePalette({ ...DEFAULT_THEME, cardStyle: 'glass' }, false);
    expect(palette.glass).toBe(true);
    expect(palette.cardStyle()).toMatchObject({ overflow: 'hidden', borderWidth: 1 });
    expect(String(palette.cardStyle().backgroundColor)).toMatch(/^rgba\(.*, 0\.4\)$/);
    expect(palette.barBackground).toMatch(/^rgba\(/);
  });

  it('glow: primary-colored border and outer glow', () => {
    const style = card({ cardStyle: 'glow', primaryColor: '#22D3EE' });
    expect(style.borderColor).toBe('rgba(34, 211, 238, 0.7)');
    expect(style.boxShadow).toContain('0px 0px 18px rgba(34, 211, 238');
  });

  it('chrome: metallic gradient from the card color with a top highlight', () => {
    const style = card({ cardStyle: 'chrome', colors: { surface: '#D9DEE5' } });
    expect(style.backgroundImage).toMatch(/^linear-gradient\(180deg, #[0-9A-F]{6} 0%, #D9DEE5 42%/);
    expect(style.boxShadow).toContain('inset 0px 1px 0px');
  });

  it('puffy: an outer shadow plus inner highlight and inner shade', () => {
    const style = card({ cardStyle: 'puffy' });
    expect(String(style.boxShadow).match(/inset/g)).toHaveLength(2);
  });
});

describe('custom card border and shadow (D-624)', () => {
  const custom: NonNullable<Theme['card']> = {
    border: { width: 3, color: 'primary', opacity: 0.5 },
    shadows: [{ x: 4, y: 4, blur: 0, color: 'text' }],
  };

  it('flat: the plain fill with only the given border and shadow', () => {
    const style = card({ cardStyle: 'flat', primaryColor: '#22D3EE', card: custom });
    expect(style).toEqual({
      backgroundColor: '#FFFCF8',
      borderRadius: DEFAULT_THEME.radius,
      borderWidth: 3,
      borderColor: 'rgba(34, 211, 238, 0.5)',
      boxShadow: '4px 4px 0px rgba(42, 36, 32, 1)',
    });
  });

  it('replaces the named style border and shadow, also the classic shadow props', () => {
    const style = card({ cardStyle: 'shadow', card: { shadows: [custom.shadows![0]!] } });
    expect(style).not.toHaveProperty('shadowRadius');
    expect(style).not.toHaveProperty('elevation');
    expect(style).not.toHaveProperty('borderWidth');
    expect(card({ cardStyle: 'brutal', card: { border: custom.border } })).not.toHaveProperty(
      'boxShadow',
    );
  });

  it('glass keeps its translucent fill and clipping; chrome keeps its gradient', () => {
    const glass = card({ cardStyle: 'glass', card: custom });
    expect(String(glass.backgroundColor)).toMatch(/^rgba\(.*, 0\.4\)$/);
    expect(glass).toMatchObject({ overflow: 'hidden', borderWidth: 3 });
    expect(glass.borderColor).not.toContain('255, 255, 255');
    const chrome = card({ cardStyle: 'chrome', colors: { surface: '#D9DEE5' }, card: custom });
    expect(chrome.backgroundImage).toMatch(
      /^linear-gradient\(180deg, #[0-9A-F]{6} 0%, #D9DEE5 42%/,
    );
    expect(chrome.boxShadow).toBe('4px 4px 0px rgba(42, 36, 32, 1)');
  });

  it('dark mode uses the same parameters with dark colors', () => {
    const style = makePalette(
      { ...DEFAULT_THEME, mode: 'dark', cardStyle: 'flat', card: custom },
      false,
    ).cardStyle();
    expect(style.boxShadow).toBe('4px 4px 0px rgba(243, 236, 228, 1)');
  });
});

describe('page backdrop', () => {
  it('plain themes keep a solid background', () => {
    const palette = makePalette(DEFAULT_THEME, false);
    expect(palette.hasBackdrop).toBe(false);
    expect(palette.backdrop).toEqual({ backgroundColor: palette.background });
  });

  it('gradient and aurora draw CSS gradients over the background color', () => {
    const gradient = makePalette({ ...DEFAULT_THEME, backdrop: 'gradient' }, false);
    expect(gradient.backdrop.backgroundImage).toMatch(/^linear-gradient\(170deg, /);
    const aurora = makePalette({ ...DEFAULT_THEME, backdrop: 'aurora' }, false);
    expect(String(aurora.backdrop.backgroundImage).match(/radial-gradient/g)).toHaveLength(3);
    expect(aurora.backdrop.backgroundColor).toBe(aurora.background);
  });
});

describe('glass cards render', () => {
  it('puts a glass layer under the card content', async () => {
    const palette = makePalette(
      { ...DEFAULT_THEME, cardStyle: 'glass', backdrop: 'aurora' },
      false,
    );
    await render(
      <Card palette={palette}>
        <Text>Hello</Text>
      </Card>,
    );
    expect(screen.getByText('Hello')).toBeTruthy();
  });
});
