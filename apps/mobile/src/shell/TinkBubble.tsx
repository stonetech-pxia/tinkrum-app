import { useEffect, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import type { Palette } from '../renderer/theme';

/** All four corners are equally rounded; the base of the pointed tail rests on the straight edge (at least RADIUS away from the right side). */
const RADIUS = 12;
/** Size when collapsed into three dots: three dots (size 5, spacing 4) plus padding of 11 on left/right and 7 on top/bottom. */
const DOT = 5;
const MINI = { w: 3 * DOT + 2 * 4 + 22, h: DOT + 14 };
const SHRINK_MS = 320;
const MARGIN = 12;

/**
 * What Tink says in the upper right (D-526): bubble floats on the page, pointing at Tink with its
 * tail; when expanded, it shows content plus "Got it" in the bottom right. Tapping it smoothly
 * shrinks the bubble's width, height, corner radius, and tail together into a small bubble with
 * only three dots (text fades out first, fades in after tapping), and tapping the three dots
 * expands it again. When content is too long, the bubble has a maximum height, content scrolls
 * inside, and "Got it" always stays at the bottom.
 *
 * The outer shell handles position and animation only; measure the expanded height once ourselves
 * (when content changes, change `key` to re-measure). `top` is the bubble's top edge (the tail is
 * 10 above it); `tinkRight` is how far Tink's center is from the right edge, and the tail aligns
 * with it.
 */
export function TinkBubble({
  palette,
  top,
  tinkRight,
  collapsed,
  gotIt,
  expandLabel,
  onGotIt,
  onExpand,
  children,
}: {
  palette: Palette;
  top: number;
  tinkRight: number;
  collapsed: boolean;
  gotIt: string;
  expandLabel: string;
  onGotIt: () => void;
  onExpand: () => void;
  children: ReactNode;
}) {
  const window = useWindowDimensions();
  const width = Math.min(300, window.width - 2 * MARGIN);
  const maxContent = Math.round(window.height * 0.4);
  const [progress] = useState(() => new Animated.Value(collapsed ? 1 : 0)); // 0 expanded, 1 three dots
  const [fullHeight, setFullHeight] = useState<number | null>(null);
  useEffect(() => {
    Animated.timing(progress, {
      toValue: collapsed ? 1 : 0,
      duration: SHRINK_MS,
      easing: Easing.bezier(0.4, 0, 0.2, 1),
      useNativeDriver: false,
    }).start();
  }, [collapsed, progress]);

  const out = [0, 1] as const;
  const onBubble = { color: palette.onPrimary };
  // The center of the tail aligns with Tink (bubble's right edge is MARGIN away from the screen); the base does not exceed the straight edge.
  const tailRight = Math.max(RADIUS, tinkRight - MARGIN - 9);
  const content = (
    <Animated.View
      testID={collapsed ? undefined : 'draft-reply'}
      pointerEvents={collapsed ? 'none' : 'auto'}
      onLayout={(e) => setFullHeight((prev) => prev ?? e.nativeEvent.layout.height)}
      style={[
        fullHeight === null ? null : { position: 'absolute', top: 0, left: 0 },
        {
          width,
          opacity: progress.interpolate({
            inputRange: [0, 0.4],
            outputRange: [1, 0],
            extrapolate: 'clamp',
          }),
        },
      ]}>
      <View style={[styles.content, { paddingHorizontal: palette.inset }]}>
        <ScrollView
          style={{ maxHeight: maxContent }}
          bounces={false}
          showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
        <Pressable
          testID="draft-reply-hide"
          accessibilityRole="button"
          hitSlop={10}
          style={styles.action}
          onPress={onGotIt}>
          <Text style={[palette.font('bodyBold', 14), onBubble]}>{gotIt}</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
  return (
    <View pointerEvents="box-none" style={[styles.overlay, { top, right: MARGIN }]}>
      <Pressable
        testID={collapsed ? 'draft-reply-show' : undefined}
        accessibilityRole="button"
        accessibilityLabel={collapsed ? expandLabel : undefined}
        disabled={!collapsed}
        hitSlop={collapsed ? 12 : 0}
        onPress={onExpand}>
        <Animated.View
          style={[
            fullHeight === null
              ? { width }
              : {
                  width: progress.interpolate({ inputRange: out, outputRange: [width, MINI.w] }),
                  height: progress.interpolate({
                    inputRange: out,
                    outputRange: [fullHeight, MINI.h],
                  }),
                },
            {
              // Not displayed until height measurement is complete, avoiding a flash.
              opacity: fullHeight === null ? 0 : 1,
              backgroundColor: palette.primary,
              borderRadius: progress.interpolate({
                inputRange: out,
                outputRange: [RADIUS, MINI.h / 2],
              }),
              // Highlight: primary color glow, drawing the user's eye along with Tink's halo.
              boxShadow: `0px 0px 18px ${palette.primary}99`,
            },
          ]}>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.tail,
              { right: tailRight, borderBottomColor: palette.primary },
              {
                transformOrigin: '50% 100%',
                transform: [
                  { scale: progress.interpolate({ inputRange: out, outputRange: [1, 0.72] }) },
                ],
              },
            ]}
          />
          {fullHeight === null ? (
            content
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.clip]}>
              {content}
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.dots,
                  {
                    opacity: progress.interpolate({
                      inputRange: [0.45, 1],
                      outputRange: [0, 1],
                      extrapolate: 'clamp',
                    }),
                  },
                ]}>
                {[0, 1, 2].map((i) => (
                  <View key={i} style={[styles.dot, { backgroundColor: palette.onPrimary }]} />
                ))}
              </Animated.View>
            </View>
          )}
        </Animated.View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', alignItems: 'flex-end', zIndex: 20 },
  tail: {
    position: 'absolute',
    top: -10,
    width: 0,
    height: 0,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderBottomWidth: 11,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  content: { paddingTop: 12, paddingBottom: 10, gap: 6 },
  action: { alignSelf: 'flex-end', paddingVertical: 2 },
  clip: { overflow: 'hidden', borderRadius: RADIUS },
  dots: {
    ...StyleSheet.absoluteFill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
});
