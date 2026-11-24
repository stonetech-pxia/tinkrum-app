import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t, type StringKey } from '../i18n';
import { usePalette } from '../renderer/theme';
import { Button } from '../renderer/ui';
import { useWorkspaceContext, useAppTheme } from '../workspace/context';
import { useGuide } from './store';
import { WelcomeArt, type WelcomeArtKind } from './WelcomeArt';

// First page does not mention what else will be downloaded: download prompt states its size, works offline afterward, and recommends connecting to Wi-Fi (D-592, small text from original D-510).
const PAGES: { art: WelcomeArtKind; text: StringKey; sub?: StringKey }[] = [
  { art: 'scan', text: 'guideIntro1', sub: 'guideIntro1Sub' },
  { art: 'records', text: 'guideIntro2', sub: 'guideIntro2Sub' },
  { art: 'style', text: 'guideIntro3' },
];

/**
 * Onboarding slider (D-149): three pages, each with an illustration and a single sentence (scan
 * paper documents into PDF, Word, Excel, free, processed entirely on-device; record via scan,
 * file, or voice into respective mini-apps with reminders; tell Tink a sentence for missing
 * features or appearance changes, D-592); skippable. Finishing or skipping enters step 1 of the
 * home screen, leaving the surprises for the user to discover.
 */
export function WelcomeScreen() {
  const { locale } = useWorkspaceContext();
  const theme = useAppTheme();
  const palette = usePalette(theme);
  const setStage = useGuide((s) => s.setStage);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const scroller = useRef<ScrollViewInstance>(null);
  const [index, setIndex] = useState(0);
  const last = index === PAGES.length - 1;

  // After closing (finishing, skipping, or system back), the shell won't push it again the next time it's needed.
  useEffect(() => () => useGuide.setState({ introOpen: false }), []);

  function finish() {
    void setStage('look');
    router.back();
  }

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    setIndex(Math.round(e.nativeEvent.contentOffset.x / width));
  }

  return (
    <View
      testID="welcome"
      style={[
        styles.root,
        palette.backdrop,
        { paddingTop: insets.top, paddingBottom: insets.bottom + 16 },
      ]}>
      <Pressable
        testID="welcome-skip"
        accessibilityRole="button"
        onPress={finish}
        hitSlop={10}
        style={styles.skip}>
        <Text style={[palette.font('bodyMedium', 15), { color: palette.muted }]}>
          {t(locale, 'guideSkip')}
        </Text>
      </Pressable>
      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        style={styles.flex}>
        {PAGES.map((page, i) => (
          <View key={page.text} style={[styles.page, { width }]} testID={`welcome-page-${i}`}>
            <WelcomeArt kind={page.art} palette={palette} locale={locale} />
            <Text
              style={[
                palette.font('heading', 22),
                styles.center,
                { color: palette.text, letterSpacing: -0.3, lineHeight: 32 },
              ]}>
              {t(locale, page.text)}
            </Text>
            {page.sub ? (
              <Text
                style={[
                  palette.font('body', 15),
                  styles.center,
                  { color: palette.muted, marginTop: -20, lineHeight: 22 },
                ]}>
                {t(locale, page.sub)}
              </Text>
            ) : null}
          </View>
        ))}
      </ScrollView>
      <View style={styles.dots}>
        {PAGES.map((page, i) => (
          <View
            key={page.text}
            style={[
              styles.dot,
              { backgroundColor: i === index ? palette.primary : palette.border },
              i === index && styles.dotActive,
            ]}
          />
        ))}
      </View>
      <Button
        palette={palette}
        testID="welcome-next"
        label={t(locale, last ? 'guideStart' : 'guideNext')}
        style={styles.button}
        onPress={() => {
          if (last) return finish();
          scroller.current?.scrollTo({ x: (index + 1) * width, animated: true });
          setIndex(index + 1);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  skip: { alignSelf: 'flex-end', paddingHorizontal: 24, paddingVertical: 12 },
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 32, padding: 28 },
  center: { textAlign: 'center' },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 20 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotActive: { width: 22 },
  button: { marginHorizontal: 24 },
});
