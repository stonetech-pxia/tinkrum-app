import {
  localize,
  THEME_PRESETS,
  THEME_PRESET_IDS,
  type Locale,
  type ThemePresetId,
} from '@morph/core';

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { GlassFill } from '../renderer/GlassFill';
import { Icon } from '../renderer/Icon';
import { usePalette, type Palette } from '../renderer/theme';

// Style picker (D-095): directly tap and select built-in style presets on the AI modification page without typing. Each cell is a thumbnail sample of the style, adapting to system light/dark mode.

function Swatch({
  id,
  locale,
  current,
  palette,
  onPress,
}: {
  id: ThemePresetId;
  locale: Locale;
  current: boolean;
  /** Palette of the modification page itself, used for the name and selection box. */
  palette: Palette;
  onPress: () => void;
}) {
  const preset = THEME_PRESETS[id];
  const sample = usePalette(preset.theme);
  // Corner radii in thumbnails are scaled down proportionally, otherwise a 28pt radius would become a full circle on small cards.
  const radius = Math.round(sample.radius * 0.45);
  return (
    <Pressable
      testID={`style-${id}`}
      accessibilityRole="button"
      accessibilityState={{ selected: current }}
      onPress={onPress}
      style={({ pressed }) => [styles.swatch, { opacity: pressed ? 0.6 : 1 }]}>
      <View
        style={[
          styles.sample,
          sample.backdrop,
          {
            borderRadius: palette.controlRadius,
            borderColor: current ? palette.primary : palette.border,
            borderWidth: current ? 2 : StyleSheet.hairlineWidth,
          },
        ]}>
        <View style={[styles.card, sample.cardStyle(), { borderRadius: radius }]}>
          <GlassFill palette={sample} radius={radius} />
          <View style={[styles.line, { backgroundColor: sample.text, width: '70%' }]} />
          <View style={[styles.line, { backgroundColor: sample.muted, width: '45%' }]} />
          <View
            style={[
              styles.pill,
              { backgroundColor: sample.primary, borderRadius: Math.min(radius, 7) },
            ]}
          />
        </View>
        {current ? (
          <View style={styles.check}>
            <Icon name="check" size={16} color={palette.primary} />
          </View>
        ) : null}
      </View>
      <Text
        numberOfLines={1}
        style={[
          palette.font(current ? 'bodyBold' : 'bodyMedium', 12),
          { color: current ? palette.text : palette.muted },
        ]}>
        {localize(preset.name, locale)}
      </Text>
    </Pressable>
  );
}

export function StylePicker({
  locale,
  current,
  palette,
  onPick,
}: {
  locale: Locale;
  current: ThemePresetId | null;
  palette: Palette;
  onPick: (id: ThemePresetId) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      testID="style-picker"
      style={{ marginHorizontal: -palette.pad }}
      contentContainerStyle={[styles.row, { paddingHorizontal: palette.pad }]}>
      {THEME_PRESET_IDS.map((id) => (
        <Swatch
          key={id}
          id={id}
          locale={locale}
          current={id === current}
          palette={palette}
          onPress={() => onPick(id)}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: 10, paddingVertical: 4 },
  swatch: { width: 84, gap: 6, alignItems: 'center' },
  sample: {
    width: 84,
    height: 92,
    padding: 10,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  card: { padding: 8, gap: 5 },
  line: { height: 5, borderRadius: 3 },
  pill: { height: 12, width: 34, marginTop: 3 },
  check: { position: 'absolute', top: 4, right: 4 },
});
