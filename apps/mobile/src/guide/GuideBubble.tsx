import { PAPER_APP_ID, appTarget, localize, paperAppOps } from '@morph/core';
import { BlurView } from 'expo-blur';
import { useRouter } from 'expo-router';
import type { ComponentRef, RefObject } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useHomeScreenPlatform } from '../home-screen/context';
import { t } from '../i18n';
import type { Palette } from '../renderer/theme';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { LOOK_PROMPTS, openLookGuide, useGuide } from './store';

/**
 * Guidance steps 1 and 2: speech from Tink in the top right (D-447). Floats above the page
 * without occupying layout space; the page beneath the bubble is slightly blurred (Tink's line is
 * not blurred, and Tink has a halo). Step 1: tap the bubble to open that sentence; bottom-right
 * "Skip" directly builds the Paper app (bypassing preview, D-239). Step 2: "All set",
 * bottom-right "Got it" closes the bubble, ending the guidance (step 3 sample app was cancelled,
 * D-447).
 */
export function GuideBubble({
  palette,
  top,
  blurTarget,
}: {
  palette: Palette;
  /** Position of the bubble's pointer: bottom edge of Tink's line. */
  top: number;
  /** Android requires wrapping blurred content in a BlurTargetView for real blurring to take effect. */
  blurTarget: RefObject<ComponentRef<typeof View> | null>;
}) {
  const { locale, registry } = useWorkspaceContext();
  const stage = useGuide((s) => s.stage);
  const setStage = useGuide((s) => s.setStage);
  const config = useWorkspace((s) => s.config)!;
  const proposeOps = useWorkspace((s) => s.proposeOps);
  const confirm = useWorkspace((s) => s.confirm);
  const router = useRouter();
  const homeScreen = useHomeScreenPlatform();
  if (stage !== 'look' && stage !== 'goal') return null;
  const look = stage === 'look';
  // Step 2 also says what the phone's home screen offers, once the app is in the menu of the
  // Tinkrum icon there (D-new-apphome-4): where the phone allows it, as an icon of its own.
  const done = !config.nav.phoneHomeScreen?.includes(appTarget(PAPER_APP_ID))
    ? 'guideTinkDone'
    : homeScreen?.canPin()
      ? 'guideTinkDonePin'
      : 'guideTinkDoneMenu';

  /** Skip guidance (D-231, D-new-apphome-2): directly build the Paper app (bypassing preview), without showing "Modified · Undo" at the top (D-239). */
  async function skip() {
    const ops = paperAppOps(config, locale, registry);
    if (ops.length > 0) {
      const proposed = await proposeOps(ops, localize(LOOK_PROMPTS[0]!, locale));
      if (proposed.kind === 'preview') await confirm({ quiet: true });
    }
    await setStage('done');
  }

  const onBubble = { color: palette.onPrimary };
  return (
    <View style={[StyleSheet.absoluteFill, { top }]} testID="guide-overlay">
      <BlurView
        testID="guide-blur"
        intensity={Platform.OS === 'ios' ? 4 : 8}
        tint={palette.dark ? 'dark' : 'light'}
        blurTarget={blurTarget}
        blurMethod="dimezisBlurViewSdk31Plus"
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[styles.wrap, { paddingLeft: palette.pad, paddingRight: palette.pad - 3 }]}
        testID={look ? 'guide-look' : 'guide-goal'}>
        <Pressable
          testID={look ? 'guide-look-0' : undefined}
          accessibilityRole={look ? 'button' : undefined}
          disabled={!look}
          onPress={() => openLookGuide(router)}
          style={({ pressed }) => [
            styles.bubble,
            {
              paddingHorizontal: palette.inset,
              backgroundColor: palette.primary,
              opacity: pressed ? 0.85 : 1,
              // Highlight: primary color glow, which together with Tink's top-right halo draws the user's eye.
              boxShadow: `0px 0px 18px ${palette.primary}99`,
            },
          ]}>
          <View style={[styles.tail, { borderBottomColor: palette.primary }]} />
          <Text style={[palette.font('bodyMedium', 16), onBubble, { lineHeight: 23 }]}>
            {t(locale, look ? 'guideTinkSays' : done)}
          </Text>
          <Pressable
            testID={look ? 'guide-skip' : 'guide-later'}
            accessibilityRole="button"
            hitSlop={10}
            style={styles.action}
            onPress={() => void (look ? skip() : setStage('done'))}>
            <Text style={[palette.font('bodyBold', 14), onBubble, { opacity: look ? 0.75 : 1 }]}>
              {t(locale, look ? 'guideSkip' : 'guideGotIt')}
            </Text>
          </Pressable>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Bubble attached to the top right below Tink, with the triangular tip pointing at Tink: Tink's
  // center is screen right pad + 12 (the entry row aligns with the page margin), the bubble's right
  // side is screen pad - 3, and the tip's center is 15 from the bubble's right side; the corner
  // facing Tink is made smaller, and the tip lands on the straight edge.
  wrap: { alignItems: 'flex-end', paddingTop: 12 },
  tail: {
    position: 'absolute',
    top: -10,
    right: 6,
    width: 0,
    height: 0,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderBottomWidth: 11,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  bubble: {
    maxWidth: 300,
    borderRadius: 18,
    borderTopRightRadius: 6,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 6,
  },
  action: { alignSelf: 'flex-end', paddingVertical: 2 },
});
