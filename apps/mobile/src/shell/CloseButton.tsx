import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { t } from '../i18n';
import type { Palette } from '../renderer/theme';
import { useWorkspaceContext } from '../workspace/context';

/** Top-left "Close" on modal pages (AI modify, run, record): no need to know swipe-down-to-close (D-111). */
export function CloseButton({ palette }: { palette: Palette }) {
  const router = useRouter();
  const { locale } = useWorkspaceContext();
  return (
    <Pressable
      testID="modal-close"
      accessibilityRole="button"
      hitSlop={10}
      style={styles.button}
      onPress={() => {
        if (router.canGoBack()) router.back();
        else router.replace('/');
      }}>
      <Text style={[palette.font('bodyBold', 16), { color: palette.primaryText }]}>
        {t(locale, 'close')}
      </Text>
    </Pressable>
  );
}

// Padding around text to avoid sticking to centered title (iOS 26 glass button wraps text based on content width).
const styles = StyleSheet.create({ button: { paddingHorizontal: 12 } });
