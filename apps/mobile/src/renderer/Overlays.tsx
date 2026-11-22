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

/** 弹层的窗口、遮罩和键盘避让只有这一处；内容和遮罩互为兄弟，点内容不会误关。 */
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
        {/* Android 的 Modal 不跟着键盘缩小，三星键盘也需要 padding（草稿聊天、运行问话框）。 */}
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

/** 底部菜单和表单；调用处只管内容，不再各写安全区、遮罩和键盘避让。 */
export function BottomSheet(props: OverlayProps & { onClose: () => void; bottomPadding?: number }) {
  return <Overlay {...props} sheet />;
}

/** 居中的问话或进度；没有 onClose 的进度框不能点遮罩或按返回取消。 */
export function Dialog(props: OverlayProps) {
  return <Overlay {...props} sheet={false} />;
}

/** 全屏照片、播放器和本地编辑器不使用弹层的边距或键盘避让。 */
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
