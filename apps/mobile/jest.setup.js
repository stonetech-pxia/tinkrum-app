// Native gestures use official Jest mock; Worklets do not create a real UI runtime.
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
require('react-native-gesture-handler/jestSetup');
/* global jest */
// No native modules in Jest: WebView (pack pages) is replaced by an empty component. Pack logic is tested via a mock PackRuntime in tests.
jest.mock('react-native-webview', () => {
  const { View } = require('react-native');
  return { WebView: View, default: View };
});

// Skia (signature pad, collage, QR code) is also a native module: UI is replaced with an empty component, and offscreen rendering is unavailable in tests (handled by injected platform capability mocks).
jest.mock('@shopify/react-native-skia', () => {
  const { View } = require('react-native');
  const unavailable = () => {
    throw new Error('Skia is not available in tests');
  };
  return {
    Canvas: View,
    Path: () => null,
    Text: () => null,
    Image: () => null,
    Rect: () => null,
    Circle: () => null,
    Group: View,
    Paragraph: () => null,
    DashPathEffect: () => null,
    useFont: () => null,
    ImageFormat: { JPEG: 3, PNG: 4, WEBP: 6 },
    Skia: new Proxy({}, { get: () => unavailable }),
    matchFont: unavailable,
  };
});

// Charts (Victory Native XL, D-438) rendered via Skia are absent in Jest: rendering parts use an empty component, while touch layers are standard React Native components and tested normally.
jest.mock('victory-native', () => ({
  CartesianChart: () => null,
  Bar: () => null,
  Line: () => null,
}));

// Video playback (expo-video) is also a native module: visuals are replaced by an empty component while the player records state only (trimming, result page playback).
jest.mock('expo-video', () => {
  const React = require('react');
  const { View } = require('react-native');
  const makePlayer = (source) => {
    const listeners = new Map();
    const emit = (name, payload) => listeners.get(name)?.forEach((fn) => fn(payload));
    return {
      source,
      playing: false,
      currentTime: 0,
      timeUpdateEventInterval: 0,
      play() {
        this.playing = true;
        emit('playingChange', { isPlaying: true });
      },
      pause() {
        this.playing = false;
        emit('playingChange', { isPlaying: false });
      },
      generateThumbnailsAsync: async () => [],
      addListener(name, fn) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
        return { remove: () => listeners.get(name)?.delete(fn) };
      },
      removeListener(name, fn) {
        listeners.get(name)?.delete(fn);
      },
      release() {},
    };
  };
  return {
    VideoView: View,
    createVideoPlayer: makePlayer,
    useVideoPlayer: (source, setup) =>
      React.useMemo(() => {
        const player = makePlayer(source);
        setup?.(player);
        return player;
        // Rebuilt on address change just like the real one; setup is called only once upon creation.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [source]),
  };
});

// expo-audio (audio recording, D-154): mock recorder. Duration increments by 1 second on each state
// read after record(); stop() writes out a small file path. global.__audioPermission can be set to
// false to test "no microphone permission".
jest.mock('expo-audio', () => {
  const React = require('react');
  const makeRecorder = () => {
    const recorder = {
      uri: null,
      isRecording: false,
      durationMillis: 0,
      async prepareToRecordAsync() {
        this.uri = 'file:///cache/ExpoAudio/recording.m4a';
      },
      record() {
        this.isRecording = true;
      },
      pause() {
        this.isRecording = false;
      },
      async stop() {
        this.isRecording = false;
      },
    };
    return recorder;
  };
  return {
    AudioQuality: { MIN: 0, LOW: 32, MEDIUM: 64, HIGH: 96, MAX: 127 },
    IOSOutputFormat: { MPEG4AAC: 'aac ' },
    useAudioRecorder: () => React.useMemo(makeRecorder, []),
    useAudioRecorderState: (recorder) => {
      const [, tick] = React.useState(0);
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (recorder.isRecording) {
            recorder.durationMillis += 1000;
            tick((n) => n + 1);
          }
        }, 200);
        return () => clearInterval(timer);
      }, [recorder]);
      return {
        canRecord: true,
        isRecording: recorder.isRecording,
        durationMillis: recorder.durationMillis,
        fileSize: 0,
        mediaServicesDidReset: false,
        metering: recorder.isRecording ? -20 : undefined,
        url: recorder.uri,
      };
    },
    requestRecordingPermissionsAsync: async () => ({
      granted: global.__audioPermission !== false,
      status: global.__audioPermission !== false ? 'granted' : 'denied',
    }),
    setAudioModeAsync: async () => undefined,
  };
});
