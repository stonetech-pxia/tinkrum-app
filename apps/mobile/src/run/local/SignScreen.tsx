import { Canvas, ImageFormat, Path, Skia } from '@shopify/react-native-skia';
import { Image } from 'expo-image';
import { useEffect, useReducer, useRef, useState } from 'react';
import { PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { t } from '../../i18n';
import type { LocalScreenProps } from '../RunScreen';
import { useWorkspaceContext } from '../../workspace/context';
import type { SavedSignature } from '../../runtime/platform';
import { nearestLine, type LineBox } from './annotation-state';
import { LocalFrame } from './LocalFrame';
import {
  initialPlacement,
  reducePlacement,
  type SignAction,
  type SignPlacement,
} from './sign-placement';

// Sign (TOOLS_DESIGN §4 sign): step one draws on the signature pad (can be saved for direct reuse
// next time), step two selects a page and drags the signature into position. Signatures are stored
// in documentDirectory/signatures/, excluded from configuration and versioning, and never sent to
// the AI.

const PAD = { width: 320, height: 140 };
const STROKE = 3.2;

/** Taps on "Done" within this duration after "Place signature" appears are treated as a double-tap and ignored. */
const DOUBLE_TAP_MS = 600;

type Signature = { bytes: Uint8Array; aspect: number; uri?: string };

/** A single stroke: a sequence of points. */
type Stroke = { x: number; y: number }[];

/** Strokes → SVG path string (used by Skia's Path component and off-screen rendering). */
const svgOf = (strokes: Stroke[]) =>
  strokes
    .map((s) =>
      s.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '),
    )
    .join(' ');

/** Signature pad: finger draws lines, results rendered off-screen into a transparent PNG via Skia (retaining only regions with strokes). */
function SignaturePad({
  onChange,
  clearSignal,
}: {
  onChange: (strokes: Stroke[]) => void;
  clearSignal: number;
}) {
  const [strokes, dispatch] = useReducer(
    (
      state: Stroke[],
      action: { type: 'start' | 'move'; x: number; y: number } | { type: 'clear' },
    ) => {
      if (action.type === 'clear') return [];
      const point = { x: action.x, y: action.y };
      // Ensure single points remain visible: place two nearly overlapping points at the start of a stroke.
      if (action.type === 'start')
        return [...state, [point, { x: point.x + 0.1, y: point.y + 0.1 }]];
      const last = state[state.length - 1];
      if (!last) return state;
      return [...state.slice(0, -1), [...last, point]];
    },
    [],
  );
  useEffect(() => onChange(strokes), [strokes, onChange]);
  useEffect(() => {
    if (clearSignal) dispatch({ type: 'clear' });
  }, [clearSignal]);
  const [responder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) =>
        dispatch({ type: 'start', x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }),
      onPanResponderMove: (e) =>
        dispatch({ type: 'move', x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }),
    }),
  );
  return (
    <View testID="signature-pad" style={styles.pad} {...responder.panHandlers}>
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        {strokes.length > 0 ? (
          <Path
            path={svgOf(strokes)}
            style="stroke"
            strokeWidth={STROKE}
            strokeCap="round"
            strokeJoin="round"
            color="#1A1A2E"
          />
        ) : null}
      </Canvas>
    </View>
  );
}

/** Render strokes into a transparent background PNG (3x clarity, cropped to stroke bounds). */
function strokesToPng(strokes: Stroke[]): { bytes: Uint8Array; aspect: number } | null {
  if (strokes.length === 0) return null;
  const all = Skia.Path.MakeFromSVGString(svgOf(strokes));
  if (!all) return null;
  const b = all.computeTightBounds();
  const margin = STROKE * 2;
  const scale = 3;
  const width = Math.ceil((b.width + margin * 2) * scale);
  const height = Math.ceil((b.height + margin * 2) * scale);
  const surface = Skia.Surface.MakeOffscreen(Math.max(1, width), Math.max(1, height));
  if (!surface) return null;
  const canvas = surface.getCanvas();
  canvas.scale(scale, scale);
  canvas.translate(margin - b.x, margin - b.y);
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('#1A1A2E'));
  paint.setStyle(1); // Stroke
  paint.setStrokeWidth(STROKE);
  paint.setStrokeCap(1); // Round
  paint.setStrokeJoin(1); // Round
  paint.setAntiAlias(true);
  canvas.drawPath(all, paint);
  surface.flush();
  const bytes = surface.makeImageSnapshot().encodeToBytes(ImageFormat.PNG, 100);
  return { bytes, aspect: width / height };
}

export function SignScreen({ input, palette, locale, onDone, onCancel }: LocalScreenProps<'sign'>) {
  const { files } = useWorkspaceContext();
  const [saved, setSaved] = useState<SavedSignature[] | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [clear, setClear] = useState(0);
  useEffect(() => {
    void files.loadSignatures().then(setSaved);
  }, [files]);
  const [keep, setKeep] = useState(true);
  const [signature, setSignature] = useState<Signature | null>(null);
  /** Moment signature was chosen: taps right when "Place signature" appears do not count as "Done" (D-512). */
  const chosenAt = useRef(0);
  const [pageIndex, setPageIndex] = useState(input.pages.length - 1);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const page = input.pages[pageIndex]!;
  const scale = box.width ? Math.min(box.width / page.width, box.height / page.height) : 0;
  const shown = { width: page.width * scale, height: page.height * scale };

  // Signature position on the page (proportional coordinates): tapping the page places it on that line, with height determined by that line of text (sign-placement.ts).
  const aspect = signature?.aspect ?? 3;
  const [placement, move] = useReducer(
    (state: SignPlacement, action: SignAction) => reducePlacement(state, action, page, aspect),
    null,
    () => initialPlacement(page, aspect),
  );
  const place = placement.place;
  useEffect(() => {
    move({ type: 'layout', width: shown.width, height: shown.height });
  }, [shown.width, shown.height]);
  useEffect(() => {
    if (signature) move({ type: 'reset' });
  }, [signature]);
  // Lines recognized on this page (original image points): recognized locally only, used solely to determine signature height, neither stored nor sent.
  const lines = useRef(new Map<number, readonly LineBox[]>());
  useEffect(() => {
    if (!signature || !input.lines || lines.current.has(pageIndex)) return;
    const at = pageIndex;
    lines.current.set(at, []);
    void input.lines(at).then(
      (found) => lines.current.set(at, found),
      () => undefined,
    );
  }, [signature, pageIndex, input]);

  const [mover] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => move({ type: 'grant' }),
      onPanResponderMove: (_e, g) => move({ type: 'move', dx: g.dx, dy: g.dy }),
    }),
  );

  // Step 1: choose a saved signature or draw a new one.
  if (!signature) {
    return (
      <LocalFrame
        palette={palette}
        title={t(locale, 'SignScreen_Signature_4843e')}
        cancelLabel={t(locale, 'cancel')}
        doneLabel={t(locale, 'SignScreen_Next_aa103')}
        doneDisabled={strokes.length === 0}
        onCancel={onCancel}
        onDone={() => {
          const png = strokesToPng(strokes);
          if (!png) return;
          if (keep) void files.saveSignature(png.bytes, png.aspect);
          chosenAt.current = Date.now();
          setSignature(png);
        }}>
        <ScrollView contentContainerStyle={styles.step}>
          {saved && saved.length > 0 ? (
            <>
              <Text style={[palette.font('bodyBold', 15), { color: palette.text }]}>
                {t(locale, 'SignScreen_Use_a_saved_signature_56e73')}
              </Text>
              <View style={styles.savedRow}>
                {saved.map((s) => (
                  <Pressable
                    key={s.uri}
                    testID="signature-saved"
                    onPress={() => {
                      chosenAt.current = Date.now();
                      setSignature({ bytes: s.bytes, aspect: s.aspect, uri: s.uri });
                    }}
                    style={[
                      styles.saved,
                      { borderColor: palette.border, backgroundColor: '#FFFFFF' },
                    ]}>
                    <Image source={{ uri: s.uri }} style={styles.savedImage} contentFit="contain" />
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}
          <Text style={[palette.font('bodyBold', 15), { color: palette.text }]}>
            {t(locale, 'SignScreen_Sign_below_ee862')}
          </Text>
          <SignaturePad onChange={setStrokes} clearSignal={clear} />
          <View style={styles.row}>
            <Pressable testID="signature-clear" onPress={() => setClear((c) => c + 1)}>
              <Text style={[palette.font('bodyBold', 15), { color: palette.primaryText }]}>
                {t(locale, 'SignScreen_Clear_643ff')}
              </Text>
            </Pressable>
            <Pressable testID="signature-keep" onPress={() => setKeep((k) => !k)}>
              <Text style={[palette.font('body', 15), { color: palette.text }]}>
                {`${keep ? '☑' : '☐'} ${t(locale, 'SignScreen_Keep_for_next_time_on_this_device_only_e4001')}`}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </LocalFrame>
    );
  }

  // Step 2: select page, drag into position, adjust size.
  return (
    <LocalFrame
      palette={palette}
      title={t(locale, 'SignScreen_Place_signature_f02ea')}
      cancelLabel={t(locale, 'cancel')}
      doneLabel={t(locale, 'localDone')}
      onCancel={onCancel}
      onDone={() => {
        // If the user rapidly double-taps "Next", and the second tap lands on "Done" at the same position, the placement step is skipped (2026-11-09 user re-test).
        if (Date.now() - chosenAt.current < DOUBLE_TAP_MS) return;
        onDone({ png: signature.bytes, pageIndex, ...place });
      }}>
      <Text style={[palette.font('body', 13), styles.hint, { color: palette.muted }]}>
        {t(locale, 'signTapHint')}
      </Text>
      <View style={styles.pageNav}>
        <Pressable
          testID="sign-prev"
          disabled={pageIndex === 0}
          onPress={() => setPageIndex((i) => Math.max(0, i - 1))}>
          <Text
            style={[
              palette.font('bodyBold', 18),
              { color: pageIndex === 0 ? palette.caption : palette.text },
            ]}>
            ‹
          </Text>
        </Pressable>
        <Text style={[palette.font('bodyMedium', 15), { color: palette.text }]}>
          {t(locale, 'SignScreen_Page_of_75351', { v0: pageIndex + 1, v1: input.pages.length })}
        </Text>
        <Pressable
          testID="sign-next"
          disabled={pageIndex === input.pages.length - 1}
          onPress={() => setPageIndex((i) => Math.min(input.pages.length - 1, i + 1))}>
          <Text
            style={[
              palette.font('bodyBold', 18),
              { color: pageIndex === input.pages.length - 1 ? palette.caption : palette.text },
            ]}>
            ›
          </Text>
        </Pressable>
      </View>
      <View
        style={styles.pageArea}
        onLayout={(e) =>
          setBox({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })
        }>
        {scale > 0 ? (
          <View style={[shown, styles.page]}>
            <Pressable
              testID="sign-page"
              accessibilityLabel={t(locale, 'signTapHint')}
              onPress={(e) => {
                const { locationX: x, locationY: y } = e.nativeEvent;
                const line =
                  scale > 0
                    ? nearestLine(lines.current.get(pageIndex) ?? [], {
                        x: x / scale,
                        y: y / scale,
                      })
                    : undefined;
                move({ type: 'tap', x, y, ...(line ? { lineHeight: line.height } : {}) });
              }}>
              <Image source={{ uri: page.uri }} style={shown} contentFit="fill" />
            </Pressable>
            <View
              testID="sign-mark"
              {...mover.panHandlers}
              style={[
                styles.mark,
                {
                  left: place.x * shown.width,
                  top: place.y * shown.height,
                  width: place.width * shown.width,
                  height: (place.width * shown.width) / signature.aspect,
                  borderColor: palette.primary,
                },
              ]}>
              <Image
                source={{ uri: `data:image/png;base64,${toBase64(signature.bytes)}` }}
                style={StyleSheet.absoluteFill}
                contentFit="contain"
              />
            </View>
          </View>
        ) : null}
      </View>
      <View style={styles.row}>
        {[0.2, 0.32, 0.45].map((w) => (
          <Pressable
            key={w}
            testID={`sign-size-${w}`}
            onPress={() => move({ type: 'size', width: w })}
            style={[
              styles.size,
              { borderColor: place.width === w ? palette.primary : palette.border },
            ]}>
            <Text style={[palette.font('bodyBold', 14), { color: palette.text }]}>
              {w === 0.2
                ? t(locale, 'SignScreen_S_c6a9b')
                : w === 0.32
                  ? t(locale, 'SignScreen_M_e9efc')
                  : t(locale, 'SignScreen_L_56d2b')}
            </Text>
          </Pressable>
        ))}
        <Text style={[palette.font('body', 13), { color: palette.muted }]}>
          {t(locale, 'SignScreen_Drag_the_signature_to_move_it_f7c5b')}
        </Text>
      </View>
    </LocalFrame>
  );
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const styles = StyleSheet.create({
  step: { padding: 20, gap: 14 },
  pad: {
    width: PAD.width,
    height: PAD.height,
    alignSelf: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D8D0C6',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 20,
    flexWrap: 'wrap',
  },
  savedRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  saved: { width: 140, height: 64, borderWidth: 1, borderRadius: 10, padding: 6 },
  savedImage: { width: '100%', height: '100%' },
  hint: { paddingHorizontal: 16 },
  pageNav: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 24,
    paddingBottom: 8,
  },
  pageArea: { flex: 1, marginHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  page: {
    backgroundColor: '#FFFFFF',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  mark: { position: 'absolute', borderWidth: 1.5, borderStyle: 'dashed' },
  size: { borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
});
