import {
  AURORA_ALPHA,
  GLASS_OPACITY,
  backdropStops,
  cardRoleColors,
  chromeStops,
  customCardParts,
  isDark,
  mix,
  onAccent,
  resolveColors,
  resolveSurfaceColors,
  rgba,
  type ComponentStyle,
  type ResolvedColors,
  type Theme,
} from '@morph/core';
import { Platform, useColorScheme, type TextStyle, type ViewStyle } from 'react-native';

// Theme tokens → colors, fonts, and dimensions for rendering. Color calculations are performed in
// core (also used by the validator); platform-specific parts are added here. The default style Clay
// comes from Docudis: Sora title, Karla body, 22pt border radius, warm soft shadows.

export type FontRole = 'display' | 'heading' | 'title' | 'body' | 'bodyMedium' | 'bodyBold';

/** Clay fonts registered individually by font weight (static fonts from expo-google-fonts), avoiding overlapping fontWeight. */
export const CLAY_FONTS: Record<FontRole, string> = {
  display: 'Sora_700Bold',
  heading: 'Sora_700Bold',
  title: 'Sora_600SemiBold',
  body: 'Karla_400Regular',
  bodyMedium: 'Karla_500Medium',
  bodyBold: 'Karla_700Bold',
};

/**
 * Inter (D-591): a separate static font for each weight. Display (numbers, large headings) uses
 * medium 500 instead of bold; headings use 600, body 400, body medium 500, and body bold 700.
 */
export const INTER_FONTS: Record<FontRole, string> = {
  display: 'Inter_500Medium',
  heading: 'Inter_600SemiBold',
  title: 'Inter_600SemiBold',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodyBold: 'Inter_700Bold',
};

const WEIGHTS: Record<FontRole, TextStyle['fontWeight']> = {
  display: '700',
  heading: '700',
  title: '600',
  body: '400',
  bodyMedium: '500',
  bodyBold: '700',
};

const SERIF = Platform.select({ ios: 'Georgia', default: 'serif' });
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

export interface Palette extends ResolvedColors {
  /** Legacy name, equivalent to surface / muted. */
  card: string;
  /** Readable text on solid accent backgrounds. */
  onAccent: typeof onAccent;
  subtext: string;
  theme: Theme;
  radius: number;
  /** Border radius for controls such as buttons and input fields. */
  controlRadius: number;
  /**
   * Page margins and component spacing. Pages have only two vertical alignment lines (D-454): the
   * edges of boxes (cards, buttons, input fields, lists) align with pad outside the boxes, while
   * content inside boxes is indented by inset (card padding).
   */
  pad: number;
  inset: number;
  gap: number;
  /** Font for a specific role, where size is multiplied by the theme's font scale ratio. */
  font(role: FontRole, size: number): TextStyle;
  /** Card background color, border, and shadow. */
  cardStyle(background?: string): ViewStyle;
  /** Glassmorphism card: requires an additional GlassFill layer inside the card. */
  glass: boolean;
  /** Theme specifies gradient / aurora page background. */
  hasBackdrop: boolean;
  /** Background of the page root container (base color + gradient). */
  backdrop: ViewStyle;
  /** Background color of the bottom navigation bar (semi-transparent under glassmorphism themes). */
  barBackground: string;
  /** Present only when the theme sets surfaceText (D-409): color scheme used for content placed on cards. Access via onSurface. */
  surfacePalette?: Palette;
  /** Present only on card color schemes: color scheme reverting to the page background. Access via onPage. */
  pagePalette?: Palette;
}

/** Color scheme used for content placed on cards (D-409); defaults to itself when surfaceText is not set. */
export const onSurface = (palette: Palette): Palette => palette.surfacePalette ?? palette;

/** Color scheme used for content placed on page backgrounds (D-409); blocks are rendered in card color schemes, and block titles overlaid on the page must switch back. */
export const onPage = (palette: Palette): Palette => palette.pagePalette ?? palette;

const DENSITY = {
  compact: { pad: 14, gap: 8 },
  comfortable: { pad: 20, gap: 14 },
  spacious: { pad: 24, gap: 20 },
} as const;

/** CSS gradient for page background (RN backgroundImage); color stops and validator share the same set of colors. */
function backdropImage(theme: Theme, c: ResolvedColors): string | undefined {
  const stops = backdropStops(theme, c);
  if (theme.backdrop === 'gradient') {
    return `linear-gradient(170deg, ${stops[0]} 0%, ${stops[1]} 55%, ${stops[2]} 100%)`;
  }
  if (theme.backdrop === 'aurora') {
    // Three light sources: primary color in top-left, secondary color on the right, third color at the bottom; edges fade out to fully transparent of the same color to avoid grayish tones.
    const alpha = c.dark ? AURORA_ALPHA.dark : AURORA_ALPHA.light;
    const blob = (color: string, at: string, size: number) =>
      `radial-gradient(circle at ${at}, ${rgba(color, alpha)} 0%, ${rgba(color, 0)} ${size}%)`;
    return [
      blob(c.primary, '12% 8%', 60),
      blob(c.secondary, '95% 35%', 55),
      blob(c.tertiary, '35% 100%', 65),
    ].join(', ');
  }
  return undefined;
}

/** Metallic card gradient: bright top, dark bottom, middle transitions from bright to dark. */
const chromeImage = (top: string, mid: string, low: string, bottom: string) =>
  `linear-gradient(180deg, ${top} 0%, ${mid} 42%, ${low} 60%, ${bottom} 100%)`;

export function makePalette(theme: Theme, systemDark: boolean): Palette {
  const dark = isDark(theme, systemDark);
  const page = resolveColors(theme, dark);
  const palette = buildPalette(theme, page, page);
  const card = resolveSurfaceColors(theme, dark);
  if (card) palette.surfacePalette = { ...buildPalette(theme, card, page), pagePalette: palette };
  return palette;
}

/** colors represents the colors for this palette; page represents the page background palette, which governs hard shadows of cards on the page background, neumorphic highlights, and page background. */
function buildPalette(theme: Theme, colors: ResolvedColors, page: ResolvedColors): Palette {
  const radius = theme.radius;
  const image = backdropImage(theme, page);
  const family = (role: FontRole): TextStyle => {
    switch (theme.font) {
      case 'clay':
        return { fontFamily: CLAY_FONTS[role] };
      case 'serif':
        return { fontFamily: SERIF, fontWeight: WEIGHTS[role] };
      case 'mono':
        return { fontFamily: MONO, fontWeight: WEIGHTS[role] };
      case 'system':
        return { fontWeight: WEIGHTS[role] };
      case 'inter':
        return { fontFamily: INTER_FONTS[role] };
    }
  };
  return {
    ...colors,
    onAccent,
    card: colors.surface,
    subtext: colors.muted,
    theme,
    radius,
    controlRadius: Math.round(Math.min(radius, 16) * 0.9 + (radius > 0 ? 2 : 0)),
    ...DENSITY[theme.density],
    inset: DENSITY[theme.density].pad - 2,
    glass: theme.cardStyle === 'glass',
    hasBackdrop: image !== undefined,
    barBackground:
      theme.cardStyle === 'glass' ? rgba(colors.surface, GLASS_OPACITY) : colors.surface,
    backdrop: image
      ? { backgroundColor: page.background, backgroundImage: image }
      : { backgroundColor: page.background },
    font: (role, size) => ({ ...family(role), fontSize: Math.round(size * theme.fontScale) }),
    cardStyle: (background = colors.surface) => {
      const base: ViewStyle = { backgroundColor: background, borderRadius: radius };
      if (theme.card) {
        // Custom borders and shadows (D-624): base color follows cardStyle (semi-transparent
        // background for glassmorphic, gradient for metallic), while borders and shadows are
        // entirely replaced by parameters.
        const roles = cardRoleColors(colors, page);
        const parts = customCardParts(theme.card, (role) => roles[role]);
        if (theme.cardStyle === 'glass')
          return {
            ...base,
            backgroundColor: rgba(background, GLASS_OPACITY),
            overflow: 'hidden',
            ...parts,
          };
        if (theme.cardStyle === 'chrome') {
          const [top, mid, low, bottom] = chromeStops(background, colors.dark);
          return {
            ...base,
            backgroundImage: chromeImage(top, mid, low, bottom),
            ...parts,
          };
        }
        return { ...base, ...parts };
      }
      if (theme.cardStyle === 'outline')
        return { ...base, borderWidth: 1, borderColor: colors.border };
      if (theme.cardStyle === 'flat') return base;
      // The following three use boxShadow (provided by the new architecture): legacy shadow* properties cannot produce hard shadows, multi-layer shadows, or inner shadows.
      if (theme.cardStyle === 'brutal') {
        return {
          ...base,
          borderWidth: 2,
          borderColor: page.text,
          boxShadow: `4px 4px 0px ${page.text}`,
        };
      }
      if (theme.cardStyle === 'soft') {
        // Neumorphism: light top-left, dark bottom-right, most closely resembling the background when cards and background share the same color.
        const light = colors.dark ? rgba('#FFFFFF', 0.06) : mix(page.background, '#FFFFFF', 0.8);
        const dark = rgba(colors.dark ? '#000000' : colors.shadow, colors.dark ? 0.6 : 0.16);
        return { ...base, boxShadow: `-5px -5px 12px ${light}, 6px 6px 14px ${dark}` };
      }
      if (theme.cardStyle === 'glass') {
        // Semi-transparent background color + thin bright border; blur is provided by GlassFill inside the card (native glass on iOS 26, otherwise BlurView).
        return {
          ...base,
          backgroundColor: rgba(background, GLASS_OPACITY),
          borderWidth: 1,
          borderColor: rgba('#FFFFFF', colors.dark ? 0.16 : 0.6),
          overflow: 'hidden',
        };
      }
      if (theme.cardStyle === 'glow') {
        return {
          ...base,
          borderWidth: 1,
          borderColor: rgba(colors.primary, 0.7),
          boxShadow: `0px 0px 18px ${rgba(colors.primary, colors.dark ? 0.6 : 0.35)}`,
        };
      }
      if (theme.cardStyle === 'chrome') {
        // Metal: bright top, dark bottom, middle transitions from bright to dark, with a highlight along the top edge.
        const [top, mid, low, bottom] = chromeStops(background, colors.dark);
        return {
          ...base,
          backgroundImage: chromeImage(top, mid, low, bottom),
          borderWidth: 1,
          borderColor: mix(background, '#000000', colors.dark ? 0.45 : 0.3),
          boxShadow: [
            `inset 0px 1px 0px ${rgba('#FFFFFF', colors.dark ? 0.25 : 0.9)}`,
            `0px 4px 10px ${rgba(colors.dark ? '#000000' : colors.shadow, colors.dark ? 0.5 : 0.2)}`,
          ].join(', '),
        };
      }
      if (theme.cardStyle === 'puffy') {
        // Clay: A soft shadow on the outside, and an inner shadow with a bright top and dark bottom on the inside, making the card look puffed up.
        return {
          ...base,
          boxShadow: [
            `0px 12px 24px ${rgba(colors.shadow, colors.dark ? 0.45 : 0.16)}`,
            `inset 0px 6px 10px ${rgba('#FFFFFF', colors.dark ? 0.08 : 0.7)}`,
            `inset 0px -6px 12px ${rgba('#000000', colors.dark ? 0.3 : 0.08)}`,
          ].join(', '),
        };
      }
      return {
        ...base,
        shadowColor: colors.shadow,
        shadowOpacity: colors.dark ? 0.35 : 0.1,
        shadowRadius: 15,
        shadowOffset: { width: 0, height: 10 },
        elevation: 3,
      };
    },
  };
}

export function usePalette(theme: Theme): Palette {
  return makePalette(theme, useColorScheme() === 'dark');
}

/** The tone of card components is the background color; icon blocks use an accent color from the same family. */
export function cardColors(palette: Palette, tone: ComponentStyle['tone']) {
  switch (tone) {
    case 'primary':
      return { background: palette.primaryTint, accent: palette.primary, on: palette.onPrimary };
    case 'secondary':
      return { background: palette.secondaryTint, accent: palette.secondary, on: '#FFFFFF' };
    case 'tertiary':
      return { background: palette.tertiaryTint, accent: palette.tertiary, on: '#FFFFFF' };
    case 'muted':
      return { background: palette.background, accent: palette.caption, on: palette.surface };
    default:
      return { background: palette.surface, accent: palette.primary, on: palette.onPrimary };
  }
}

/**
 * Icon block color (D-230): When the theme specifies iconStyle, all icon blocks follow it;
 * otherwise, they use the component's own default. solid = solid background, white icon; tint =
 * light background, colored icon (uses the accent color of the card family when the card itself
 * has a background).
 */
export function iconColors(
  palette: Palette,
  fallback: 'solid' | 'tint',
  tone?: ComponentStyle['tone'],
) {
  const colors = cardColors(palette, tone);
  if ((palette.theme.iconStyle ?? fallback) === 'solid') {
    return { background: colors.accent, color: colors.on };
  }
  return !tone || tone === 'default'
    ? { background: palette.primaryTint, color: palette.primaryText }
    : { background: palette.surface, color: colors.accent };
}
