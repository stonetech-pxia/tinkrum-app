import { sampleInfo, type SampleApp } from '@morph/core';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { create } from 'zustand';

import { t } from '../i18n';
import type { Palette } from '../renderer/theme';
import { Pill, Card } from '../renderer/ui';
import { useWorkspaceContext } from '../workspace/context';

// After applying the sample app (D-260): returns to its main page, with the top showing "Modified ·
// Undo" as usual, and a small card below prompting that AI can be used to continue modifying. Shown
// only during this app opening, not persisted; tapping "Use AI to continue" fills a starting
// sentence into the AI input box for the user to finish writing and send themselves.

interface SampleHintState {
  hint: { sample: SampleApp; pageId: string } | null;
  show(sample: SampleApp, pageId: string): void;
  dismiss(): void;
}

export const useSampleHint = create<SampleHintState>()((set) => ({
  hint: null,
  show: (sample, pageId) => set({ hint: { sample, pageId } }),
  dismiss: () => set({ hint: null }),
}));

export function SampleHint({ pageId, palette }: { pageId: string; palette: Palette }) {
  const { locale } = useWorkspaceContext();
  const hint = useSampleHint((s) => s.hint);
  const dismiss = useSampleHint((s) => s.dismiss);
  const router = useRouter();
  if (!hint || hint.pageId !== pageId) return null;
  const name = sampleInfo(hint.sample, locale).name;

  function change() {
    dismiss();
    router.push({
      pathname: '/change',
      params: { text: t(locale, 'sampleContinuePrompt', { name }) },
    });
  }

  return (
    <View style={[styles.wrap, { paddingHorizontal: palette.pad }]}>
      <Card palette={palette} background={palette.surface} testID="sample-hint">
        <Text style={[palette.font('title', 16), { color: palette.text }]}>
          {t(locale, 'sampleReadyTitle', { name })}
        </Text>
        <Text style={[palette.font('body', 14), { color: palette.muted }]}>
          {t(locale, 'sampleReadyBody')}
        </Text>
        <View style={styles.actions}>
          <Pill
            testID="sample-hint-change"
            label={t(locale, 'sampleReadyChange')}
            palette={palette}
            onPress={change}
          />
          <Pressable
            testID="sample-hint-dismiss"
            accessibilityRole="button"
            hitSlop={8}
            onPress={dismiss}>
            <Text style={[palette.font('bodyMedium', 13), { color: palette.caption }]}>
              {t(locale, 'sampleReadyDismiss')}
            </Text>
          </Pressable>
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  // Attached to left and right page margins (D-454), written where used.
  wrap: { paddingTop: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
});
