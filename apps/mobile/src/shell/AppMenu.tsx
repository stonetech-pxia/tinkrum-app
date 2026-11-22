import { ICON_NAMES, isEmoji, type IconValue, type Locale } from '@morph/core';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { BottomSheet } from '../renderer/Overlays';
import { t } from '../i18n';
import { Icon } from '../renderer/Icon';
import type { Palette } from '../renderer/theme';
import { Button } from '../renderer/ui';

// 「设置 → 我的 App」里长按一个 App 弹出的菜单（D-485、D-606）。系统层，AI 改不了（底线 8）。
// 不用系统弹窗：Android 的系统弹窗最多三个按钮，后面的项会被丢掉，而这里最多有五项加「取消」。

/** 从下面升起的菜单：App 的名字、里面的内容、「取消」。点外面也收起。 */
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

/** 菜单里的一行。 */
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
 * 换图标（D-606）：点一个内置图标，或者填一个表情。配置里的图标本来就是这两种（D-048），这里只是让用户
 * 自己选；选了就是确认，不再问。
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
          {ICON_NAMES.map((name) => {
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
  // 七个一行（宽度比七分之一略小一点，不然舍入以后一行只排得下六个）：49 个内置图标正好七行，
  // 不用滚；以后图标多了格子自己滚。
  gridScroll: { maxHeight: 360 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '14.28%', height: 48, alignItems: 'center', justifyContent: 'center' },
});
