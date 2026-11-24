import type { Theme } from './schema';
import type { Backdrop, CardColorRole, ThemeCard, ThemeColors } from './schema-base';

// Default "Clay" style (from Docudis design tokens: sand background, cream cards, terracotta orange
// primary, sage green secondary), along with pure functions calculating final color schemes based
// on the theme. Shared by app rendering and the validator (contrast checking).

export const CLAY = {
  primary: '#C8623A',
  light: {
    background: '#F5EFE8',
    surface: '#FFFCF8',
    text: '#2A2420',
    muted: '#6B5F55',
    caption: '#8A7B6F',
    border: '#E8DFD4',
    secondary: '#6B7F62',
    tertiary: '#B8926A',
    danger: '#B03A2E',
    shadow: '#785A3C',
  },
  // Docudis only defines light mode; dark mode is a warm-brown derivative derived using the same hue.
  dark: {
    background: '#1C1815',
    surface: '#28221E',
    text: '#F3ECE4',
    muted: '#C2B5A9',
    caption: '#9C8F84',
    border: '#3B332D',
    secondary: '#8FA585',
    tertiary: '#C9A57F',
    danger: '#E0786B',
    shadow: '#000000',
  },
} as const;

export const DEFAULT_THEME: Theme = {
  primaryColor: CLAY.primary,
  mode: 'light',
  colors: {},
  font: 'clay',
  fontScale: 1,
  radius: 22,
  density: 'comfortable',
  cardStyle: 'shadow',
  navStyle: 'iconLabel',
};

/**
 * Style for first-time users upon initial launch (D-487): refines Clay - cards feature a
 * clay-like feel (inner highlights + soft shadows), page backgrounds have a subtle warm gradient,
 * icons use light colored backgrounds, and corner radii are slightly increased. Primary colors,
 * typography, and color schemes remain unchanged. DEFAULT_THEME remains the baseline: tests,
 * evaluations, old configs, and "reset theme" revert to it; only starter config and Clay presets
 * use this (Clay preset page backgrounds are solid colors, D-552).
 */
export const STARTER_THEME: Theme = {
  ...DEFAULT_THEME,
  radius: 26,
  cardStyle: 'puffy',
  backdrop: 'gradient',
  iconStyle: 'tint',
};

export interface ResolvedColors {
  dark: boolean;
  background: string;
  surface: string;
  text: string;
  muted: string;
  caption: string;
  border: string;
  primary: string;
  /** Text color on primary background, equivalent to onAccent(primary). */
  onPrimary: string;
  /** Primary color used for text (links, selected navigation items); automatically darkened or lightened if contrast against the background is insufficient. */
  primaryText: string;
  primaryTint: string;
  secondary: string;
  secondaryTint: string;
  onSecondaryTint: string;
  tertiary: string;
  tertiaryTint: string;
  onTertiaryTint: string;
  danger: string;
  shadow: string;
  /** Overlay scrim for bottom sheets and centered dialogs. */
  scrim: string;
  scrimStrong: string;
}

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const toHex = ([r, g, b]: number[]) =>
  `#${[r, g, b].map((v) => Math.round(v!).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/** Mixes two colors by ratio t (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const ca = rgb(a);
  const cb = rgb(b);
  return toHex(ca.map((v, i) => v + (cb[i]! - v) * t));
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio (1–21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * Text color on any solid background (shared by primary buttons, banner prompts, selected pills,
 * and step dots): uses white if the contrast is at least 3:1 (the requirement for bold and UI
 * text), otherwise uses dark text. Medium-brightness primary colors (such as Clay's terracotta)
 * therefore retain white text (selected by the founder on 2026-11-22).
 */
export function onAccent(accent: string): string {
  return contrast('#FFFFFF', accent) >= 3 ? '#FFFFFF' : '#1A1714';
}

/** Ensures color achieves min contrast against background by progressively mixing toward toward. */
function readable(color: string, background: string, toward: string, min: number): string {
  for (let t = 0; t <= 1; t += 0.1) {
    const c = t === 0 ? color : mix(color, toward, t);
    if (contrast(c, background) >= min) return c;
  }
  return toward;
}

export function isDark(theme: Theme, systemDark: boolean): boolean {
  return theme.mode === 'dark' || (theme.mode === 'system' && systemDark);
}

/** Calculates all colors from this group of base and text colors. readOn: what background color the primary color is pressed against when used as text. */
function buildColors(
  theme: Theme,
  dark: boolean,
  o: ThemeColors,
  on: {
    background: string;
    surface: string;
    text: string;
    /** Gray text, descriptions, and dividers are calculated based on text and surface (otherwise uses default style values). */
    derive: boolean;
    readOn: string;
    shadowInk: string;
    /** When a card has its own custom text color (D-409): danger colors must be clear against this background; default style reds are tailored only for light or dark backgrounds. */
    dangerOn?: string;
  },
): ResolvedColors {
  const base = dark ? CLAY.dark : CLAY.light;
  const { background, surface, text, derive, readOn, shadowInk } = on;
  const secondary = o.secondary ?? base.secondary;
  const tertiary = o.tertiary ?? base.tertiary;
  const primary = theme.primaryColor;
  const tintAmount = dark ? 0.78 : 0.82;
  const custom = Boolean(o.text || o.surface || o.background);
  return {
    dark,
    scrim: `${CLAY.light.text}4D`,
    scrimStrong: `${CLAY.light.text}80`,
    background,
    surface,
    text,
    muted: derive ? mix(text, surface, 0.3) : base.muted,
    caption: derive ? mix(text, surface, 0.45) : base.caption,
    border: derive ? mix(surface, text, 0.12) : base.border,
    primary,
    onPrimary: onAccent(primary),
    primaryText: readable(primary, readOn, text, 3),
    primaryTint: mix(primary, surface, tintAmount),
    secondary,
    secondaryTint: mix(secondary, surface, tintAmount),
    onSecondaryTint: readable(secondary, mix(secondary, surface, tintAmount), text, 4.5),
    tertiary,
    tertiaryTint: mix(tertiary, surface, tintAmount),
    onTertiaryTint: readable(tertiary, mix(tertiary, surface, tintAmount), text, 4.5),
    danger: on.dangerOn ? readable(base.danger, on.dangerOn, text, 3) : base.danger,
    // In light mode, Clay's warm brown shadow is suitable only for the Clay color scheme; when the scheme changes, shadows use the body text color, following the theme's hue.
    shadow: custom && !dark ? shadowInk : base.shadow,
  };
}

/** Color overrides active in this mode. Dark mode: darkColors take priority, unconfigured colors fall back to colors (legacy themes only have colors, behavior unchanged). */
const overridesOf = (theme: Theme, dark: boolean): ThemeColors =>
  dark ? { ...theme.colors, ...theme.darkColors } : theme.colors;

/** Returns the card's custom text color if present (D-409); if omitted or identical to the body text color, only a single text color is used. */
function cardInk(o: ThemeColors, text: string): string | undefined {
  return o.surfaceText && o.surfaceText !== text ? o.surfaceText : undefined;
}

/** Shadows must sit atop the page: takes the darker of the two text colors, preventing light cards on dark pages from turning into a glowing border. */
const shadowInkOf = (text: string, ink: string | undefined) =>
  ink && luminance(ink) < luminance(text) ? ink : text;

/**
 * Colors placed on the page background. When surfaceText is set and the body text color is
 * unclear on cards (D-409), the surface here is a layer derived from the page background, used
 * for navigation bars, modals, and system page cards that still use this palette, ensuring body
 * text is always legible against it; actual card colors and card text colors are defined in
 * resolveSurfaceColors.
 */
export function resolveColors(theme: Theme, dark: boolean): ResolvedColors {
  const base = dark ? CLAY.dark : CLAY.light;
  const o = overridesOf(theme, dark);
  const background = o.background ?? base.background;
  const surface = o.surface ?? base.surface;
  const text = o.text ?? base.text;
  const ink = cardInk(o, text);
  const raised = mix(background, text, 0.1);
  const pageSurface =
    !ink || contrast(text, surface) >= MIN_TEXT_CONTRAST
      ? surface
      : contrast(text, raised) >= MIN_TEXT_CONTRAST
        ? raised
        : background;
  return buildColors(theme, dark, o, {
    background,
    surface: pageSurface,
    text,
    derive: Boolean(o.text || o.surface),
    readOn: ink ? background : surface,
    shadowInk: shadowInkOf(text, ink),
    ...(ink ? { dangerOn: pageSurface } : {}),
  });
}

/**
 * Colors placed on cards (D-409): text, muted text, and dividers are all calculated from
 * surfaceText and card colors. The background here is the recessed layer within cards (toned
 * muted cards, background outside input fields), ensuring surfaceText is also legible on it.
 * Returns undefined when surfaceText is not set (or equals body text color): cards and pages use
 * resolveColors exclusively, maintaining legacy behavior.
 */
export function resolveSurfaceColors(theme: Theme, dark: boolean): ResolvedColors | undefined {
  const base = dark ? CLAY.dark : CLAY.light;
  const o = overridesOf(theme, dark);
  const text = o.text ?? base.text;
  const ink = cardInk(o, text);
  if (!ink) return undefined;
  const surface = o.surface ?? base.surface;
  return buildColors(theme, dark, o, {
    background: mix(surface, ink, 0.06),
    surface,
    text: ink,
    derive: true,
    readOn: surface,
    shadowInk: shadowInkOf(text, ink),
    dangerOn: surface,
  });
}

/** Proportion of the card color in frosted glass cards, with the rest letting the page background bleed through (contrast checks estimate actual card color using this ratio). */
export const GLASS_OPACITY = 0.4;

/** Opacity of the center of each color blob in aurora backgrounds. */
export const AURORA_ALPHA = { light: 0.45, dark: 0.5 } as const;

/**
 * Colors appearing on the page background (opacity values). The renderer draws gradients using
 * them, and the validator checks text legibility against them. gradient: primary light ->
 * background -> secondary light; aurora: center colors of the three light blobs (primary,
 * secondary, tertiary).
 */
export function backdropStops(theme: Theme, c: ResolvedColors): string[] {
  switch (theme.backdrop) {
    case 'gradient':
      return [
        mix(c.background, c.primary, 0.3),
        c.background,
        mix(c.background, c.secondary, 0.25),
      ];
    case 'aurora': {
      const alpha = c.dark ? AURORA_ALPHA.dark : AURORA_ALPHA.light;
      return [c.primary, c.secondary, c.tertiary].map((x) => mix(c.background, x, alpha));
    }
    default:
      return [c.background];
  }
}

/** The four color stops for metallic cards (top highlight, middle transition from light to dark, bottom reflection), calculated from the card background color. */
export function chromeStops(base: string, dark: boolean): [string, string, string, string] {
  return [
    mix(base, '#FFFFFF', dark ? 0.2 : 0.65),
    base,
    mix(base, '#000000', dark ? 0.25 : 0.14),
    mix(base, '#FFFFFF', dark ? 0.1 : 0.35),
  ];
}

/** Converts #RRGGBB plus opacity to CSS rgba(...) format. */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Maps custom card color roles to colors for this mode (D-624). colors is the card's palette,
 * page is the page's palette: text uses page text color (like new brutalist borders and hard
 * shadows), border and shadow use the card palette's divider and shadow colors.
 */
export function cardRoleColors(
  colors: ResolvedColors,
  page: ResolvedColors,
): Record<CardColorRole, string> {
  return {
    text: page.text,
    primary: colors.primary,
    secondary: colors.secondary,
    tertiary: colors.tertiary,
    border: colors.border,
    shadow: colors.shadow,
    white: '#FFFFFF',
    black: '#000000',
  };
}

/** Custom card borders and shadows (D-624): overlaid by the renderer on top of cardStyle's background color. */
export interface CardParts {
  borderWidth?: number;
  borderColor?: string;
  /** CSS box-shadow, multiple layers joined by commas. */
  boxShadow?: string;
}

export function customCardParts(
  card: ThemeCard,
  color: (role: CardColorRole) => string,
): CardParts {
  const parts: CardParts = {};
  if (card.border) {
    parts.borderWidth = card.border.width;
    parts.borderColor = rgba(color(card.border.color), card.border.opacity ?? 1);
  }
  if (card.shadows) {
    parts.boxShadow = card.shadows
      .map(
        (s) =>
          `${s.inset ? 'inset ' : ''}${s.x}px ${s.y}px ${s.blur}px ${rgba(color(s.color), s.opacity ?? 1)}`,
      )
      .join(', ');
  }
  return parts;
}

export const MIN_TEXT_CONTRAST = 4.5;

/** Colors that body text may sit directly on and their corresponding text color: uses text for page backgrounds, and surfaceText for cards (including frosted glass and metallic). */
function textSurfaces(theme: Theme, c: ResolvedColors, card: ResolvedColors | undefined) {
  const surface = card?.surface ?? c.surface;
  const onCard = card ? { name: 'surfaceText', color: card.text } : { name: 'text', color: c.text };
  const onPage = { name: 'text', color: c.text };
  const surfaces: [string, string, { name: string; color: string }][] = [
    ['background', c.background, onPage],
    ['surface', surface, onCard],
  ];
  const stops = backdropStops(theme, c);
  if (theme.backdrop && theme.backdrop !== 'plain') {
    stops.forEach((color, i) => surfaces.push([`backdrop color ${i + 1}`, color, onPage]));
  }
  if (theme.cardStyle === 'glass') {
    stops.forEach((color, i) =>
      surfaces.push([
        `glass card over backdrop color ${i + 1}`,
        mix(color, surface, GLASS_OPACITY),
        onCard,
      ]),
    );
  }
  if (theme.cardStyle === 'chrome') {
    chromeStops(surface, c.dark).forEach((color, i) =>
      surfaces.push([`chrome card shade ${i + 1}`, color, onCard]),
    );
  }
  return surfaces;
}

/**
 * Readability check: text on backgrounds and text on cards (including actual colors for gradient,
 * frosted glass, and metallic cards) must achieve WCAG AA contrast. When surfaceText is
 * specified, cards use it, while text applies only to pages (D-409). Returns failing
 * combinations; checks both if a theme can be rendered as light or dark.
 */
export function contrastProblems(theme: Theme): string[] {
  const modes = theme.mode === 'system' ? [false, true] : [theme.mode === 'dark'];
  const problems: string[] = [];
  for (const dark of modes) {
    const c = resolveColors(theme, dark);
    for (const [name, bg, ink] of textSurfaces(theme, c, resolveSurfaceColors(theme, dark))) {
      const ratio = contrast(ink.color, bg);
      if (ratio < MIN_TEXT_CONTRAST) {
        problems.push(
          `${ink.name} ${ink.color} on ${name} ${bg} has contrast ${ratio.toFixed(1)} (needs ${MIN_TEXT_CONTRAST}) in ${dark ? 'dark' : 'light'} mode`,
        );
      }
    }
  }
  return problems;
}

/**
 * Image backgrounds (D-258): the overlay uses the original card (or page) background color, with
 * an opacity over the image of at least this value, increased further (overlayOpacity) if text is
 * insufficiently legible.
 */
export const OVERLAY_OPACITY: Record<Backdrop['overlay'], number> = {
  light: 0.5,
  medium: 0.7,
  strong: 0.85,
};

/**
 * Minimum contrast of text when an overlay of opacity opacity is placed over any image: every
 * image channel lies between black and white, so the color with the overlay applied lies between
 * 'overlay on pure black' and 'overlay on pure white', with the worst case at the extremes;
 * evaluates to 1 when text luminance falls in the middle.
 */
export function overlayContrast(text: string, overlay: string, opacity: number): number {
  const darkest = mix('#000000', overlay, opacity);
  const lightest = mix('#FFFFFF', overlay, opacity);
  const l = luminance(text);
  if (l > luminance(darkest) && l < luminance(lightest)) return 1;
  return Math.min(contrast(text, darkest), contrast(text, lightest));
}

/**
 * Actual overlay opacity used: starts from the chosen shade and gradually increases until text
 * passes MIN_TEXT_CONTRAST regardless of the image (cases failing even on pure solid backgrounds
 * are not made worse than on solid backgrounds). Text on images always uses the body text color
 * (app's onPicture), so only body text is calculated; muted text requires near-opaque overlays to
 * be legible.
 */
export function overlayOpacity(level: Backdrop['overlay'], overlay: string, text: string): number {
  const need = Math.min(MIN_TEXT_CONTRAST, contrast(text, overlay) - 0.01);
  for (let step = Math.round(OVERLAY_OPACITY[level] * 100); step < 100; step++) {
    if (overlayContrast(text, overlay, step / 100) >= need) return step / 100;
  }
  return 1;
}
