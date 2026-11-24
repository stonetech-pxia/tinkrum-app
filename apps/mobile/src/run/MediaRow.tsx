import { mediaKindOf, type Locale, type RunItem } from '@morph/core';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FullScreenModal } from '../renderer/Overlays';
import { t } from '../i18n';
import { Icon } from '../renderer/Icon';
import type { Palette } from '../renderer/theme';
import { Pill } from '../renderer/ui';
import { formatTime } from './local/TrimScreen';

// A video or audio item on the results page (D-140): icon, file name, duration · dimensions · size;
// "Play" opens fullscreen player (system built-in playback controls, supporting audio playback and
// duration viewing). Shared between video and audio, audio tools may later be replaced with
// waveforms.

function Player({
  item,
  onClose,
  palette,
  locale,
}: {
  item: RunItem;
  onClose: () => void;
  palette: Palette;
  locale: Locale;
}) {
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer(item.uri, (p) => p.play());
  return (
    <View style={[styles.player, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <Pressable testID="media-close" onPress={onClose} hitSlop={10} style={styles.close}>
        <Text style={[palette.font('bodyBold', 16), { color: '#FFFFFF' }]}>
          {t(locale, 'close')}
        </Text>
      </Pressable>
      <VideoView
        testID="media-player"
        player={player}
        style={styles.flex}
        contentFit="contain"
        nativeControls
      />
    </View>
  );
}

export function MediaRow({
  item,
  palette,
  locale,
  detail,
}: {
  item: RunItem;
  palette: Palette;
  locale: Locale;
  /** Remaining details (dimensions, size), appended after duration using " · ". */
  detail: string;
}) {
  const [open, setOpen] = useState(false);
  const fileName = `${item.name}.${item.ext}`;
  const kind = mediaKindOf(item.mimeType, item.ext);
  const duration = item.durationMs ? formatTime(item.durationMs, false, locale) : null;
  return (
    <View style={styles.item} testID={`result-item-${fileName}`}>
      <View
        style={[
          styles.thumb,
          styles.icon,
          { backgroundColor: palette.primaryTint, borderRadius: 8 },
        ]}>
        <Icon name={kind === 'audio' ? 'audio' : 'video'} size={24} color={palette.primaryText} />
      </View>
      <View style={styles.flex}>
        <Text numberOfLines={2} style={[palette.font('bodyMedium', 15), { color: palette.text }]}>
          {item.assetId ? `${t(locale, 'resultSaved')} · ${fileName}` : fileName}
        </Text>
        <Text style={[palette.font('body', 13), { color: palette.muted }]}>
          {[duration, detail].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <Pill
        palette={palette}
        testID={`result-play-${fileName}`}
        label={t(locale, 'mediaPlay')}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <FullScreenModal animationType="slide" onClose={() => setOpen(false)}>
          <Player item={item} onClose={() => setOpen(false)} palette={palette} locale={locale} />
        </FullScreenModal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  thumb: { width: 52, height: 52 },
  icon: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, gap: 2 },
  player: { flex: 1, backgroundColor: '#000000' },
  close: { alignSelf: 'flex-end', paddingHorizontal: 20, paddingVertical: 12 },
});
