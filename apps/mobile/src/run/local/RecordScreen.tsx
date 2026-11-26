import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '../../i18n';
import type { Palette } from '../../renderer/theme';
import type { LocalScreenProps } from '../RunScreen';
import { LocalFrame } from './LocalFrame';
import { formatTime } from './TrimScreen';

// Voice recording (D-154): large button for start / pause / resume, timer and level meter;
// continues recording after lock screen (expo-audio background recording in app.json: iOS
// background audio, Android foreground service and "Recording" notification). Recorded as M4A (AAC
// mono 64 kbps, ~28 MB per hour), handed to the next step upon completion; recording stays local.
// "Stop" on that Android notification is the same as "Done" (D-653).

/** Voice recording: mono 64 kbps is clear enough and convenient for subsequent speech-to-text. */
export const VOICE_RECORDING: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  isMeteringEnabled: true,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: 'audio/webm', bitsPerSecond: 64000 },
};

/** Audio level (dB, -160 to 0) to 0–1: below -50 dB is considered silent. */
export const levelOf = (db: number | undefined) =>
  db === undefined ? 0 : Math.max(0, Math.min(1, (db + 50) / 50));

type Phase = 'idle' | 'recording' | 'paused';

export function RecordScreen({
  input,
  palette,
  locale,
  onDone,
  onCancel,
}: LocalScreenProps<'record'>) {
  // The last duration read: a stop from outside resets the recorder to 0.
  const length = useRef(0);
  // True once the screen stops the recorder itself; any other finished status is the notification's.
  const stopping = useRef(false);
  const recorder = useAudioRecorder(VOICE_RECORDING, (status) => {
    if (!status.isFinished || stopping.current || !status.url) return;
    const uri = status.url;
    // Timers sleep in the background, so the last reading may be far too short there.
    const durationMs = AppState.currentState === 'background' ? undefined : length.current;
    void silence().then(() => hand(uri, durationMs));
  });
  const state = useAudioRecorderState(recorder, 200);
  if (state.durationMillis > 0) length.current = state.durationMillis;
  const [phase, setPhase] = useState<Phase>('idle');
  const [denied, setDenied] = useState(false);
  const [failed, setFailed] = useState(false);
  // Start recording immediately upon opening, tap once to stop and continue (in.audio autoStart, D-587).
  const quick = input.autoStart === true;
  const starting = useRef(false);

  async function start() {
    if (starting.current) return;
    starting.current = true;
    try {
      await begin();
    } finally {
      starting.current = false;
    }
  }

  async function begin() {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setDenied(true);
      return;
    }
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        allowsBackgroundRecording: true,
      });
      try {
        await recorder.prepareToRecordAsync();
      } catch {
        // Right after finishing a recording and starting another, expo-audio's background recording
        // service is shutting down, occasionally failing to connect within 5 seconds (Samsung
        // SM-S948B test: 3 out of 8 consecutive recordings failed), so waiting briefly before
        // retrying resolves it.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await recorder.prepareToRecordAsync();
      }
      recorder.record();
      setFailed(false);
      setPhase('recording');
    } catch {
      // No microphone (simulator, occupied by another app): report it so the user can retry.
      setFailed(true);
    }
  }

  useEffect(() => {
    if (quick) void start();
    // Start only once upon opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle() {
    if (phase === 'idle') return void start();
    // For auto-start recordings: while recording, this button acts as "Stop and continue", directly handing over to the next step.
    if (quick && phase === 'recording') return void finish();
    if (phase === 'recording') {
      recorder.pause();
      setPhase('paused');
    } else {
      recorder.record();
      setPhase('recording');
    }
  }

  async function silence() {
    await setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false }).catch(
      () => undefined,
    );
  }

  async function stop() {
    stopping.current = true;
    await recorder.stop();
    await silence();
    return recorder.uri;
  }

  async function finish() {
    const durationMs = state.durationMillis;
    const uri = await stop();
    if (!uri) return onCancel();
    hand(uri, durationMs);
  }

  function hand(uri: string, durationMs: number | undefined) {
    const file = new File(uri);
    onDone({
      uri,
      name: `${input.name}.m4a`,
      size: file.exists ? file.size : null,
      mimeType: 'audio/mp4',
      durationMs,
    });
  }

  function cancel() {
    if (phase === 'idle') return onCancel();
    Alert.alert(t(locale, 'recordDiscardTitle'), undefined, [
      { text: t(locale, 'recordKeep'), style: 'cancel' },
      {
        text: t(locale, 'recordDiscard'),
        style: 'destructive',
        onPress: () => {
          void stop().then((uri) => {
            if (uri) {
              const file = new File(uri);
              if (file.exists) file.delete();
            }
            onCancel();
          });
        },
      },
    ]);
  }

  const level = phase === 'recording' ? levelOf(state.metering) : 0;
  const label =
    phase === 'idle'
      ? 'recordStart'
      : phase === 'recording'
        ? quick
          ? 'recordStopGo'
          : 'recordPause'
        : 'recordResume';
  return (
    <LocalFrame
      palette={palette}
      title={t(locale, 'recordTitle')}
      cancelLabel={t(locale, 'cancel')}
      doneLabel={t(locale, 'recordDone')}
      doneDisabled={phase === 'idle' || state.durationMillis <= 0}
      onCancel={cancel}
      onDone={() => void finish()}>
      <View style={styles.body}>
        <Text
          testID="record-time"
          style={[palette.font('title', 56), styles.time, { color: palette.text }]}>
          {formatTime(state.durationMillis, false, locale)}
        </Text>
        <Meter level={level} palette={palette} />
        <Pressable
          testID="record-toggle"
          accessibilityRole="button"
          accessibilityLabel={t(locale, label)}
          onPress={toggle}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: phase === 'recording' ? palette.primaryTint : palette.primary,
              borderColor: palette.primary,
              opacity: pressed ? 0.8 : 1,
            },
          ]}>
          <Text
            style={[
              palette.font('bodyBold', 18),
              { color: phase === 'recording' ? palette.primaryText : palette.onPrimary },
            ]}>
            {t(locale, label)}
          </Text>
        </Pressable>
        <Text style={[palette.font('body', 15), styles.hint, { color: palette.caption }]}>
          {denied
            ? t(locale, 'runError_permissionDenied', { what: t(locale, 'recordMicrophone') })
            : failed
              ? t(locale, 'recordFailed')
              : t(locale, 'recordHint')}
        </Text>
      </View>
    </LocalFrame>
  );
}

/** Level meter: 20 bars, lit up based on current volume level. */
function Meter({ level, palette }: { level: number; palette: Palette }) {
  const lit = Math.round(level * 20);
  return (
    <View testID="record-meter" style={styles.meter}>
      {Array.from({ length: 20 }, (_, i) => (
        <View
          key={i}
          style={[
            styles.bar,
            {
              height: 8 + i * 2,
              backgroundColor: i < lit ? palette.primary : palette.border,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 28, padding: 24 },
  time: { fontVariant: ['tabular-nums'] },
  meter: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 50 },
  bar: { width: 8, borderRadius: 3 },
  button: {
    width: 180,
    height: 180,
    borderRadius: 90,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: { textAlign: 'center' },
});
