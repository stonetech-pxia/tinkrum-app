import { localeTag, type Locale, type RunItem } from '@morph/core';
import { useEvent, useEventListener } from 'expo';
import { Image } from 'expo-image';
import { VideoView, useVideoPlayer, type VideoPlayer, type VideoThumbnail } from 'expo-video';
import { useEffect, useReducer, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '../../i18n';
import { Icon } from '../../renderer/Icon';
import type { Palette } from '../../renderer/theme';
import type { LocalScreenProps } from '../RunScreen';
import { LocalFrame } from './LocalFrame';

// Trim segment (TOOLS_DESIGN §4 trimMedia, D-143): select start and end points one by one. Videos
// and audio share start/end dragging, fine-tuning, time display, and "Play this segment only"; top
// half shows video frames, audio shows icons; timeline displays thumbnails for video and waveforms
// for audio (D-155). Results are used solely for the current run.

/** Minimum allowed duration (milliseconds). */
export const MIN_TRIM_MS = 1000;
const NUDGE_MS = 1000;
const THUMBS = 8;
const HANDLE = 22;

type Thumb = VideoThumbnail | { uri: string };

export interface TrimRange {
  startMs: number;
  endMs: number;
}

/** Move one edge while the other stays fixed; ensures bounds remain between 0 and duration, maintaining at least MIN_TRIM_MS. */
export function moveEdge(
  range: TrimRange,
  edge: 'start' | 'end',
  ms: number,
  durationMs: number,
): TrimRange {
  const min = Math.min(MIN_TRIM_MS, durationMs);
  if (edge === 'start') {
    const startMs = Math.round(Math.min(Math.max(0, ms), range.endMs - min));
    return { ...range, startMs };
  }
  const endMs = Math.round(Math.max(Math.min(durationMs, ms), range.startMs + min));
  return { ...range, endMs };
}

/** Seek to a specific time (milliseconds). */
export function seek(player: VideoPlayer, ms: number) {
  player.currentTime = ms / 1000;
}

/** 0:05, 1:02:03 (displays tenths of a second as 0:05.4). */
export function formatTime(ms: number, tenths = false, locale: Locale = 'en'): string {
  const total = Math.max(0, ms) / 1000;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const sec = new Intl.NumberFormat(localeTag(locale), {
    minimumIntegerDigits: 2,
    minimumFractionDigits: tenths ? 1 : 0,
    maximumFractionDigits: tenths ? 1 : 0,
    useGrouping: false,
  }).format(tenths ? s : Math.floor(s));
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

interface TrimState {
  index: number;
  ranges: TrimRange[];
  width: number;
  drag: { edge: 'start' | 'end'; from: number } | null;
  /** Most recently moved edge: playback stays on this side. */
  edge: 'start' | 'end' | null;
}

type TrimAction =
  | { type: 'layout'; width: number }
  | { type: 'grant'; x: number }
  | { type: 'move'; dx: number }
  | { type: 'end' }
  | { type: 'nudge'; edge: 'start' | 'end'; deltaMs: number }
  | { type: 'next' };

function reduce(state: TrimState, action: TrimAction, durations: number[]): TrimState {
  const duration = durations[state.index]!;
  const range = state.ranges[state.index]!;
  const replace = (next: TrimRange) => state.ranges.map((r, j) => (j === state.index ? next : r));
  const msPerPx = state.width > 0 ? duration / state.width : 0;
  switch (action.type) {
    case 'layout':
      return { ...state, width: action.width };
    case 'grant': {
      if (!msPerPx) return state;
      // Drag the edge closest to the finger.
      const ms = action.x * msPerPx;
      const edge = Math.abs(ms - range.startMs) <= Math.abs(ms - range.endMs) ? 'start' : 'end';
      return {
        ...state,
        edge,
        drag: { edge, from: edge === 'start' ? range.startMs : range.endMs },
      };
    }
    case 'move': {
      if (!state.drag || !msPerPx) return state;
      const next = moveEdge(
        range,
        state.drag.edge,
        state.drag.from + action.dx * msPerPx,
        duration,
      );
      return { ...state, ranges: replace(next) };
    }
    case 'end':
      return { ...state, drag: null };
    case 'nudge': {
      const at = action.edge === 'start' ? range.startMs : range.endMs;
      return {
        ...state,
        edge: action.edge,
        ranges: replace(moveEdge(range, action.edge, at + action.deltaMs, duration)),
      };
    }
    case 'next':
      return {
        ...state,
        index: Math.min(state.index + 1, durations.length - 1),
        drag: null,
        edge: null,
      };
  }
}

/** Top half: video frames, audio shown as icons (waveforms will be added later by the audio tool); bottom features "Play this segment only". */
function Preview({
  item,
  player,
  range,
  edge,
  palette,
  locale,
}: {
  item: RunItem;
  player: VideoPlayer;
  range: TrimRange;
  edge: 'start' | 'end' | null;
  palette: Palette;
  locale: 'en' | 'zh' | 'fr';
}) {
  const video = item.mimeType.startsWith('video/');
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });

  // When dragging, the view jumps along to that side.
  useEffect(() => {
    if (edge === null) return;
    player.pause();
    seek(player, edge === 'start' ? range.startMs : range.endMs);
  }, [player, edge, range.startMs, range.endMs]);

  // "Play only this segment": stops playing when reaching the end point.
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (player.playing && currentTime * 1000 >= range.endMs) player.pause();
  });

  return (
    <View style={styles.preview}>
      {video ? (
        <VideoView
          testID="trim-video"
          player={player}
          style={styles.video}
          contentFit="contain"
          nativeControls={false}
        />
      ) : (
        <View style={[styles.video, styles.center, { backgroundColor: palette.primaryTint }]}>
          <Icon name="audio" size={48} color={palette.primaryText} />
        </View>
      )}
      <Pressable
        testID="trim-play"
        onPress={() => {
          if (isPlaying) {
            player.pause();
            return;
          }
          seek(player, range.startMs);
          player.play();
        }}
        style={[styles.play, { borderColor: palette.border, borderRadius: palette.controlRadius }]}>
        <Text style={[palette.font('bodyBold', 15), { color: palette.primaryText }]}>
          {t(locale, isPlaying ? 'trimPause' : 'trimPlaySelection')}
        </Text>
      </Pressable>
    </View>
  );
}

/** Timeline thumbnails (video only). Uses load when expo-video cannot retrieve them (such as HDR video on Android). */
export function useThumbnails(
  player: VideoPlayer,
  item: RunItem,
  load: ((index: number, timesMs: number[]) => Promise<string[]>) | undefined,
  index: number,
): Thumb[] {
  // Record which file these thumbnails belong to: avoids clearing them in an effect when switching files.
  const [thumbs, setThumbs] = useState<{ uri: string; list: Thumb[] } | null>(null);
  const duration = item.durationMs ?? 0;
  const video = item.mimeType.startsWith('video/');
  const uri = item.uri;
  useEffect(() => {
    if (!video || duration <= 0) return;
    let alive = true;
    const times = Array.from({ length: THUMBS }, (_, i) => ((i + 0.5) * duration) / THUMBS / 1000);
    player
      .generateThumbnailsAsync(times, { maxWidth: 160 })
      .catch(async (e: unknown) => {
        if (!load) throw e;
        const files = await load(
          index,
          times.map((s) => s * 1000),
        );
        return files.map((file) => ({ uri: file }));
      })
      .then((list) => {
        if (alive) setThumbs({ uri, list });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [player, video, duration, uri, load, index]);
  return thumbs?.uri === uri ? thumbs.list : [];
}

/** Audio waveform: read after the interface opens (long recordings take a long time to decode on Android); undefined means still reading. */
function useWaveform(
  load: ((index: number) => Promise<number[] | null>) | undefined,
  index: number,
  audio: boolean,
): number[] | null | undefined {
  // Record which file this waveform belongs to: avoids clearing it in an effect when switching files.
  const [peaks, setPeaks] = useState<{ index: number; list: number[] | null } | null>(null);
  useEffect(() => {
    if (!audio || !load) return;
    let alive = true;
    load(index)
      .catch(() => null)
      .then((list) => {
        if (alive) setPeaks({ index, list });
      });
    return () => {
      alive = false;
    };
  }, [load, index, audio]);
  if (!audio || !load) return null;
  return peaks?.index === index ? peaks.list : undefined;
}

export function TrimScreen({
  input,
  palette,
  locale,
  onDone,
  onCancel,
}: LocalScreenProps<'trimMedia'>) {
  const { items } = input;
  const durations = items.map((it) => Math.max(1, it.durationMs ?? 1));
  const [state, dispatch] = useReducer(
    (s: TrimState, a: TrimAction) => reduce(s, a, durations),
    null,
    () => ({
      index: 0,
      ranges: durations.map((d) => ({ startMs: 0, endMs: d })),
      width: 0,
      drag: null,
      edge: null,
    }),
  );
  const { index, ranges, width } = state;
  const item = items[index]!;
  const range = ranges[index]!;
  const duration = durations[index]!;
  // Switch player when switching to the next file (useVideoPlayer is recreated with the URI).
  const player = useVideoPlayer(item.uri, (p) => {
    p.timeUpdateEventInterval = 0.1;
  });
  const thumbs = useThumbnails(player, item, input.loadThumbnails, index);
  const audio = item.mimeType.startsWith('audio/');
  const waveform = useWaveform(input.loadWaveform, index, audio);

  const [responder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => dispatch({ type: 'grant', x: e.nativeEvent.locationX }),
      onPanResponderMove: (_e, g) => dispatch({ type: 'move', dx: g.dx }),
      onPanResponderRelease: () => dispatch({ type: 'end' }),
      onPanResponderTerminate: () => dispatch({ type: 'end' }),
    }),
  );

  const last = index === items.length - 1;
  const left = (range.startMs / duration) * width;
  const right = (range.endMs / duration) * width;
  const nudge = (edge: 'start' | 'end', deltaMs: number, label: string) => (
    <Pressable
      testID={`trim-${edge}-${deltaMs > 0 ? 'plus' : 'minus'}`}
      onPress={() => dispatch({ type: 'nudge', edge, deltaMs })}
      hitSlop={6}
      style={[styles.nudge, { borderColor: palette.border, borderRadius: palette.controlRadius }]}>
      <Text style={[palette.font('bodyBold', 14), { color: palette.primaryText }]}>{label}</Text>
    </Pressable>
  );
  const edgeRow = (edge: 'start' | 'end') => (
    <View style={styles.edgeRow}>
      <Text style={[palette.font('body', 15), styles.edgeLabel, { color: palette.muted }]}>
        {t(locale, edge === 'start' ? 'trimStart' : 'trimEnd')}
      </Text>
      {nudge(edge, -NUDGE_MS, '−1s')}
      <Text
        testID={`trim-${edge}`}
        style={[palette.font('bodyBold', 17), styles.time, { color: palette.text }]}>
        {formatTime(edge === 'start' ? range.startMs : range.endMs, true, locale)}
      </Text>
      {nudge(edge, NUDGE_MS, '+1s')}
    </View>
  );

  return (
    <LocalFrame
      palette={palette}
      title={
        items.length > 1
          ? `${t(locale, 'trimTitle')} · ${t(locale, 'trimOf', { n: index + 1, total: items.length })}`
          : t(locale, 'trimTitle')
      }
      cancelLabel={t(locale, 'cancel')}
      doneLabel={t(locale, last ? 'trimDone' : 'trimNext')}
      onCancel={onCancel}
      onDone={() => {
        if (!last) return dispatch({ type: 'next' });
        onDone(ranges);
      }}>
      <Preview
        key={item.uri}
        item={item}
        player={player}
        range={range}
        edge={state.edge}
        palette={palette}
        locale={locale}
      />
      <View style={styles.controls}>
        <Text style={[palette.font('body', 14), { color: palette.caption }]}>
          {t(locale, 'trimHint')}
        </Text>
        <View
          testID="trim-timeline"
          style={[styles.timeline, { backgroundColor: palette.primaryTint }]}
          onLayout={(e) => dispatch({ type: 'layout', width: e.nativeEvent.layout.width })}
          {...responder.panHandlers}>
          <View style={styles.strip} pointerEvents="none">
            {thumbs.map((thumb, i) => (
              <Image key={i} source={thumb} style={styles.thumb} contentFit="cover" />
            ))}
            {waveform ? <Waveform peaks={waveform} color={palette.primary} /> : null}
            {waveform === undefined ? (
              <View style={[styles.waveform, styles.center]}>
                <Text
                  testID="trim-waveform-loading"
                  style={[palette.font('body', 13), { color: palette.caption }]}>
                  {t(locale, 'trimWaveformLoading')}
                </Text>
              </View>
            ) : null}
          </View>
          {width > 0 ? (
            <>
              <View pointerEvents="none" style={[styles.dim, { left: 0, width: left }]} />
              <View
                pointerEvents="none"
                style={[styles.dim, { left: right, width: Math.max(0, width - right) }]}
              />
              <View
                pointerEvents="none"
                style={[
                  styles.selection,
                  { left, width: Math.max(0, right - left), borderColor: palette.primary },
                ]}
              />
              <View
                pointerEvents="none"
                style={[
                  styles.handle,
                  { left: left - HANDLE / 2, backgroundColor: palette.primary },
                ]}
              />
              <View
                pointerEvents="none"
                style={[
                  styles.handle,
                  { left: right - HANDLE / 2, backgroundColor: palette.primary },
                ]}
              />
            </>
          ) : null}
        </View>
        {edgeRow('start')}
        {edgeRow('end')}
        <Text
          testID="trim-length"
          style={[palette.font('bodyMedium', 15), { color: palette.muted, textAlign: 'center' }]}>
          {t(locale, 'trimLength', {
            length: formatTime(range.endMs - range.startMs, true, locale),
          })}
        </Text>
        {audio ? (
          <Text style={[palette.font('body', 13), { color: palette.caption, textAlign: 'center' }]}>
            {t(locale, 'trimRingtone')}
          </Text>
        ) : null}
      </View>
    </LocalFrame>
  );
}

/** Audio waveform: each bar represents the maximum volume over a short time interval (0-1). */
function Waveform({ peaks, color }: { peaks: readonly number[]; color: string }) {
  return (
    <View testID="trim-waveform" style={styles.waveform}>
      {peaks.map((p, i) => (
        <View
          key={i}
          style={[styles.peak, { height: `${Math.max(6, p * 100)}%`, backgroundColor: color }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { flex: 1, paddingHorizontal: 16, gap: 10 },
  video: { flex: 1, backgroundColor: '#000000', borderRadius: 8 },
  center: { alignItems: 'center', justifyContent: 'center' },
  play: { alignSelf: 'center', paddingHorizontal: 18, paddingVertical: 8, borderWidth: 1 },
  strip: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    borderRadius: 8,
    overflow: 'hidden',
  },
  thumb: { flex: 1 },
  waveform: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 1, paddingHorizontal: 2 },
  peak: { flex: 1, borderRadius: 1, opacity: 0.7 },
  controls: { paddingHorizontal: 16, paddingTop: 12, gap: 10 },
  // Inset an extra 24 on left and right: places handles 40 from the screen edge, keeping them out of Android's back gesture zone (dragging inward from the edge closes the page).
  timeline: { height: 52, borderRadius: 8, marginHorizontal: 24 },
  dim: { position: 'absolute', top: 0, bottom: 0, backgroundColor: '#00000055' },
  selection: { position: 'absolute', top: 0, bottom: 0, borderTopWidth: 3, borderBottomWidth: 3 },
  handle: { position: 'absolute', top: -4, bottom: -4, width: HANDLE, borderRadius: 6 },
  edgeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  edgeLabel: { width: 48 },
  time: { flex: 1, textAlign: 'center', fontVariant: ['tabular-nums'] },
  nudge: { paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1 },
});
