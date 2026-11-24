import type { IconValue } from '@morph/core';
import { Image, Pressable, StyleSheet, type ImageSourcePropType } from 'react-native';

import { Icon } from './Icon';
import type { Palette } from './theme';

/** Line art used for home screen icon buttons (D-449): monochrome PNG, tinted by theme (same as Tink's hammer). */
const GLYPHS = {
  scan: require('../../assets/images/scan-outline.png') as ImageSourcePropType,
  folderOpen: require('../../assets/images/folder-open-outline.png') as ImageSourcePropType,
};
export type IconButtonGlyph = keyof typeof GLYPHS;

/** Configured icon names replaced with line art on such buttons: scan uses a scan frame. */
const GLYPH_OF: Partial<Record<string, IconButtonGlyph>> = { scan: 'scan' };

/**
 * Square buttons with icons only (D-449): "Scan", "Open file" on new user home screen. Shares the
 * same icon background shape as settings page (three large rounded corners, small bottom-left
 * corner rounded, scaling with theme corner radius), white background, primary-colored line
 * icons; slightly smaller than grid cells: edge columns hug page margins (aligned with cards and
 * titles below, D-454), with spacing between buttons. Text is hidden, but screen readers read the
 * label.
 */
export function IconButton({
  palette,
  icon,
  glyph,
  label,
  onPress,
  onLongPress,
  disabled,
  testID,
  column,
}: {
  palette: Palette;
  /** Icon name in config; uses line art if glyph is provided. */
  icon: IconValue;
  glyph?: IconButtonGlyph;
  label: string;
  onPress?: (() => void) | undefined;
  onLongPress?: (() => void) | undefined;
  disabled?: boolean;
  testID: string;
  /** Column index in grid: left-aligned for first column, right-aligned for last column, centered for middle columns. */
  column?: { index: number; of: number } | undefined;
}) {
  const shown = glyph ?? (typeof icon === 'string' ? GLYPH_OF[icon] : undefined);
  const scale = palette.radius / 22;
  const round = Math.round(30 * scale);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          alignSelf: !column
            ? 'center'
            : column.index === 0
              ? 'flex-start'
              : column.index === column.of - 1
                ? 'flex-end'
                : 'center',
          backgroundColor: palette.surface,
          boxShadow: `0px 2px 10px ${palette.shadow}1F`,
          borderTopLeftRadius: round,
          borderTopRightRadius: round,
          borderBottomRightRadius: round,
          borderBottomLeftRadius: Math.round(11 * scale),
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
        pressed && styles.pressed,
      ]}>
      {shown ? (
        <Image
          source={GLYPHS[shown]}
          style={{ width: 46, height: 46, tintColor: palette.primaryText }}
        />
      ) : (
        <Icon name={icon} size={46} color={palette.primaryText} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: '86%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { transform: [{ scale: 0.97 }] },
});
