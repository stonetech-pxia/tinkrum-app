import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Palette } from '../../renderer/theme';

// Outer frame of local operation interfaces: title, cancel, done. Displayed full-screen above the run page.

export function LocalFrame({
  palette,
  title,
  cancelLabel,
  doneLabel,
  onCancel,
  onDone,
  doneDisabled,
  avoidKeyboard,
  children,
}: {
  palette: Palette;
  title: string;
  cancelLabel: string;
  doneLabel: string;
  onCancel: () => void;
  onDone: () => void;
  doneDisabled?: boolean;
  /** Interfaces with input fields (log an entry, D-187): when the keyboard pops up, "Done" moves up along with it so it is not blocked. */
  avoidKeyboard?: boolean;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      // Android is edge-to-edge, so the window does not shrink due to the keyboard: both sides reserve the keyboard height.
      enabled={avoidKeyboard === true}
      behavior="padding"
      style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable testID="local-cancel" onPress={onCancel} hitSlop={10}>
          <Text style={[palette.font('bodyBold', 16), { color: palette.muted }]}>
            {cancelLabel}
          </Text>
        </Pressable>
        <Text
          numberOfLines={1}
          style={[palette.font('title', 17), styles.title, { color: palette.text }]}>
          {title}
        </Text>
        {/* Symmetric placeholder balancing the "Cancel" button to center the title. */}
        <View style={styles.side} />
      </View>
      <View style={styles.body}>{children}</View>
      {/* Place "Done" at the bottom: easy to press with one hand, and unobstructed by system or developer menu buttons. */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable
          testID="local-done"
          onPress={onDone}
          disabled={doneDisabled}
          style={({ pressed }) => [
            styles.done,
            {
              backgroundColor: doneDisabled ? palette.border : palette.primary,
              borderRadius: palette.controlRadius,
              opacity: pressed ? 0.8 : 1,
            },
          ]}>
          <Text style={[palette.font('bodyBold', 17), { color: palette.onPrimary }]}>
            {doneLabel}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 12,
  },
  title: { flex: 1, textAlign: 'center' },
  side: { width: 40 },
  body: { flex: 1 },
  footer: { paddingHorizontal: 20, paddingTop: 10 },
  done: { minHeight: 52, alignItems: 'center', justifyContent: 'center' },
});
