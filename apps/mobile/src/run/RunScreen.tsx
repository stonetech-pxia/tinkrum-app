import { useRunHost } from '../desk/useRunHost';
import {
  calendarOf,
  stepLabel,
  isFileValue,
  type AskedAnswer,
  type HandedFiles,
  type RunResult,
  type RunValue,
  type Workflow,
} from '@morph/core';

import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { workflowEntry } from '../shell/ai-entry';
import { runErrorText, t } from '../i18n';
import { Icon } from '../renderer/Icon';
import { usePalette, type Palette } from '../renderer/theme';
import { Button, Card } from '../renderer/ui';
import { saveItems } from '../runtime/actions/io';
import type { LocalKind, LocalSteps } from '../runtime/local';
import { granteeOf, isBackgroundAction, newAssetId, startRun, type Run } from '../runtime/runner';
import { usePacks } from '../packs/PackHost';
import { useFileBundleOffer } from '../packs/FileBundleOffer';
import { copyResults, releaseShare, useIncoming, type IncomingShare } from '../share/incoming';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '../workspace/context';
import { clearDesk, placeResultsOnDesk } from '../desk/store';
import { ChainCard } from './ChainCard';
import { HabitCard } from './HabitCard';
import { canEditTable, canEditWord } from './office-items';
import { ResultView } from './ResultView';

// Run page (TOOLS_DESIGN §3): progress of each step, cancellation, runtime prompts, local operation
// interface, result preview. Starts running immediately upon opening; cancels and deletes temporary
// files for this run upon closing.

export interface LocalScreenProps<K extends LocalKind> {
  input: LocalSteps[K]['in'];
  palette: Palette;
  locale: 'en' | 'zh' | 'fr';
  onDone: (out: LocalSteps[K]['out']) => void;
  onCancel: () => void;
}

/** Duration of the run page pop-up animation (iOS modal is approx. 350 ms). */
const START_DELAY_MS = 450;

export function RunScreen({
  workflow,
  onEdit,
  onAskAI,
  incoming,
  keepIncoming,
  thenDesk,
  handed,
}: {
  workflow: Workflow;
  onEdit?: () => void;
  /** "Ask AI to modify this": open AI modification with this quick action (D-126). */
  onAskAI?: () => void;
  /** Files shared in (D-115): use them for the first step without opening the picker. Deleted when closing the run page. */
  incoming?: IncomingShare;
  /** Opened from the preview page (D-457): do not delete received files upon closing, returning goes back to the preview page and the files remain. */
  keepIncoming?: boolean;
  /** "Convert to Word" from the preview page (D-457): place directly on the desk for editing after creation, returning discards this Word document. */
  thenDesk?: boolean;
  /** Value passed by the container (D-428): this entry on the records page, the value of this field, records selected from a list. */
  handed?: RunValue | HandedFiles;
}) {
  const { repo, files, registry, locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config!);
  const theme = useAppTheme(config);
  const collections = useWorkspace((s) => s.config!.data.tables);
  const calendarSettings = useWorkspace((s) => s.config!.data.calendar);
  const revisionId = useWorkspace((s) => s.head!.id);
  const bumpAssets = useWorkspace((s) => s.bumpAssets);
  const bumpRecords = useWorkspace((s) => s.bumpRecords);
  const palette = usePalette(theme);
  const router = useRouter();
  // Starts running immediately upon opening, so the initial state is step 1.
  const [current, setCurrent] = useState<{
    index: number;
    done?: number;
    total?: number;
    unit?: 'percent';
    items?: number;
    images?: boolean;
  } | null>({
    index: 0,
  });
  const [outcome, setOutcome] = useState<RunResult | null>(null);
  const host = useRunHost(palette, locale);
  const packs = usePacks();
  const bundle = useFileBundleOffer(palette, locale);
  const alive = useRef(true);
  const transferring = useRef(false);
  const [transferBusy, setTransferBusy] = useState(false);
  // Failed to transition into the preview page: remain on the results page as usual.
  const [noPreview, setNoPreview] = useState(false);
  const signal = useRef({ cancelled: false });
  const run = useRef<Run | null>(null);
  // Answers to "ask at runtime" during this run, the results page proposes turning them into a quick action based on this (D-127).
  const answers = useRef<AskedAnswer[]>([]);
  const [runCount, setRunCount] = useState(0);
  // Fallback to picking from the photo library this time when the camera is unavailable (D-508): only changes the source for this single run, does not modify the quick action itself.
  const [fromLibrary, setFromLibrary] = useState(false);
  const shown = fromLibrary ? fromPhotoLibrary(workflow) : workflow;
  const label = (action: string, index: number) =>
    incoming && index === 0
      ? t(locale, 'shareInputStep', { n: incoming.files.length })
      : (stepLabel(registry.actions.get(action), shown.steps[index]?.params, locale) ?? action);

  /**
   * Progress text for the current step (D-276): report percentages as percentages; when
   * processing multiple files and progress is reported by file count, write "nth/N" (the one
   * currently being processed, so show 1st even before the first one finishes); for other counts,
   * write "done/total".
   */
  function progressText(c: NonNullable<typeof current>): string {
    if (c.unit === 'percent' && c.total) {
      return `  ${t(locale, 'runPercent', { done: c.done ?? 0, total: c.total })}`;
    }
    if (c.items && c.items > 1 && (c.total === undefined || c.total === c.items)) {
      const n = Math.min((c.done ?? 0) + 1, c.items);
      return ` · ${t(locale, c.images ? 'runItemImage' : 'runItemFile', { n, total: c.items })}`;
    }
    return c.total ? `  ${t(locale, 'runProgress', { done: c.done ?? 0, total: c.total })}` : '';
  }

  /** "Run again": clear the previous results and run again. library: fallback to selecting photos from the photo library this time (D-508). */
  async function restart(library = false) {
    signal.current = { cancelled: false };
    setFromLibrary(library);
    setOutcome(null);
    setCurrent({ index: 0 });
    await run.current?.dispose();
    run.current = null;
    await execute(library ? fromPhotoLibrary(workflow) : workflow);
  }

  async function execute(use: Workflow = workflow) {
    answers.current = [];
    const started = await startRun({
      workflow: use,
      revisionId,
      repo,
      files,
      registry,
      locale,
      now: () => new Date(),
      newId: newAssetId,
      ui: host.ui,
      collections,
      calendar: calendarOf({ data: { tables: [], calendar: calendarSettings } }),
      packs: host.packs,
      ensurePacks: host.ensurePacks,
      ensurePack: host.ensurePack,
      signal: signal.current,
      incoming: incoming?.files ?? null,
      handed: handed ?? null,
      askParams: async (request) => {
        const answer = await host.askParams(request);
        if (answer) {
          // Passwords are not retained (D-194).
          const secret = (k: string) =>
            request.action.fields.find((f) => f.key === k)?.kind === 'secret';
          const values = Object.fromEntries(
            request.keys.filter((k) => k in answer && !secret(k)).map((k) => [k, answer[k]]),
          );
          answers.current.push({ stepId: request.step.id, values });
        }
        return answer;
      },
      onEvent: (e) =>
        setCurrent((prev) =>
          e.kind === 'step'
            ? {
                index: e.index,
                ...(e.items !== undefined ? { items: e.items, images: e.images === true } : {}),
              }
            : {
                // Retain how many files need to be processed in this step if it matches the previous step (needed for "nth/N").
                ...(prev?.index === e.index && prev.items !== undefined
                  ? { items: prev.items, images: prev.images }
                  : {}),
                index: e.index,
                done: e.done,
                total: e.total,
                ...(e.unit ? { unit: e.unit } : {}),
              },
        ),
    });
    if (!alive.current) {
      await started.dispose();
      return;
    }
    run.current = started;
    setCurrent(null);
    setOutcome(started.result);
    setRunCount((n) => n + 1);
    if (started.result.status === 'succeeded' && started.result.saved.length > 0) bumpAssets();
    // After the initial scan completes, or after processing shared-in files: prompt for the file processing pack all at once (D-456).
    if (
      started.result.status === 'succeeded' &&
      (incoming || workflow.steps.some((s) => s.action.startsWith('scan.')))
    )
      bundle.offer();
    const made = started.result.status === 'succeeded' ? started.result.value : null;
    if (thenDesk && isFileValue(made) && made.items[0]) {
      void placeResultsOnDesk(files, [made.items[0]], Date.now()).then(
        (desk) => {
          if (!alive.current) return void clearDesk(files, desk.id);
          router.replace({ pathname: '/desk/[deskId]', params: { deskId: desk.id } });
        },
        () => undefined,
      );
    }
    // Log an expense (D-187) writes directly to the database: lists and statistics on the page must be re-read (might have already logged some expenses even if stopped midway).
    if (workflow.steps.some((s) => s.action === 'out.addRecord')) bumpRecords();
  }

  useEffect(() => {
    // Wait for the run page pop-up animation to finish before starting: the system will not pop up photo/file pickers while the animation is playing (it would otherwise stay stuck on step 1).
    alive.current = true;
    const timer = setTimeout(() => void execute(), START_DELAY_MS);
    return () => {
      alive.current = false;
      clearTimeout(timer);
      signal.current.cancelled = true;
      void run.current?.dispose();
      if (incoming && !keepIncoming) void releaseShare(files, incoming.id);
      // The scanning pack and OCR pack pages consume tens of MB of memory, close them upon leaving the run page (reload when next used).
      packs?.bridge.close('scan');
      packs?.bridge.close('ocr');
    };
    // Run only once upon opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const running = current !== null;
  const failedAt = outcome?.status === 'failed' ? outcome.stepIndex : null;
  // Stopped at the photo or scan step because the camera is unavailable or permission was not granted: propose switching to pick from the photo library this time (D-508).
  const failedStep = failedAt !== null ? workflow.steps[failedAt] : undefined;
  const offerLibrary =
    outcome?.status === 'failed' &&
    !fromLibrary &&
    failedStep?.action === 'in.photos' &&
    (failedStep.params.source === 'camera' || failedStep.params.source === 'scanner') &&
    (outcome.error.code === 'cameraUnavailable' ||
      (outcome.error.code === 'permissionDenied' && outcome.error.detail?.what === 'camera'));
  const value = outcome?.status === 'succeeded' ? outcome.value : null;
  // Only one result file: do not stop on the results page, go directly to its preview page (D-457).
  // Limited to two cases: created by photo scanning, and run on received files (from preview or
  // inbox pages). Quick actions that output, save, or log themselves (having out. steps),
  // container-valued runs, and "Convert to Word" going to the desktop behave as before; runs where
  // files are manually selected in the tools page also behave as before, with their results pages
  // managing saving and folders.
  const first = workflow.steps[0];
  const scans = first?.action === 'in.photos' && first.params.source === 'scanner';
  const forwarding =
    !noPreview &&
    (scans || incoming !== undefined) &&
    // Running subsequent to a previous result, with a ChainCard ("Combine into a quick action") on the results page; continue to stay on the results page.
    !incoming?.result &&
    !thenDesk &&
    !handed &&
    isFileValue(value) &&
    value.items.length === 1 &&
    // Excel and Word files editable on the desktop (containing recognized tables or documents) continue to stay on the results page: "Edit" on the preview page only copies the file and cannot modify it.
    !canEditTable(value.items[0]!) &&
    !canEditWord(value.items[0]!) &&
    !workflow.steps.some((st) => st.action.startsWith('out.'));

  // Converted to Word on desktop, scanned, or run on received files: do not display the quick
  // action step list at runtime, only state what is being done, and go directly to the desktop or
  // preview page upon completion (D-457). Reveal the full run page only on failure, cancellation,
  // or when there are multiple result files.
  const couldForward =
    !noPreview &&
    !handed &&
    !workflow.steps.some((st) => st.action.startsWith('out.')) &&
    (thenDesk || ((scans || incoming !== undefined) && !incoming?.result));
  // Quick action whose completion is "Log an expense" (voice logging, receipt scanning, D-588):
  // like above, do not display the step list, only state what is being done; once logged or
  // cancelled by the user, return directly to the originating place without stopping on the results
  // page. Reveal the full run page as usual upon failure.
  const recordRun =
    !noPreview &&
    !handed &&
    workflow.steps.some((st) => st.action === 'out.addRecord') &&
    workflow.steps.every((st) => !st.action.startsWith('out.') || st.action === 'out.addRecord');
  const compact =
    (couldForward &&
      (outcome === null || (outcome.status === 'succeeded' && (thenDesk || forwarding)))) ||
    (recordRun && (outcome === null || outcome.status === 'succeeded'));

  // Cancelled inside the scanner: return directly to the originating place without leaving a "cancelled" run page.
  const scanCancelled =
    outcome?.status === 'cancelled' && (scans || recordRun) && incoming === undefined;
  useEffect(() => {
    if (scanCancelled) router.back();
    // Router remains constant across renders, execute only when switching to "scan cancelled".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanCancelled]);
  const recorded = recordRun && outcome?.status === 'succeeded';
  useEffect(() => {
    if (recorded && router.canGoBack()) router.back();
    // Execute only once when "logged successfully" becomes true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorded]);

  async function saveResult() {
    if (!isFileValue(value) || !run.current) return;
    const items = await saveItems({ files, repo, grantee: granteeOf(workflow) }, value.items, {
      now: () => new Date(),
      newId: newAssetId,
    });
    setOutcome({
      status: 'succeeded',
      value: { ...value, items },
      saved: items.flatMap((i) => i.assetId ?? []),
      inputSize: outcome?.status === 'succeeded' ? outcome.inputSize : 0,
    });
    bumpAssets();
  }

  async function continueProcessing(auto = false) {
    if (!isFileValue(value) || transferring.current) return;
    transferring.current = true;
    setTransferBusy(true);
    const runId = newAssetId();
    const previous = useIncoming.getState().share?.id;
    try {
      const picked = await copyResults(files, value.items, runId, run.current?.runId);
      if (!alive.current || previous !== useIncoming.getState().share?.id) {
        await files.removeRun(runId);
        if (auto && alive.current) setNoPreview(true);
        return;
      }
      useIncoming.getState().receive(picked, [], 'result', { runId, workflow });
      try {
        // Entered from the preview page: close this page, replace the preview page below with the results; otherwise replace with the preview page.
        if (auto && keepIncoming) router.back();
        else router.replace('/share');
      } catch (error) {
        await releaseShare(files, useIncoming.getState().share!.id);
        throw error;
      }
    } catch (error) {
      if (!auto) throw error;
      if (alive.current) setNoPreview(true);
    } finally {
      transferring.current = false;
      if (alive.current) setTransferBusy(false);
    }
  }

  useEffect(() => {
    if (!forwarding) return;
    const timer = setTimeout(() => void continueProcessing(true), 0);
    return () => clearTimeout(timer);
    // Execute only once when "ready to transition into preview page" becomes true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forwarding]);

  if (scanCancelled) return <View testID="run-screen" />;

  return (
    <ScrollView
      testID="run-screen"
      // The prompt panel (Modal) is also in this tree: without this, tapping "Confirm" while the keyboard is open would only dismiss the keyboard.
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap, paddingBottom: 80 }}>
      {/* AI entry point is available only after the run finishes (D-406): leaving this page during a run will interrupt it. */}
      <Stack.Screen
        options={{
          ...(compact ? { title: '' } : {}),
          headerRight:
            outcome && !compact ? workflowEntry(config, workflow.id, palette) : () => null,
        }}
      />
      {compact ? (
        <View
          testID="run-compact"
          // The scanner's preceding step (selecting photos) is hidden on this page: users only care about the scanner and do not want to see a loading spinner page first.
          style={[
            styles.compact,
            (scans || recordRun) && !incoming && current?.index === 0 && { opacity: 0 },
          ]}>
          <ActivityIndicator size="large" color={palette.primary} />
          <Text
            testID="run-compact-name"
            style={[palette.font('title', 18), { color: palette.text, textAlign: 'center' }]}>
            {workflow.name}
          </Text>
          <Text
            testID="run-compact-step"
            style={[palette.font('body', 14), { color: palette.muted, textAlign: 'center' }]}>
            {current
              ? `${label(workflow.steps[current.index]?.action ?? '', current.index)}${progressText(current)}`
              : ''}
          </Text>
          {running ? (
            <Button
              palette={palette}
              testID="run-cancel"
              variant="outline"
              label={t(locale, 'runCancel')}
              onPress={() => {
                signal.current.cancelled = true;
              }}
            />
          ) : null}
        </View>
      ) : (
        <>
          <Card palette={palette}>
            {workflow.steps.map((s, i) => {
              const state =
                failedAt === i
                  ? 'failed'
                  : current?.index === i
                    ? 'current'
                    : (current && i < current.index) ||
                        outcome?.status === 'succeeded' ||
                        (failedAt !== null && i < failedAt)
                      ? 'done'
                      : 'pending';
              const dot =
                state === 'current'
                  ? palette.primary
                  : state === 'failed'
                    ? palette.danger
                    : state === 'done'
                      ? palette.secondary
                      : palette.primaryTint;
              const onDot = state === 'pending' ? palette.primaryText : palette.onAccent(dot);
              return (
                <View key={s.id} style={styles.step} testID={`run-step-${s.id}`}>
                  <View style={[styles.dot, { backgroundColor: dot }]}>
                    {state === 'done' ? (
                      <Icon name="check" size={14} color={onDot} />
                    ) : (
                      <Text style={[palette.font('bodyBold', 12), { color: onDot }]}>{i + 1}</Text>
                    )}
                  </View>
                  <Text
                    style={[
                      palette.font(state === 'current' ? 'bodyBold' : 'body', 15),
                      styles.flex,
                      { color: state === 'pending' ? palette.muted : palette.text },
                    ]}>
                    {label(s.action, i)}
                    {state === 'current' && current ? progressText(current) : ''}
                  </Text>
                  {state === 'current' && !outcome ? (
                    // Processing (D-276): querying parameters or waiting for user confirmation also happens at this step, the spinner only indicates that it is not yet finished.
                    <ActivityIndicator
                      testID={`run-busy-${s.id}`}
                      size="small"
                      color={palette.primary}
                    />
                  ) : null}
                </View>
              );
            })}
          </Card>

          {/* Prompt whether the user can navigate away during long steps (video, audio) (D-160, D-148). */}
          {current && isBackgroundAction(workflow.steps[current.index]?.action ?? '') ? (
            <Text
              testID="run-background-hint"
              style={[palette.font('body', 13), { color: palette.caption }]}>
              {t(
                locale,
                files.background?.continuesInBackground ? 'runCanLeave' : 'runStayInMorph',
              )}
            </Text>
          ) : null}

          {running ? (
            <Button
              palette={palette}
              testID="run-cancel"
              variant="outline"
              label={t(locale, 'runCancel')}
              onPress={() => {
                signal.current.cancelled = true;
              }}
            />
          ) : null}

          {outcome?.status === 'cancelled' ? (
            <Text
              testID="run-cancelled"
              style={[palette.font('body', 15), { color: palette.muted }]}>
              {t(locale, 'runCancelled')}
            </Text>
          ) : null}
          {outcome?.status === 'failed' ? (
            <Card palette={palette}>
              {outcome.stepIndex !== null ? (
                <Text style={[palette.font('bodyBold', 14), { color: palette.muted }]}>
                  {t(locale, 'runFailedAt', { n: outcome.stepIndex + 1 })}
                </Text>
              ) : null}
              <Text
                testID="run-error"
                style={[palette.font('bodyMedium', 15), { color: palette.danger }]}>
                {runErrorText(locale, outcome.error.code, outcome.error.detail)}
              </Text>
              {offerLibrary ? (
                <Button
                  palette={palette}
                  testID="run-from-library"
                  variant="outline"
                  label={t(locale, 'runFromLibrary')}
                  onPress={() => void restart(true)}
                />
              ) : null}
            </Card>
          ) : null}
          {/* Add an explanatory note below translation results (D-172): on-device translation is suitable for understanding gist, use professional translation for official documents. */}
          {value && workflow.steps.some((st) => st.action === 'translate.text') ? (
            <Text
              testID="translate-note"
              style={[palette.font('body', 13), { color: palette.caption }]}>
              {t(locale, 'translateNote')}
            </Text>
          ) : null}
          {/* Add an explanatory note above speech-to-text results (D-150): automatically recognized on-device, may contain typos, please verify. */}
          {value &&
          workflow.steps.some(
            (st) => st.action === 'audio.transcribe' || st.action === 'video.subtitles',
          ) ? (
            <Text
              testID="speech-note"
              style={[palette.font('body', 13), { color: palette.caption }]}>
              {t(locale, 'speechNote')}
            </Text>
          ) : null}
          {value && workflow.steps.some((st) => st.action === 'video.subtitles') ? (
            <Text
              testID="subtitles-note"
              style={[palette.font('body', 13), { color: palette.caption }]}>
              {t(locale, 'subtitlesNote')}
            </Text>
          ) : null}
          {value && !forwarding ? (
            <ResultView
              // Switched to a new file after editing: states like "Saved" are calculated from scratch.
              key={isFileValue(value) ? value.items.map((i) => i.uri).join('|') : 'value'}
              value={value}
              inputSize={outcome?.status === 'succeeded' ? outcome.inputSize : 0}
              palette={palette}
              locale={locale}
              actions={{
                save: saveResult,
                continueProcessing,
                // Place on desktop to edit (D-366): copy into a new desktop, leaving the one on the results page untouched.
                putOnDesk: async (item) => {
                  const desk = await placeResultsOnDesk(files, [item], Date.now());
                  router.push({ pathname: '/desk/[deskId]', params: { deskId: desk.id } });
                },
                share: async () => {
                  if (isFileValue(value)) await files.shareUris(value.items);
                },
                saveToFolder: async (choose) =>
                  isFileValue(value)
                    ? ((await files.saveToFolder(value.items, workflow.id, choose))?.folder ?? null)
                    : null,
                rememberedFolder: () => files.rememberedFolder(workflow.id),
                saveToPhotos: async () => {
                  if (isFileValue(value)) await files.saveToPhotos(value.items.map((i) => i.uri));
                },
                print: async () => {
                  if (isFileValue(value)) for (const item of value.items) await files.print(item);
                },
                copy: async () => {
                  if (value.type === 'text') await files.copyText(value.text);
                },
                preview: (item) =>
                  files.previewFile({
                    uri: item.uri,
                    mimeType: item.mimeType,
                    name: `${item.name}.${item.ext}`,
                  }),
              }}
            />
          ) : null}

          {outcome?.status === 'succeeded' && !forwarding && incoming?.result ? (
            <ChainCard
              key={`chain-${runCount}`}
              source={incoming.result}
              workflow={workflow}
              palette={palette}
            />
          ) : null}

          {outcome?.status === 'succeeded' && !handed && !forwarding ? (
            <HabitCard
              key={runCount}
              workflow={workflow}
              answers={answers.current}
              palette={palette}
            />
          ) : null}

          {/* Results page: "Done" closes the page; "Run again" is secondary; modifying settings is a small link (D-111). */}
          {!running && !forwarding ? (
            <>
              <View style={styles.row}>
                <Button
                  palette={palette}
                  testID="run-again"
                  disabled={transferBusy}
                  variant="outline"
                  label={t(locale, 'runAgain')}
                  onPress={() => void restart()}
                  style={styles.flex}
                />
                <Button
                  palette={palette}
                  testID="run-done"
                  disabled={transferBusy}
                  label={t(locale, outcome?.status === 'succeeded' ? 'done' : 'close')}
                  onPress={() => (keepIncoming ? router.dismissAll() : router.back())}
                  style={styles.flex}
                />
              </View>
              <View style={styles.links}>
                {onEdit ? (
                  <Pressable
                    testID="run-edit"
                    accessibilityRole="link"
                    hitSlop={8}
                    onPress={onEdit}
                    style={styles.editLink}>
                    <Text style={[palette.font('bodyMedium', 14), { color: palette.primaryText }]}>
                      {t(locale, 'runEdit')}
                    </Text>
                  </Pressable>
                ) : null}
                {onAskAI ? (
                  <Pressable
                    testID="run-ask-ai"
                    accessibilityRole="link"
                    hitSlop={8}
                    onPress={onAskAI}
                    style={styles.editLink}>
                    <Text style={[palette.font('bodyMedium', 14), { color: palette.primaryText }]}>
                      {t(locale, 'askAIChange')}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </>
          ) : null}
        </>
      )}

      {host.elements}
      {bundle.element}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  compact: { alignItems: 'center', justifyContent: 'center', gap: 20, paddingVertical: 120 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 28 },
  dot: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: 10 },
  links: { flexDirection: 'row', justifyContent: 'center', gap: 24 },
  editLink: { paddingVertical: 4 },
});

/** Change photo source to photo library for this run (D-508): change the source of the photo-taking or scanning step to the photo library, leave others unchanged; do not write to config. */
function fromPhotoLibrary(workflow: Workflow): Workflow {
  return {
    ...workflow,
    steps: workflow.steps.map((s) =>
      s.action === 'in.photos' && (s.params.source === 'camera' || s.params.source === 'scanner')
        ? { ...s, params: { ...s.params, source: 'library' } }
        : s,
    ),
  };
}
