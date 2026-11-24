import { overlayOpacity, type Backdrop } from '@morph/core';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useWorkspaceContext } from '../workspace/context';
import type { Palette } from './theme';

// Maximum side length to scale to when selecting a backdrop image: cards don't need to be too
// large, entire pages must fill the screen.

/** Maximum side length to scale to when selecting a backdrop image: cards don't need to be too large, entire pages must fill the screen. */
export const BACKDROP_SIDE = { card: 1200, page: 2048 } as const;

/** Color scheme when backdrop image is present: gray text, captions, primary color text, prompt box text all switched to body text color (mask only guarantees body text contrast). */
export function onPicture(palette: Palette, backdrop: Backdrop | undefined): Palette {
  if (!backdrop?.assetId) return palette;
  const { text } = palette;
  const shown: Palette = {
    ...palette,
    muted: text,
    subtext: text,
    caption: text,
    primaryText: text,
    onSecondaryTint: text,
    onTertiaryTint: text,
  };
  // When cards have their own text color (D-409), cards on image pages are similarly updated.
  if (palette.surfacePalette) {
    shown.surfacePalette = { ...onPicture(palette.surfacePalette, backdrop), pagePalette: shown };
  }
  return shown;
}

/** Display URI for user files. undefined: loading or none; null: file not on this device. */
export function useAssetUri(assetId: string | undefined): string | null | undefined {
  const { repo, files } = useWorkspaceContext();
  const [loaded, setLoaded] = useState<{ id: string; uri: string | null } | null>(null);
  useEffect(() => {
    if (!assetId) return;
    let alive = true;
    void repo
      .getAsset(assetId)
      .then((a) => alive && setLoaded({ id: assetId, uri: a ? files.fileUri(a.path) : null }));
    return () => {
      alive = false;
    };
  }, [repo, files, assetId]);
  return assetId && loaded?.id === assetId ? loaded.uri : undefined;
}

/**
 * Image and mask filling parent view (parent view needs overflow: hidden and border radius set).
 * color is opaque background color: translucent frosted glass cards have translucent backgrounds,
 * mask uses its opaque color counterpart. Draws nothing if no image or image not on this device.
 */
export function BackdropFill({
  backdrop,
  color,
  palette,
  radius = 0,
}: {
  backdrop: Backdrop;
  color: string;
  palette: Palette;
  /** Card border radius: image clips its own corners, card does not set overflow (which would clip shadows on iOS). */
  radius?: number;
}) {
  const uri = useAssetUri(backdrop.assetId);
  if (!uri) return null;
  return (
    <View
      pointerEvents="none"
      testID="backdrop-picture"
      style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
      <Image
        source={{ uri }}
        contentFit="cover"
        // Decode to display dimensions (Android default behavior, explicitly stated here).
        allowDownscaling
        style={StyleSheet.absoluteFill}
        accessible={false}
      />
      <View
        testID="backdrop-overlay"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: color,
            opacity: overlayOpacity(backdrop.overlay, color, palette.text),
          },
        ]}
      />
    </View>
  );
}
