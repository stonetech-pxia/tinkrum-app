import { SAMPLE_APPS, pageTarget, sampleInfo, type SampleApp } from '@morph/core';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { Icon } from '../renderer/Icon';
import type { Palette } from '../renderer/theme';
import { Card } from '../renderer/ui';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { useGuide } from './store';

/**
 * Guide card on the home screen (D-149, D-231). Steps 1 and 2 are Tink's speech bubble in the top
 * right, see GuideBubble (D-447). Step 3 (D-260, after step 2 opens an image or file, or taps
 * "Later"): lists five sample apps, tapping one loads the entire set into the draft (D-190), view
 * the main page, and the user taps "Apply" to save; selection or "Later" ends the guide.
 */
export function GuideCard({ palette }: { palette: Palette }) {
  const { locale } = useWorkspaceContext();
  const stage = useGuide((s) => s.stage);
  const setStage = useGuide((s) => s.setStage);
  const { busy, pick } = usePickSample();
  const body = [palette.font('body', 14), { color: palette.muted }];

  if (stage === 'samples') {
    return (
      <View style={[styles.wrap, { paddingHorizontal: palette.pad }]}>
        <Card palette={palette} background={palette.surface} testID="guide-samples">
          <Text style={[palette.font('title', 16), { color: palette.text }]}>
            {t(locale, 'guideSamplesTitle')}
          </Text>
          <Text style={body}>{t(locale, 'guideSamplesBody')}</Text>
          <SampleRows
            palette={palette}
            testPrefix="guide-sample"
            busy={busy}
            onPick={(id) => void pick(id, () => setStage('done'))}
          />
          <Pressable
            testID="guide-samples-later"
            accessibilityRole="button"
            hitSlop={8}
            style={styles.link}
            onPress={() => void setStage('done')}>
            <Text style={[palette.font('bodyMedium', 13), { color: palette.caption }]}>
              {t(locale, 'guideLater')}
            </Text>
          </Pressable>
        </Card>
      </View>
    );
  }

  // Steps 1 and 2 are Tink's speech bubble (GuideBubble, D-447).
  return null;
}

/**
 * Pick a sample: modifies the entire set into the draft (D-190), displays its main page; explains
 * the reason when it doesn't fit, and the draft remains unchanged. Shared between guide step 3
 * and "My Presets" (D-544); before is executed before displaying the page (ending the guide,
 * returning to home).
 */
export function usePickSample() {
  const { locale } = useWorkspaceContext();
  const draftSample = useWorkspace((s) => s.draftSample);
  const showInShell = useWorkspace((s) => s.showInShell);
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function pick(sample: SampleApp, before: () => unknown) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await draftSample(sample);
      if (result.kind !== 'drafted') {
        const message = result.kind === 'rejected' ? result.message : t(locale, 'sampleFailed');
        Alert.alert(sampleInfo(sample, locale).name, message);
        return;
      }
      await before();
      const target = pageTarget(result.focusPageId);
      if (!showInShell(result.step.config, target))
        router.push({ pathname: '/page/[pageId]', params: { pageId: result.focusPageId } });
    } finally {
      setBusy(false);
    }
  }
  return { busy, pick };
}

/** Sample list: icon, name, brief description. */
export function SampleRows({
  palette,
  testPrefix,
  busy,
  onPick,
}: {
  palette: Palette;
  testPrefix: string;
  busy: boolean;
  onPick: (sample: SampleApp) => void;
}) {
  const { locale } = useWorkspaceContext();
  return SAMPLE_APPS.map((id) => {
    const info = sampleInfo(id, locale);
    return (
      <Pressable
        key={id}
        testID={`${testPrefix}-${id}`}
        accessibilityRole="button"
        disabled={busy}
        onPress={() => onPick(id)}
        style={({ pressed }) => [styles.sample, { opacity: pressed || busy ? 0.6 : 1 }]}>
        <View style={[styles.sampleIcon, { backgroundColor: palette.primaryTint }]}>
          <Icon name={info.icon} size={20} color={palette.primaryText} />
        </View>
        <View style={styles.sampleText}>
          <Text style={[palette.font('bodyBold', 15), { color: palette.text }]}>{info.name}</Text>
          <Text style={[palette.font('body', 13), { color: palette.muted }]}>{info.summary}</Text>
        </View>
      </Pressable>
    );
  });
}

const styles = StyleSheet.create({
  // Attached to left and right page margins (D-454), written where used.
  wrap: { paddingTop: 8 },
  link: { alignSelf: 'flex-start', paddingVertical: 2 },
  sample: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  sampleIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sampleText: { flex: 1, gap: 2 },
});
