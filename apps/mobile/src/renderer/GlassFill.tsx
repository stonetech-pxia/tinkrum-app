import { BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Platform, StyleSheet } from 'react-native';

import type { Palette } from './theme';

// Glass layer for frosted glass cards, laid underneath card content (D-092). Uses system Liquid
// Glass from iOS 26 onwards; BlurView for earlier iOS versions. Android's BlurView requires
// wrapping background content in a BlurTargetView to actually blur, but cards are inside scrolling
// content with the background behind them, which cannot be wrapped; therefore, Android only
// displays a semi-translucent card (the background color in cardStyle).

let liquid: boolean | undefined;
function liquidGlass(): boolean {
  if (liquid === undefined) {
    try {
      liquid = Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
    } catch {
      liquid = false;
    }
  }
  return liquid;
}

export function GlassFill({ palette, radius }: { palette: Palette; radius?: number }) {
  if (!palette.glass || Platform.OS === 'android') return null;
  const style = [StyleSheet.absoluteFill, { borderRadius: radius ?? palette.radius }];
  if (liquidGlass()) {
    return (
      <GlassView
        pointerEvents="none"
        style={style}
        glassEffectStyle="regular"
        colorScheme={palette.dark ? 'dark' : 'light'}
      />
    );
  }
  return (
    <BlurView
      pointerEvents="none"
      style={[style, { overflow: 'hidden' }]}
      intensity={40}
      tint={palette.dark ? 'dark' : 'light'}
    />
  );
}
