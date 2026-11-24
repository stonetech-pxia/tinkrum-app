import { ICON_NAMES, isEmoji, type IconValue, type Locale } from '@morph/core';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { BottomSheet } from '../renderer/Overlays';
import { t } from '../i18n';
import { useDrawnIcons } from '../renderer/DrawnIcon';
import { Icon } from '../renderer/Icon';
import type { Palette } from '../renderer/theme';
import { Button } from '../renderer/ui';

// Menu sliding up from the bottom: App name, contents, "Cancel". Dismisses when tapped outside.
// System layer, cannot be modified by AI (Invariant 8). Avoids system popups: Android system popups
// support at most three buttons, dropping subsequent items, whereas here we support up to five
// items plus "Cancel".

/** Menu sliding up from the bottom: App name, contents, "Cancel". Dismisses when tapped outside. */
export function AppMenuSheet({
  palette,
  locale,
  title,
  onClose,
  children,
}: {
  palette: Palette;
  locale: Locale;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <BottomSheet
      palette={palette}
      locale={locale}
      visible
      animationType="slide"
      onClose={onClose}
      backdropTestID="app-menu-backdrop"
      backdropLabel={t(locale, 'cancel')}
      bottomPadding={8}
      testID="app-menu"
      style={[
        styles.sheet,
        {
          backgroundColor: palette.surface,
          borderColor: palette.border,
          padding: palette.pad,
        },
      ]}>
      <Text style={[palette.font('title', 17), styles.title, { color: palette.text }]}>
        {title}
      </Text>
      {children}
      <AppMenuRow
        id="app-menu-cancel"
        label={t(locale, 'cancel')}
        palette={palette}
        onPress={onClose}
        muted
      />
    </BottomSheet>
  );
}

/** A single row in the menu. */
export function AppMenuRow({
  id,
  label,
  palette,
  onPress,
  muted,
}: {
  id: string;
  label: string;
  palette: Palette;
  onPress: () => void;
  muted?: boolean;
}) {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
      <Text style={[palette.font('body', 16), { color: muted ? palette.muted : palette.text }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Change icon (D-606): tap a built-in icon or enter an emoji. Icons in the config are already one
 * of these two types (D-048), this simply allows user selection; selection acts as confirmation
 * without further prompts.
 */
export function AppIconPicker({
  palette,
  locale,
  current,
  onPick,
}: {
  palette: Palette;
  locale: Locale;
  current: IconValue;
  onPick: (icon: IconValue) => void;
}) {
  const [emoji, setEmoji] = useState('');
  const [invalid, setInvalid] = useState(false);
  // Drawn icons from the config (D-625) are listed at the end.
  const drawn = Object.keys(useDrawnIcons()).map((id): IconValue => `my:${id}`);
  const applyEmoji = () => {
    const icon = emoji.trim();
    if (isEmoji(icon)) onPick(icon);
    else setInvalid(true);
  };
  return (
    <View style={{ gap: palette.gap - 4 }}>
      <Text style={[palette.font('body', 14), { color: palette.muted }]}>
        {t(locale, 'appIconItem')}
      </Text>
      <View style={styles.emojiRow}>
        <TextInput
          testID="app-icon-emoji"
          value={emoji}
          onChangeText={(text) => {
            setEmoji(text);
            setInvalid(false);
          }}
          placeholder={t(locale, 'appIconEmoji')}
          placeholderTextColor={palette.caption}
          returnKeyType="done"
          onSubmitEditing={applyEmoji}
          style={[
            palette.font('body', 16),
            styles.input,
            {
              color: palette.text,
              borderColor: palette.border,
              borderRadius: palette.controlRadius,
            },
          ]}
        />
        <Button
          palette={palette}
          testID="app-icon-emoji-use"
          variant="outline"
          label={t(locale, 'appIconEmojiUse')}
          disabled={emoji.trim() === ''}
          onPress={applyEmoji}
        />
      </View>
      {invalid ? (
        <Text style={[palette.font('body', 13), { color: palette.danger }]}>
          {t(locale, 'appIconEmojiInvalid')}
        </Text>
      ) : null}
      <ScrollView style={styles.gridScroll} keyboardShouldPersistTaps="handled">
        <View style={styles.grid}>
          {[...ICON_NAMES, ...drawn].map((name) => {
            const selected = name === current;
            return (
              <Pressable
                key={name}
                testID={`app-icon-${name}`}
                accessibilityRole="button"
                accessibilityLabel={name}
                accessibilityState={{ selected }}
                onPress={() => onPick(name)}
                style={({ pressed }) => [
                  styles.cell,
                  {
                    borderRadius: palette.controlRadius,
                    backgroundColor: selected ? palette.primaryTint : 'transparent',
                    opacity: pressed ? 0.6 : 1,
                  },
                ]}>
                <Icon name={name} size={24} color={selected ? palette.primaryText : palette.text} />
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: 2, borderWidth: StyleSheet.hairlineWidth },
  title: { paddingBottom: 6 },
  row: { minHeight: 48, justifyContent: 'center' },
  emojiRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, minHeight: 52 },
  // Seven items per row (width slightly less than one-seventh, otherwise rounding leaves only six
  // per row): 49 built-in icons fit exactly in seven rows without scrolling; as icons increase, the
  // grid scrolls itself.
  gridScroll: { maxHeight: 360 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '14.28%', height: 48, alignItems: 'center', justifyContent: 'center' },
});
