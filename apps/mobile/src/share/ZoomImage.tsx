import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

// Two-finger pinch-to-zoom in full-screen image view (D-277): two-finger zoom (1–5x), single-finger
// drag to view details when zoomed, double-tap to zoom to 2.5x / reset. When not zoomed,
// single-finger horizontal swipes are delegated to the outer pagination list (onZoomed tells it
// temporarily not to paginate).

const MAX = 5;

export function ZoomImage({
  uri,
  width,
  height,
  onZoomed,
  top,
}: {
  uri: string;
  width: number;
  height: number;
  onZoomed?: (zoomed: boolean) => void;
  /** Stick to the top edge when the image is narrower or shorter than the frame (preview page, D-457); otherwise centered in the frame (full-screen image viewer). */
  top?: boolean;
}) {
  const scale = useSharedValue(1);
  const start = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const zoomed = useSharedValue(false);

  const [isZoomed, setIsZoomed] = useState(false);
  const report = (value: boolean) => {
    setIsZoomed(value);
    onZoomed?.(value);
  };
  /** Draggable bounds after zooming: the image stays within the screen. */
  const clampOffsets = () => {
    'worklet';
    const mx = ((scale.value - 1) * width) / 2;
    const my = ((scale.value - 1) * height) / 2;
    x.value = Math.min(mx, Math.max(-mx, x.value));
    y.value = Math.min(my, Math.max(-my, y.value));
  };
  const setZoomed = (value: boolean) => {
    'worklet';
    if (zoomed.value !== value) {
      zoomed.value = value;
      runOnJS(report)(value);
    }
  };

  const pinch = Gesture.Pinch()
    .onStart(() => {
      start.value = scale.value;
    })
    .onUpdate((e) => {
      scale.value = Math.min(MAX, Math.max(1, start.value * e.scale));
      clampOffsets();
    })
    .onEnd(() => {
      if (scale.value <= 1.01) {
        scale.value = withTiming(1);
        x.value = withTiming(0);
        y.value = withTiming(0);
        setZoomed(false);
      } else {
        setZoomed(true);
      }
    });
  const pan = Gesture.Pan()
    // Do not handle single-finger drag when not zoomed; horizontal swipes are handled by the pagination list.
    .enabled(isZoomed)
    .averageTouches(true)
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((e) => {
      if (scale.value <= 1) return;
      x.value = startX.value + e.translationX;
      y.value = startY.value + e.translationY;
      clampOffsets();
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1) {
        scale.value = withTiming(1);
        x.value = withTiming(0);
        y.value = withTiming(0);
        setZoomed(false);
      } else {
        scale.value = withTiming(2.5);
        setZoomed(true);
      }
    });
  const gesture = Gesture.Simultaneous(pinch, Gesture.Exclusive(doubleTap, pan));

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.flex, style]}>
        <Image
          source={{ uri }}
          style={styles.flex}
          contentFit="contain"
          {...(top ? { contentPosition: { top: 0 } } : {})}
        />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
