import type { Locale } from '@morph/core';
import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  View,
  type ModalProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t } from '../i18n';
import type { Palette } from './theme';

interface OverlayProps {
  palette: Palette;
  locale: Locale;
  children: ReactNode;
  visible?: boolean;
  onClose?: () => void;
  testID?: string;
  backdropTestID?: string;
  backdropLabel?: string;
  style?: StyleProp<ViewStyle>;
  animationType?: ModalProps['animationType'];
}

/** Single implementation for overlay window, backdrop, and keyboard avoidance; content and backdrop are siblings, tapping content does not cause accidental closure. */
function Overlay({
  palette,
  locale,
  children,
  visible = true,
  onClose,
  testID,
  backdropTestID,
  backdropLabel,
  style,
  animationType,
  sheet,
  bottomPadding = 12,
}: OverlayProps & { sheet: boolean; bottomPadding?: number }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType={animationType ?? (sheet ? 'slide' : 'fade')}
      onRequestClose={onClose ?? (() => {})}>
      <View style={[styles.root, { backgroundColor: sheet ? palette.scrim : palette.scrimStrong }]}>
        <Pressable
          testID={backdropTestID ?? (testID ? `${testID}-backdrop` : undefined)}
          accessibilityRole="button"
          accessibilityLabel={backdropLabel ?? t(locale, 'close')}
          disabled={!onClose}
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        {/* Android's Modal does not shrink with keyboard, Samsung keyboard also requires padding (draft chat, execution prompt dialog). */}
        <KeyboardAvoidingView
          behavior="padding"
          pointerEvents="box-none"
          style={[
            styles.root,
            sheet
              ? { justifyContent: 'flex-end', paddingTop: insets.top }
              : {
                  justifyContent: 'center',
                  paddingHorizontal: palette.pad,
                  paddingTop: Math.max(insets.top, palette.pad),
                  paddingBottom: Math.max(insets.bottom, palette.pad),
                },
          ]}>
          <View
            testID={testID}
            accessibilityViewIsModal
            style={[
              { backgroundColor: palette.surface, padding: palette.pad, flexShrink: 1 },
              sheet
                ? {
                    maxHeight: '90%',
                    borderTopLeftRadius: palette.radius,
                    borderTopRightRadius: palette.radius,
                  }
                : { maxHeight: '100%', borderRadius: palette.radius },
              style,
              sheet && { paddingBottom: insets.bottom + bottomPadding },
            ]}>
            {children}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

/** Bottom menus and forms; callers only manage content without repeatedly writing safe areas, backdrops, and keyboard avoidance. */
export function BottomSheet(props: OverlayProps & { onClose: () => void; bottomPadding?: number }) {
  return <Overlay {...props} sheet />;
}

/** Centered prompt or progress; progress dialogs without onClose cannot be dismissed by tapping backdrop or pressing back. */
export function Dialog(props: OverlayProps) {
  return <Overlay {...props} sheet={false} />;
}

/** FullScreen photos, players, and local editors do not use overlay margins or keyboard avoidance. */
export function FullScreenModal({
  children,
  onClose,
  animationType = 'slide',
  visible = true,
}: {
  children: ReactNode;
  onClose: () => void;
  animationType?: ModalProps['animationType'];
  visible?: boolean;
}) {
  return (
    <Modal
      visible={visible}
      animationType={animationType}
      presentationStyle="overFullScreen"
      onRequestClose={onClose}>
      {children}
    </Modal>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
