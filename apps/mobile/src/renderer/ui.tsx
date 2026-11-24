import type { Backdrop, IconValue } from '@morph/core';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { BackdropFill } from './Backdrop';
import { GlassFill } from './GlassFill';
import { Icon, UiIcon, type UiIconName } from './Icon';
import { iconColors, onSurface, type Palette } from './theme';

// Clay-style basic UI elements (corresponding to Docudis clay_widgets). Shared by the config
// renderer and system pages, so colors, fonts, border radii, and spacing in the theme apply across
// the entire app.

/** Card: theme border radius, soft shadow (or stroke), slight scale down when pressed. */
export function Card({
  palette,
  children,
  onPress,
  onLongPress,
  disabled,
  background,
  style,
  testID,
  accessibilityLabel,
  backdrop,
}: {
  palette: Palette;
  children: ReactNode;
  /** Image background (D-258): When present, rendered beneath the content, replacing the background color (and frosted glass). */
  backdrop?: Backdrop | undefined;
  accessibilityLabel?: string;
  onPress?: () => void;
  /** Page editing: Long press to open the component's action panel (D-052). */
  onLongPress?: () => void;
  disabled?: boolean;
  background?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const base = [palette.cardStyle(background), { padding: palette.inset, gap: 8 }, style];
  const fill = backdrop?.assetId ? (
    <BackdropFill
      backdrop={backdrop}
      color={background ?? palette.surface}
      palette={palette}
      radius={palette.radius}
    />
  ) : (
    <GlassFill palette={palette} />
  );
  if (!onPress) {
    return (
      <View testID={testID} style={base}>
        {fill}
        {children}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      style={({ pressed }) => [base, pressed && { transform: [{ scale: 0.97 }] }]}>
      {fill}
      {children}
    </Pressable>
  );
}

/** Colored icon block: three rounded corners and one sharper bottom-left corner. */
export function IconTile({
  palette,
  icon,
  background,
  color,
  size = 46,
}: {
  palette: Palette;
  icon: IconValue;
  background: string;
  color: string;
  size?: number;
}) {
  const scale = palette.radius / 22;
  const round = Math.round(16 * scale);
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: background,
        borderTopLeftRadius: round,
        borderTopRightRadius: round,
        borderBottomRightRadius: round,
        borderBottomLeftRadius: Math.round(6 * scale),
      }}>
      <Icon name={icon} size={Math.round(size * 0.48)} color={color} />
    </View>
  );
}

/**
 * Primary button (52pt high), outlined button, and text button; icon appears before the text.
 * When variant is icon, displays only a circular icon, leaving text for screen readers (D-230).
 */
export function Button({
  palette,
  label,
  onPress,
  onLongPress,
  variant = 'filled',
  icon,
  disabled,
  loading,
  danger,
  testID,
  style,
}: {
  palette: Palette;
  label: string;
  onPress?: () => void;
  onLongPress?: () => void;
  variant?: 'filled' | 'outline' | 'text' | 'icon';
  icon?: IconValue;
  disabled?: boolean;
  loading?: boolean;
  danger?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  if (variant === 'icon' && icon) {
    const colors = iconColors(palette, 'solid');
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        onLongPress={onLongPress}
        disabled={disabled || loading}
        style={({ pressed }) => [
          styles.iconButton,
          { backgroundColor: colors.background, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 },
          style,
        ]}>
        {loading ? (
          <ActivityIndicator color={colors.color} />
        ) : (
          <Icon name={icon} size={24} color={colors.color} />
        )}
      </Pressable>
    );
  }
  const accent = danger ? palette.danger : palette.primary;
  const filled = variant === 'filled';
  const color = filled ? palette.onPrimary : danger ? palette.danger : palette.primaryText;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          minHeight: variant === 'text' ? 44 : 52,
          paddingHorizontal: variant === 'text' ? 4 : 20,
          borderRadius: palette.controlRadius,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.5 : 1,
        },
        filled && { backgroundColor: pressed ? palette.primaryText : accent },
        variant === 'outline' && {
          borderWidth: 1.5,
          borderColor: danger ? palette.danger : palette.border,
          backgroundColor: palette.surface,
        },
        pressed && !filled && { opacity: 0.6 },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={color} />
      ) : icon ? (
        <View style={styles.labelRow}>
          <Icon name={icon} size={20} color={color} />
          <Text style={[palette.font('title', 16), { color }]}>{label}</Text>
        </View>
      ) : (
        <Text style={[palette.font('title', 16), { color }]}>{label}</Text>
      )}
    </Pressable>
  );
}

/** Small pill button; selected, radio, danger, and icon states share the same set of states and accessibility semantics. */
export function Pill({
  palette,
  label,
  onPress,
  danger,
  testID,
  selected,
  disabled,
  icon,
  radio,
}: {
  palette: Palette;
  label: string;
  onPress: () => void;
  danger?: boolean;
  testID?: string;
  selected?: boolean;
  disabled?: boolean;
  /** Kernel interface's own icons (UiIcon), not icons from the config: unrecognized names in that set are rendered as raw emojis. */
  icon?: UiIconName;
  radio?: boolean;
}) {
  const selectable = selected !== undefined;
  const accent = danger ? palette.danger : palette.primary;
  const filled = selected === true;
  const color = filled
    ? palette.onAccent(accent)
    : danger
      ? palette.danger
      : selectable
        ? palette.text
        : palette.primaryText;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={radio ? 'radio' : 'button'}
      accessibilityState={{ selected, disabled, ...(radio ? { checked: !!selected } : {}) }}
      style={({ pressed }) => ({
        minHeight: 38,
        justifyContent: 'center',
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 999,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderColor: danger || filled ? accent : palette.border,
        backgroundColor: filled
          ? accent
          : selectable || danger
            ? palette.surface
            : palette.primaryTint,
        opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
      })}>
      {icon ? <UiIcon name={icon} size={14} color={color} /> : null}
      <Text style={[palette.font('bodyBold', 14), { color, flexShrink: 1 }]}>{label}</Text>
    </Pressable>
  );
}

/** Search input for picking records; container determines only margins and background color. */
export function SearchInput({
  palette,
  value,
  onChangeText,
  placeholder,
  testID,
  style,
}: {
  palette: Palette;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      testID={testID}
      placeholderTextColor={palette.caption}
      autoCorrect={false}
      style={[
        palette.font('body', 16),
        {
          borderWidth: 1,
          paddingHorizontal: 12,
          paddingVertical: 10,
          color: palette.text,
          borderColor: palette.border,
          borderRadius: palette.controlRadius,
        },
        style,
      ]}
    />
  );
}

/** Page large title (Sora 28). */
export function PageTitle({ palette, children }: { palette: Palette; children: ReactNode }) {
  return (
    <Text
      style={[
        palette.font('display', 28),
        { color: palette.text, letterSpacing: -0.5, paddingTop: 8, paddingBottom: 4 },
      ]}>
      {children}
    </Text>
  );
}

/** Uppercase section title. */
export function SectionLabel({ palette, children }: { palette: Palette; children: string }) {
  return (
    <Text
      style={[
        palette.font('bodyBold', 12),
        { color: palette.caption, letterSpacing: 0.5, marginTop: 8 },
      ]}>
      {children.toUpperCase()}
    </Text>
  );
}

/** A row in lists like settings: icon block, title, description, right arrow. */
export function ListRow({
  palette: pagePalette,
  icon,
  label,
  value,
  onPress,
  onLongPress,
  testID,
}: {
  palette: Palette;
  icon?: IconValue;
  label: string;
  value?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  testID?: string;
}) {
  const palette = onSurface(pagePalette);
  return (
    <Card palette={palette} onPress={onPress} onLongPress={onLongPress} testID={testID}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        {icon ? (
          <IconTile palette={palette} icon={icon} size={40} {...iconColors(palette, 'tint')} />
        ) : null}
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[palette.font('title', 16), { color: palette.text }]}>{label}</Text>
          {value ? (
            <Text style={[palette.font('body', 14), { color: palette.muted }]}>{value}</Text>
          ) : null}
        </View>
        {onPress ? (
          <Text style={[palette.font('title', 20), { color: palette.caption }]}>›</Text>
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  iconButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
