import type { Locale } from '@morph/core';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FullScreenModal } from '../renderer/Overlays';
import { t } from '../i18n';
import type { Palette } from '../renderer/theme';
import { ZoomImage } from './ZoomImage';

// Fullscreen viewer for photos and videos on the inbox page (D-238): swipe left and right to browse
// photos and videos in the batch, displayed locally only. Photos support pinch-to-zoom (D-277);
// thumbnails on the results page also open using this. Videos build a player only for the currently
// viewed page using native playback controls, without autoplay.

export interface ViewerItem {
  uri: string;
  kind: 'image' | 'video';
}

function VideoPage({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri);
  return <VideoView player={player} style={styles.flex} contentFit="contain" nativeControls />;
}

/** That video on the inbox page (D-238): displayed directly on the page, plays only when tapped. */
export function InlineVideo({ uri, height }: { uri: string; height: number }) {
  const player = useVideoPlayer(uri);
  return (
    <VideoView
      testID="share-preview-video"
      player={player}
      style={{ height, borderRadius: 8 }}
      contentFit="contain"
      nativeControls
    />
  );
}

export function FileViewer({
  items,
  start,
  onClose,
  palette,
  locale,
}: {
  items: readonly ViewerItem[];
  start: number;
  onClose: () => void;
  palette: Palette;
  locale: Locale;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(start);
  // Do not change pages while zoomed in to view an image (single-finger drag is used to inspect local details).
  const [zoomed, setZoomed] = useState(false);
  return (
    <FullScreenModal animationType="fade" onClose={onClose}>
      {/* Android Modal is a separate window, so gestures require their own root view. */}
      <GestureHandlerRootView style={styles.flex}>
        <View
          testID="share-viewer"
          style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          <View style={styles.bar}>
            {/* 'Close' is placed in the top-left corner, same as the inbox page. */}
            <Pressable testID="share-viewer-close" onPress={onClose} hitSlop={10}>
              <Text style={[palette.font('bodyBold', 16), styles.white]}>{t(locale, 'close')}</Text>
            </Pressable>
            <Text
              testID="share-viewer-count"
              style={[palette.font('bodyMedium', 15), styles.white]}>
              {`${index + 1} / ${items.length}`}
            </Text>
          </View>
          <FlatList
            data={items}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            scrollEnabled={!zoomed}
            initialScrollIndex={start}
            getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
            keyExtractor={(item, i) => `${i}-${item.uri}`}
            onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
            renderItem={({ item, index: i }) => (
              <View style={{ width }}>
                {item.kind === 'image' ? (
                  <ZoomImage
                    uri={item.uri}
                    width={width}
                    height={height}
                    onZoomed={i === index ? setZoomed : undefined}
                  />
                ) : i === index ? (
                  <VideoPage uri={item.uri} />
                ) : null}
              </View>
            )}
          />
        </View>
      </GestureHandlerRootView>
    </FullScreenModal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000000' },
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  white: { color: '#FFFFFF' },
  flex: { flex: 1 },
});
