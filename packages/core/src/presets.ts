import { localize } from './localization';
import { t } from './messages';
import type { Locale, Localized, Theme } from './schema';

// Built-in theme presets (D-094): each is a complete theme, applied as a set by the AI using
// applyThemePreset, with further fine-tuning allowed afterwards. Except for fixed dark terminal and
// neon, all include both light and dark color schemes, switching automatically with the system; all
// pass contrast checks (covered by tests).

export const THEME_PRESET_IDS = [
  'ios',
  'material',
  'editorial',
  'pastel',
  'nature',
  'terminal',
  'neon',
  'claymorphism',
  'brutalist',
  'neumorphism',
  'glass',
  'y2k',
] as const;
export type ThemePresetId = (typeof THEME_PRESET_IDS)[number];

export interface ThemePreset {
  name: Localized;
  /** A one-sentence description for the model. */
  description: string;
  /** What the user calls this style in prompt rule 11 (English, multiple terms separated by slashes). */
  said: string;
  /**
   * Recognized names by built-in rules (compared case-insensitively). Only recognizes overall
   * styles; changes like "change cards to new brutalism" only modify cards (mock cardStyleRule).
   * French names are not needed: French sentences in the style selector are recognized via
   * name.fr (D-234).
   */
  aliases: readonly string[];
  theme: Theme;
}

export const THEME_PRESETS: Record<ThemePresetId, ThemePreset> = {
  ios: {
    name: { zh: 'iOS 原生', en: 'iOS', fr: 'iOS natif' },
    description: 'Apple system look: grouped gray background, white cards, system blue',
    said: 'iOS style',
    aliases: ['ios', 'ios原生', 'ios 原生', '苹果', '苹果原生', 'apple'],
    theme: {
      primaryColor: '#007AFF',
      mode: 'system',
      colors: {
        background: '#F2F2F7',
        surface: '#FFFFFF',
        text: '#000000',
        secondary: '#34C759',
        tertiary: '#FF9500',
      },
      darkColors: {
        background: '#000000',
        surface: '#1C1C1E',
        text: '#FFFFFF',
        secondary: '#30D158',
        tertiary: '#FF9F0A',
      },
      font: 'system',
      fontScale: 1,
      radius: 12,
      density: 'comfortable',
      cardStyle: 'flat',
      navStyle: 'iconLabel',
    },
  },
  material: {
    name: { zh: 'Material You', en: 'Material You', fr: 'Material You' },
    description: 'Google Material 3: tonal purple surfaces, large rounded cards',
    said: 'Material',
    aliases: ['material', 'material you', 'material design', '安卓', '谷歌'],
    theme: {
      primaryColor: '#6750A4',
      mode: 'system',
      colors: {
        background: '#FEF7FF',
        surface: '#F3EDF7',
        text: '#1D1B20',
        secondary: '#625B71',
        tertiary: '#7D5260',
      },
      darkColors: {
        background: '#141218',
        surface: '#211F26',
        text: '#E6E0E9',
        secondary: '#CCC2DC',
        tertiary: '#EFB8C8',
      },
      font: 'system',
      fontScale: 1,
      radius: 24,
      density: 'comfortable',
      cardStyle: 'flat',
      navStyle: 'iconLabel',
    },
  },
  editorial: {
    name: { zh: '杂志', en: 'Editorial', fr: 'Magazine' },
    description: 'Magazine layout: serif type, paper background, hairline borders, red accent',
    said: 'magazine',
    aliases: ['杂志', '报刊', '编辑', 'editorial', 'magazine'],
    theme: {
      primaryColor: '#B3261E',
      mode: 'system',
      colors: {
        background: '#FAF7F0',
        surface: '#FFFDF8',
        text: '#1A1A1A',
        secondary: '#2F4A3A',
        tertiary: '#8A6D3B',
      },
      darkColors: {
        background: '#121110',
        surface: '#1C1A18',
        text: '#F2EEE6',
        secondary: '#9DB8A6',
        tertiary: '#C9A56B',
      },
      font: 'serif',
      fontScale: 1.1,
      radius: 2,
      density: 'spacious',
      cardStyle: 'outline',
      navStyle: 'label',
    },
  },
  pastel: {
    name: { zh: '马卡龙', en: 'Pastel', fr: 'Pastel' },
    description: 'Soft wellness look: peach background, coral and mint, very round cards',
    said: 'pastel',
    aliases: ['马卡龙', '粉彩', '柔和', 'pastel'],
    theme: {
      primaryColor: '#F0794F',
      mode: 'system',
      colors: {
        background: '#FFF4EC',
        surface: '#FFFFFF',
        text: '#3D2C29',
        secondary: '#4FA382',
        tertiary: '#7C9BE0',
      },
      darkColors: {
        background: '#221A18',
        surface: '#2E2421',
        text: '#FBEDE6',
        secondary: '#8FD3B4',
        tertiary: '#A9C2F5',
      },
      font: 'clay',
      fontScale: 1,
      radius: 26,
      density: 'spacious',
      cardStyle: 'shadow',
      navStyle: 'iconLabel',
    },
  },
  nature: {
    name: { zh: '自然', en: 'Nature', fr: 'Nature' },
    description: 'Earthy biophilic look: fern green, sienna and ochre over a soft gradient',
    said: 'nature',
    aliases: ['自然', '大地', '森林', 'nature', 'earthy'],
    theme: {
      primaryColor: '#4F7942',
      mode: 'system',
      colors: {
        background: '#F1EEE4',
        surface: '#FBF9F3',
        text: '#2B2A22',
        secondary: '#A0522D',
        tertiary: '#B8901F',
      },
      darkColors: {
        background: '#161A14',
        surface: '#20261D',
        text: '#EEF0E6',
        secondary: '#D08A5E',
        tertiary: '#DDBB55',
      },
      font: 'clay',
      fontScale: 1,
      radius: 18,
      density: 'comfortable',
      cardStyle: 'shadow',
      navStyle: 'iconLabel',
      backdrop: 'gradient',
    },
  },
  terminal: {
    name: { zh: '终端', en: 'Terminal', fr: 'Terminal' },
    description: 'Developer terminal: always dark, monospace, compact, green accent, outlined',
    said: 'terminal / hacker',
    aliases: ['终端', '极客', '程序员', '代码', 'terminal', 'hacker'],
    theme: {
      primaryColor: '#22C55E',
      mode: 'dark',
      colors: {
        background: '#0B0F0C',
        surface: '#111813',
        text: '#D1FAE5',
        secondary: '#38BDF8',
        tertiary: '#FACC15',
      },
      font: 'mono',
      fontScale: 0.95,
      radius: 4,
      density: 'compact',
      cardStyle: 'outline',
      navStyle: 'label',
    },
  },
  neon: {
    name: { zh: '赛博霓虹', en: 'Neon', fr: 'Néon cyberpunk' },
    description: 'Cyberpunk: always dark, aurora glow background, cyan neon-glowing cards',
    said: 'neon / cyberpunk',
    aliases: ['霓虹', '赛博', '赛博朋克', '赛博霓虹', 'neon', 'cyberpunk'],
    theme: {
      primaryColor: '#22D3EE',
      mode: 'dark',
      colors: {
        background: '#05050A',
        surface: '#111122',
        text: '#EDEBFF',
        secondary: '#F472B6',
        tertiary: '#8B5CF6',
      },
      font: 'system',
      fontScale: 1,
      radius: 16,
      density: 'comfortable',
      cardStyle: 'glow',
      navStyle: 'iconLabel',
      backdrop: 'aurora',
    },
  },
  claymorphism: {
    name: { zh: '黏土', en: 'Claymorphism', fr: 'Claymorphisme' },
    description: 'Playful 3D clay: lavender pastels, puffy cards with an inner highlight',
    said: 'claymorphism',
    aliases: ['黏土', '粘土', 'claymorphism', 'claymorphic'],
    theme: {
      primaryColor: '#8B5CF6',
      mode: 'system',
      colors: {
        background: '#F3EEFF',
        surface: '#FBF8FF',
        text: '#2E1065',
        secondary: '#DB2777',
        tertiary: '#0F9488',
      },
      darkColors: {
        background: '#1A1033',
        surface: '#261A45',
        text: '#F3EEFF',
        secondary: '#F472B6',
        tertiary: '#2DD4BF',
      },
      font: 'clay',
      fontScale: 1.05,
      radius: 28,
      density: 'spacious',
      cardStyle: 'puffy',
      navStyle: 'iconLabel',
    },
  },
  brutalist: {
    name: { zh: '新粗野', en: 'Neubrutalism', fr: 'Neubrutalisme' },
    description: 'Neubrutalism: cream background, thick outlines, hard offset shadows, loud colors',
    said: 'neubrutalism',
    aliases: ['新粗野', '粗野', '野兽派', 'brutalist', 'neubrutalism', 'neubrutalist'],
    theme: {
      primaryColor: '#FF5C39',
      mode: 'system',
      colors: {
        background: '#FFF4D6',
        surface: '#FFFFFF',
        text: '#111111',
        secondary: '#2563EB',
        tertiary: '#16A34A',
      },
      darkColors: {
        background: '#141414',
        surface: '#1F1F1F',
        text: '#FFF4D6',
        secondary: '#60A5FA',
        tertiary: '#4ADE80',
      },
      font: 'system',
      fontScale: 1.05,
      radius: 6,
      density: 'comfortable',
      cardStyle: 'brutal',
      navStyle: 'iconLabel',
    },
  },
  neumorphism: {
    name: { zh: '新拟物', en: 'Neumorphism', fr: 'Neumorphisme' },
    description:
      'Soft UI: cards the same color as the background, raised by light and dark shadows',
    said: 'neumorphism',
    aliases: ['新拟物', '拟物', 'neumorphism', 'neumorphic', 'soft ui'],
    theme: {
      primaryColor: '#5B6CFF',
      mode: 'system',
      colors: {
        background: '#E4E9F2',
        surface: '#E4E9F2',
        text: '#2D3748',
        secondary: '#2F855A',
        tertiary: '#C05621',
      },
      darkColors: {
        background: '#2A2D34',
        surface: '#2A2D34',
        text: '#E2E8F0',
        secondary: '#68D391',
        tertiary: '#F6AD55',
      },
      font: 'system',
      fontScale: 1,
      radius: 22,
      density: 'spacious',
      cardStyle: 'soft',
      navStyle: 'iconLabel',
    },
  },
  glass: {
    name: { zh: '液态玻璃', en: 'Liquid Glass', fr: 'Verre liquide' },
    description:
      'Glassmorphism / Liquid Glass: aurora background behind translucent frosted-glass cards',
    said: 'glassmorphism / liquid glass',
    aliases: [
      '毛玻璃',
      '玻璃',
      '液态玻璃',
      'liquid glass',
      'glass',
      'glassmorphism',
      'frosted glass',
    ],
    theme: {
      primaryColor: '#6366F1',
      mode: 'system',
      colors: {
        background: '#F5F3FF',
        surface: '#FFFFFF',
        text: '#1E1B4B',
        secondary: '#EC4899',
        tertiary: '#06B6D4',
      },
      darkColors: {
        background: '#0B0B1A',
        surface: '#1E1B3A',
        text: '#EEF2FF',
        secondary: '#F472B6',
        tertiary: '#22D3EE',
      },
      font: 'system',
      fontScale: 1,
      radius: 24,
      density: 'comfortable',
      cardStyle: 'glass',
      navStyle: 'iconLabel',
      backdrop: 'aurora',
    },
  },
  y2k: {
    name: { zh: 'Y2K 千禧', en: 'Y2K', fr: 'Y2K' },
    description:
      'Y2K chrome: pink-to-blue gradient background, glossy metallic cards, hot pink accent',
    said: 'Y2K / chrome',
    aliases: ['y2k', 'y2k 千禧', '千禧', '千禧年', '金属', 'chrome'],
    theme: {
      primaryColor: '#FF3EA5',
      mode: 'system',
      colors: {
        background: '#EEF2FF',
        surface: '#D9DEE5',
        text: '#111827',
        secondary: '#3B82F6',
        tertiary: '#A855F7',
      },
      darkColors: {
        background: '#0F1020',
        surface: '#3A3F4B',
        text: '#F1F5F9',
        secondary: '#60A5FA',
        tertiary: '#C084FC',
      },
      font: 'system',
      fontScale: 1,
      radius: 14,
      density: 'comfortable',
      cardStyle: 'chrome',
      navStyle: 'iconLabel',
      backdrop: 'gradient',
    },
  },
};

/** Structural equality is sufficient (key order of validated objects may change); keys with undefined values are treated as absent. */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a === b;
  const keys = (o: object) =>
    Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined);
  const ka = keys(a);
  return (
    ka.length === keys(b).length &&
    ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/** Returns the preset id if the current theme remains completely identical to a preset (used by style selector to highlight current style); no longer considered a preset if fine-tuned. */
export function presetOfTheme(theme: Theme): ThemePresetId | null {
  return THEME_PRESET_IDS.find((id) => sameValue(theme, THEME_PRESETS[id].theme)) ?? null;
}

/** A phrase inserted into the input box by the style selector (D-095); mock AI recognizes it as the corresponding applyThemePreset (tested across all presets). */
export function presetRequest(id: ThemePresetId, locale: Locale): string {
  const name = localize(THEME_PRESETS[id].name, locale);
  return t(locale, 'presets_Switch_to_the_style_aedda', { v0: name });
}
