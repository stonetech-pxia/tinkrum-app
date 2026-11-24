import {
  allComponents,
  appViewOf,
  createMockAIProvider,
  isKnownComponent,
  openItems,
  pageTarget,
  type PlanAbout,
  type PlanProgress,
  presetOfTheme,
  presetRequest,
  quickActionsOf,
  sessionProblems,
  type ThemePresetId,
} from '@morph/core';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { AiReturnBubble } from '../ai/AiReturnBubble';
import { useAiHandoff } from '../ai/useAiHandoff';
import { useAISettings } from '../ai/context';
import { useAfterApply } from '../draft/useApplyDraft';
import { LivelyTink } from '../guide/LivelyTink';
import { guideText, useGuide } from '../guide/store';
import { t, type StringKey } from '../i18n';
import { BottomSheet } from '../renderer/Overlays';
import { Icon } from '../renderer/Icon';
import { usePalette } from '../renderer/theme';
import { Pill, Button, Card } from '../renderer/ui';
import { sharedAbout } from '../share/about';
import { useIncoming } from '../share/incoming';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import type { ChangeResult, DraftResult } from '../workspace/store';
import { aboutFromParams, aboutPlace } from './ai-entry';
import { BuildPanel } from './BuildPanel';
import { aboutCandidates } from './examples';
import { closeButtonOption, stackScreenOptions } from './header';
import { NeedButton } from './NeedButton';
import { StylePicker } from './StylePicker';

/** Original sentences filled into the style selector generate plans using built-in rules without calling AI in settings (D-095); onboarding tutorial sentences do the same (D-149). */
const presetPlanner = createMockAIProvider();

/** Typing speed of tutorial sentences into the input box: character interval, with the whole sentence taking at most about 1.4 seconds. */
const typeDelay = (length: number) => Math.min(45, 1400 / Math.max(length, 1));

/** Speech bubbles next to Tink for each planning stage (D-448): two sentences per stage, randomly choosing a group when the AI page opens; shows "start" before stage reporting begins. */
const PROGRESS_TEXT: Record<PlanProgress | 'start', readonly [StringKey, StringKey]> = {
  start: ['tinkThinking', 'tinkThinking2'],
  full: ['tinkProgressFull', 'tinkProgressFull2'],
  files: ['tinkProgressFiles', 'tinkProgressFiles2'],
  records: ['tinkProgressRecords', 'tinkProgressRecords2'],
  look: ['tinkProgressLook', 'tinkProgressLook2'],
  style: ['tinkProgressStyle', 'tinkProgressStyle2'],
  checking: ['tinkProgressChecking', 'tinkProgressChecking2'],
  fixing: ['tinkProgressFixing', 'tinkProgressFixing2'],
};

/** Maximum number of examples below the input box (excluding "Change style"). */

/**
 * AI modification entry point (§4, D-190, D-191): an input box with a send arrow and a few
 * examples. Look changes: after AI processing, the page closes, directly entering draft mode: app
 * changes to the modified look, viewable but not interactive, with bottom buttons "Modify / Step
 * back / Apply / Leave"; when a draft already exists, a new sentence continues modifying that
 * draft, which can also be continued or deleted. Feature changes (quick actions, tools, tables):
 * applied directly (undoable), opening the "Ready" page for immediate testing; remaining look
 * changes from the sentence become a "Continue modifying" item on the "Ready" page and the first
 * example here.
 */

export function ChangeScreen() {
  const { locale, registry, store } = useWorkspaceContext();
  const router = useRouter();
  const navigation = useNavigation();
  const config = useWorkspace((s) => s.config)!;
  const draft = useWorkspace((s) => s.draft);
  const busy = useWorkspace((s) => s.busy);
  const planProgress = useWorkspace((s) => s.planProgress);
  const [progressVariant] = useState(() => (Math.random() < 0.5 ? 0 : 1));
  const change = useWorkspace((s) => s.change);
  const next = useWorkspace((s) => s.next);
  const suggest = useWorkspace((s) => s.suggest);
  const session = useWorkspace((s) => s.session);
  const clearSession = useWorkspace((s) => s.clearSession);
  const build = useWorkspace((s) => s.build);
  const endBuild = useWorkspace((s) => s.endBuild);
  const continueWithDraft = useWorkspace((s) => s.continueWithDraft);
  const fixProblems = useWorkspace((s) => s.fixProblems);
  const afterApply = useAfterApply();
  const openDraft = useWorkspace((s) => s.openDraft);
  const deleteDraft = useWorkspace((s) => s.deleteDraft);
  const showInShell = useWorkspace((s) => s.showInShell);
  // Opening the Tink page within an app uses that app's style (D-485); the style selector also indicates the app's current style.
  const appId = useWorkspace((s) => s.appId);
  const theme = appViewOf(config, appId).theme;
  const palette = usePalette(theme);
  const aiMode = useAISettings((s) => s.mode);
  const tinkAgent = useAISettings((s) => s.tinkAgent);
  // Context carried when opened from a quick action ("Ask AI to modify this") or inbox page (D-124).
  const params = useLocalSearchParams<{
    workflow?: string;
    first?: string;
    second?: string;
    shared?: string;
    guide?: string;
    next?: string;
    text?: string;
    /** Opened from the top-right entry of a page (D-406, aboutParams). */
    page?: string;
    table?: string;
    screen?: string;
    desk?: string;
  }>();
  // Opened from onboarding step 1 (D-149, D-231): sentence types into the input box and stops, the
  // user taps send manually; takes effect immediately upon sending, without entering a draft.
  const [guide] = useState(() =>
    guideText(params.guide, locale) !== null ? params.guide : undefined,
  );
  // Tapped "Continue modifying" (D-191): that sentence automatically types into the input box and
  // is processed using the AI in settings. Tutorial sentences use built-in rules across all three
  // languages (D-449, revising D-228).
  const [auto] = useState(() => guideText(guide, locale) ?? (params.next ? next : null));
  const propose = useWorkspace((s) => s.propose);
  const confirm = useWorkspace((s) => s.confirm);
  const setGuideStage = useGuide((s) => s.setStage);
  const [typing, setTyping] = useState(() => auto !== null);
  const share = useIncoming((s) => s.share);
  // Batch source when opening this page (shared, selected in app, previous result): even if another batch is shared in later, the card text remains unchanged.
  const [source] = useState(() => share?.source);
  const [about] = useState<PlanAbout | undefined>(() => {
    if (
      params.first &&
      params.second &&
      [params.first, params.second].every((id) => quickActionsOf(config).some((w) => w.id === id))
    )
      return { kind: 'chain', first: params.first, second: params.second };
    if (params.workflow && quickActionsOf(config).some((w) => w.id === params.workflow))
      return { kind: 'workflow', workflowId: params.workflow };
    if (params.shared && share && String(share.id) === params.shared) return sharedAbout(share);
    return aboutFromParams(params, config);
  });
  const place = aboutPlace(about, config, locale);
  // Sub-apps carry page context; the home screen and unassigned pages provide two entry points: new app / full setup.
  const handoff = useMemo(() => {
    const from =
      about?.kind === 'page'
        ? config.containers.pages.find((p) => p.id === about.pageId)
        : undefined;
    const id = from ? from.app : appId;
    const app = id ? config.nav.apps?.find((a) => a.id === id) : undefined;
    if (!app) return null;
    return {
      id: app.id,
      name: app.name,
      ...(from?.app === app.id ? { page: { id: from.id, title: from.title } } : {}),
    };
  }, [about, appId, config]);

  const sendToAi = useAiHandoff();
  async function handOff() {
    if (!handoff) return;
    await sendToAi(
      { kind: 'app', app: handoff.name, ...(handoff.page ? { page: handoff.page } : {}) },
      input,
      handoff.id,
    );
  }
  /** The send button by default (D-626): a sub-app's page goes as that app, anywhere else as the whole setup. */
  async function sendOut(text: string) {
    if (!text.trim()) return;
    if (handoff) await handOff();
    else await sendToAi({ kind: 'setup' }, text);
  }
  const aboutName =
    about?.kind === 'workflow'
      ? quickActionsOf(config).find((w) => w.id === about.workflowId)?.name
      : undefined;
  const aboutOnHome =
    about?.kind === 'workflow' &&
    config.containers.pages.some(
      (p) =>
        p.id === 'home' &&
        allComponents(p).some(
          (c) =>
            isKnownComponent(c) &&
            c.look === 'action' &&
            c.tools.some((u) => 'tool' in u && u.tool === about.workflowId),
        ),
    );
  // Examples suggested in the input box when context is present (D-124); built-in rules keep only
  // sentences they truly recognize, so a test run is performed first. Preset sentences are no
  // longer listed on the page (D-233), leaving only "Change style".
  const [examples, setExamples] = useState<readonly string[]>(() =>
    !about || aiMode === 'mock'
      ? []
      : aboutCandidates(about, aiMode, locale, { onHome: aboutOnHome }),
  );
  useEffect(() => {
    if (!about || aiMode !== 'mock') return;
    const candidates = aboutCandidates(about, aiMode, locale, { onHome: aboutOnHome });
    let live = true;
    void Promise.all(
      candidates.map((c) => presetPlanner.plan(c, { config, registry, locale, about })),
    ).then((plans) => {
      if (live) setExamples(candidates.filter((_, i) => plans[i]!.kind === 'ops'));
    });
    return () => {
      live = false;
    };
    // Evaluated only once upon opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-filling the input box with a sentence brought from elsewhere (sample app, quick action category, merged card).
  const [input, setInput] = useState(() => (auto ? '' : (params.text ?? '')));
  // When the input box reappears after closing the plan, the keyboard should not auto-popup and block the page.
  const [focusInput, setFocusInput] = useState(() => Boolean(params.text) && !auto);
  const [prefillSelection, setPrefillSelection] = useState(() =>
    !auto && params.text ? { start: params.text.length, end: params.text.length } : undefined,
  );
  /** Recently filled sentences in the style selector; once the user modifies the input box, they are no longer equal, deferring to the AI in settings. */
  const [presetText, setPresetText] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<
    | Extract<DraftResult, { kind: 'rejected' | 'invalid' }>
    | Extract<ChangeResult, { kind: 'needsDraft' }>
    | null
  >(null);
  const [stylesOpen, setStylesOpen] = useState(false);
  /** The sentence that was rejected (requirement recycling, D-189). */
  const [asked, setAsked] = useState('');

  /**
   * Close this page and return to draft: opened from shell or page returns to origin (page also
   * displays draft); opened from run page, inbox page, or "Ready" page (with context) close
   * together because draft mode is not inside them. Opened from the top-right page entry returns
   * to origin (D-406); origins unable to display drafts (record forms, quick action lists) close
   * together only after entering the draft.
   */
  function leave(drafted = false) {
    const backToPlace =
      about?.kind === 'page' ||
      about?.kind === 'desk' ||
      ((about?.kind === 'table' || about?.kind === 'screen') && !drafted);
    if (!router.canGoBack()) router.replace('/');
    else if (about && !backToPlace && router.canDismiss()) router.dismissAll();
    else router.back();
  }

  async function submit(text: string, offline = text.trim() === presetText) {
    if (!text.trim() || busy) return;
    setFeedback(null);
    // "Undo" immediately returns to the previous version and may change themes: first lock down
    // this navigation bar. Updating the navigation bar with a close button on Android during this
    // crashes (`react-native-screens`: child already has a parent).
    navigation.setOptions({ ...stackScreenOptions(palette), ...closeButtonOption(palette) });
    if (guide) {
      // Do not show "Modified · Undo" at the top (D-239); return to home and display step 2.
      const proposed = await propose(text.trim(), offline ? presetPlanner : undefined);
      // When re-reading the tutorial, home already has these two buttons: step 1 is considered complete.
      const already = proposed.kind === 'rejected' && proposed.reason === 'noChange';
      if (!already && (proposed.kind === 'rejected' || proposed.kind === 'invalid')) {
        setFeedback(proposed);
        setAsked(text.trim());
        return;
      }
      if (!already && (proposed.kind !== 'preview' || !(await confirm({ quiet: true })))) return;
      void setGuideStage('goal');
      leave();
      return;
    }
    const result = await change(text.trim(), offline ? presetPlanner : undefined, {
      ...(about ? { about } : {}),
    });
    setAsked(text.trim());
    afterResult(result);
  }

  /** Result of a single sentence: explanations stay on this page, and the plan stays on this page; leaves only upon success or entering draft. */
  function afterResult(result: ChangeResult) {
    if (result.kind === 'build') {
      setInput('');
      setFocusInput(false);
      Keyboard.dismiss();
      return;
    }
    if (result.kind === 'rejected' || result.kind === 'invalid' || result.kind === 'needsDraft') {
      setFeedback(result);
      return;
    }
    // Show the modified page (when in the navigation bar) upon entering draft or returning to the
    // app. Feature modifications from page top-right entries stay at origin (D-406): only drafts
    // jump to the modified page to view.
    if (result.kind === 'drafted' || (result.kind === 'applied' && !place)) {
      const target = pageTarget(result.focusPageId);
      const shown = result.kind === 'drafted' ? result.step.config : store.getState().config!;
      showInShell(shown, target);
    }
    leave(result.kind === 'drafted');
    // Feature class applied directly (D-191): go to the "Ready" page (or return to inbox page) to test.
    if (result.kind === 'applied') afterApply(result.applied);
  }

  // Typing tutorial and "Continue modifying" sentences character by character into the input box:
  // user sees "it turns out you can phrase it this way". Tutorial sentences pause and wait for the
  // user to send, while "Continue modifying" processes automatically after typing finishes.
  useEffect(() => {
    const text = auto;
    if (!text) return;
    let shown = 0;
    const timer = setInterval(() => {
      shown += 1;
      setInput(text.slice(0, shown));
      if (shown < text.length) return;
      clearInterval(timer);
      setTyping(false);
      // Tutorial sentences use built-in rules (see guide/store.ts).
      if (guide) {
        setPresetText(text);
        return;
      }
      void submit(text, false);
    }, typeDelay(text.length));
    return () => clearInterval(timer);
    // Typed only once upon opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Tap to select style: directly switch to that style using built-in rules, entering draft to preview effect (D-095). */
  function pickStyle(preset: ThemePresetId) {
    const text = presetRequest(preset, locale);
    setStylesOpen(false);
    setInput(text);
    setPresetText(text);
    void submit(text, true);
  }

  function askDelete() {
    if (!draft) return;
    Alert.alert(
      t(locale, 'draftDeleteTitle'),
      t(locale, 'draftDeleteBody', { n: draft.steps.length }),
      [
        { text: t(locale, 'cancel'), style: 'cancel' },
        { text: t(locale, 'draftDelete'), style: 'destructive', onPress: () => void deleteDraft() },
      ],
    );
  }

  /** Triggered by user (D-413): confirm draft first, then execute the pending step. */
  async function applyDraftAndContinue(
    waiting: Extract<ChangeResult, { kind: 'needsDraft' }>['waiting'],
  ) {
    setFeedback(null);
    navigation.setOptions({ ...stackScreenOptions(palette), ...closeButtonOption(palette) });
    afterResult(await continueWithDraft(waiting));
  }

  function askClearSession() {
    Alert.alert(t(locale, 'sessionClearTitle'), t(locale, 'sessionClearBody'), [
      { text: t(locale, 'sessionKeep'), style: 'cancel' },
      { text: t(locale, 'sessionClear'), onPress: () => void clearSession() },
    ]);
  }

  /**
   * "Fill these in" (D-418): same path as a single sentence input, results follow the same flow.
   * Stays on the build result panel after filling so the reduction in issues is visible; look
   * preview is under "View look" in the panel.
   */
  async function fix() {
    setFeedback(null);
    navigation.setOptions({ ...stackScreenOptions(palette), ...closeButtonOption(palette) });
    const result = await fixProblems();
    if (!result) return;
    setAsked(t(locale, 'fixProblems'));
    if (build && (result.kind === 'applied' || result.kind === 'drafted')) return;
    afterResult(result);
  }

  /** Finished, view draft (D-415): look goes through existing draft confirmation. */
  function seeBuiltLook() {
    openDraft();
    void endBuild();
    leave(true);
  }

  const sub = [palette.font('body', 15), { color: palette.muted }];
  // Only this page is shown while the plan is active; once stopped, other things can be discussed.
  const planBusy = build !== null && build.phase !== 'paused';
  // What is still missing (D-414): steps in the plan are already on the plan, and "Continue modifying" is already the first example below.
  const stillOpen = openItems(session).filter(
    (item) => item.text !== next && !(build && item.id.startsWith('b-')),
  );
  const doneCount = session.items.filter((item) => item.status === 'done').length;
  // Issues added in this session that the user will see after confirming the draft (D-418). Counted on the plan panel when plan is active; not counted when "Continue modifying" is waiting to execute the page.
  const shownConfig = draft?.steps.at(-1)?.config ?? config;
  const problems = useMemo(
    () => (build ? [] : sessionProblems(session, shownConfig, registry, { later: Boolean(next) })),
    [build, session, shownConfig, registry, next],
  );

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: palette.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={[styles.page, { padding: palette.pad, gap: palette.gap - 2 }]}
        keyboardShouldPersistTaps="handled">
        {!guide && !planBusy ? (
          <View style={styles.returnBubble}>
            <AiReturnBubble palette={palette} tail={false} />
          </View>
        ) : null}
        {build && !guide ? (
          <BuildPanel
            build={build}
            palette={palette}
            onSeeLook={seeBuiltLook}
            onFix={() => void fix()}
          />
        ) : null}

        {planBusy ? null : place ? (
          <Card palette={palette} background={palette.primaryTint} testID="change-about">
            <Text style={[palette.font('title', 15), { color: palette.text }]}>{place.title}</Text>
            <Text style={sub}>{place.hint}</Text>
          </Card>
        ) : about ? (
          <Card palette={palette} background={palette.primaryTint} testID="change-about">
            <Text style={[palette.font('title', 15), { color: palette.text }]}>
              {about.kind === 'chain'
                ? t(locale, 'chainAbout', {
                    first: quickActionsOf(config).find((w) => w.id === about.first)?.name ?? '',
                    second: quickActionsOf(config).find((w) => w.id === about.second)?.name ?? '',
                  })
                : about.kind === 'workflow'
                  ? t(locale, 'aboutWorkflow', { name: aboutName ?? '' })
                  : t(
                      locale,
                      source === 'result'
                        ? 'resultIncoming'
                        : source === 'picker'
                          ? 'sharePicked'
                          : 'aboutShared',
                      {
                        what: about.kind === 'shared' ? sharedWhat(about, locale) : '',
                      },
                    )}
            </Text>
            {about.kind === 'workflow' ? (
              <Text style={sub}>{t(locale, 'aboutWorkflowHint')}</Text>
            ) : null}
          </Card>
        ) : null}

        {draft && !guide && !build ? (
          <Card palette={palette} background={palette.primaryTint} testID="change-draft">
            <Text style={[palette.font('title', 15), { color: palette.text }]}>
              {t(locale, 'draftCard', { n: draft.steps.length })}
            </Text>
            <Text style={sub}>{t(locale, 'draftCardHint')}</Text>
            <View style={styles.row}>
              <Button
                palette={palette}
                testID="change-draft-continue"
                label={t(locale, 'draftContinue')}
                onPress={() => {
                  openDraft();
                  leave();
                }}
                style={styles.flex}
              />
              <Button
                palette={palette}
                testID="change-draft-delete"
                variant="outline"
                danger
                label={t(locale, 'draftDelete')}
                onPress={askDelete}
              />
            </View>
          </Card>
        ) : null}

        {/* Input box: a sparkle icon on the left, soft shadow, same as the dialog on the last page of swipe-through introduction. */}
        {planBusy ? null : (
          <View
            style={[
              styles.box,
              {
                padding: palette.inset,
                backgroundColor: palette.surface,
                borderColor: palette.border,
                borderRadius: palette.controlRadius,
                boxShadow: `0px 2px 6px ${palette.shadow}1F`,
              },
            ]}>
            <View style={styles.inputRow}>
              <TextInput
                testID="change-input"
                autoFocus={focusInput}
                selection={prefillSelection}
                onSelectionChange={() => setPrefillSelection(undefined)}
                value={input}
                onChangeText={setInput}
                editable={!typing}
                placeholder={
                  about?.kind === 'shared'
                    ? t(locale, 'sharePlaceholder')
                    : about && examples[0]
                      ? t(locale, 'aboutPlaceholder', { example: examples[0] })
                      : t(locale, 'changeAsk')
                }
                placeholderTextColor={palette.caption}
                multiline
                style={[styles.input, palette.font('body', 16), { color: palette.text }]}
              />
            </View>
            {/* The send button is Tink (D-448): animates after sending, accompanied by a short phrase indicating planning progress. */}
            <View style={styles.sendRow}>
              {busy ? (
                <Text
                  testID="change-progress"
                  numberOfLines={1}
                  style={[
                    palette.font('bodyMedium', 14),
                    styles.progress,
                    { color: palette.muted },
                  ]}>
                  {t(locale, PROGRESS_TEXT[planProgress ?? 'start'][progressVariant])}
                </Text>
              ) : null}
              <Pressable
                testID="change-submit"
                accessibilityRole="button"
                accessibilityLabel={t(locale, 'send')}
                disabled={busy || typing}
                onPress={() => void (tinkAgent || guide ? submit(input) : sendOut(input))}
                style={[styles.send, { backgroundColor: palette.primary }]}>
                {busy || typing ? (
                  <LivelyTink size={24} color={palette.onPrimary} />
                ) : (
                  <Icon name="tink" size={24} color={palette.onPrimary} />
                )}
              </Pressable>
            </View>
          </View>
        )}

        {/* Test-period server save request (D-240): Chinese and English onboarding tutorials use built-in rules without passing through server; French tutorial passes through server (D-228). */}
        {!planBusy && tinkAgent && aiMode === 'server' && !guide ? (
          <Text
            testID="change-server-stored"
            style={[palette.font('body', 13), { color: palette.caption }]}>
            {t(locale, 'aiServerStoredNote')}
          </Text>
        ) : null}

        {feedback && (!planBusy || build?.phase === 'finished') ? (
          <Card palette={palette} testID="change-feedback">
            {feedback.kind === 'needsDraft' ? (
              <>
                <Text style={[palette.font('body', 15), { color: palette.text }]}>
                  {feedback.message}
                </Text>
                <Button
                  palette={palette}
                  testID="change-apply-draft-continue"
                  label={t(locale, 'draftApplyContinue')}
                  disabled={busy}
                  onPress={() => void applyDraftAndContinue(feedback.waiting)}
                />
              </>
            ) : feedback.kind === 'invalid' ? (
              <>
                <Text style={[palette.font('bodyBold', 15), { color: palette.danger }]}>
                  {t(locale, 'invalidPlan')}
                </Text>
                {feedback.issues.map((issue) => (
                  <Text key={issue} style={sub}>
                    • {issue}
                  </Text>
                ))}
              </>
            ) : (
              <>
                <Text style={[palette.font('body', 15), { color: palette.text }]}>
                  {feedback.message}
                </Text>
                {/* Examples provided upon rejection (e.g., quick actions achievable for administrative requests, D-128): tap to fill into the input box. */}
                {feedback.examples.length > 0 ? (
                  <View style={styles.chips} testID="change-feedback-examples">
                    {feedback.examples.map((example) => (
                      <Pill
                        key={example}
                        label={example}
                        palette={palette}
                        onPress={() => setInput(example)}
                      />
                    ))}
                  </View>
                ) : null}
                {feedback.kind === 'rejected' ? (
                  <NeedButton
                    key={asked}
                    text={asked}
                    reason={feedback.reason}
                    palette={palette}
                    locale={locale}
                  />
                ) : null}
              </>
            )}
          </Card>
        ) : null}

        {/* Tool checklist (D-414): what is missing, tap an item to fill into the input box. Completion status is determined by code. */}
        {guide || planBusy || session.items.length === 0 ? null : (
          <View style={styles.session} testID="change-session">
            <View style={styles.sessionHead}>
              <Text style={[palette.font('title', 15), styles.flex, { color: palette.text }]}>
                {stillOpen.length > 0
                  ? t(locale, 'sessionTitle')
                  : t(locale, 'sessionDoneCount', { n: doneCount })}
              </Text>
              <Pressable
                testID="change-session-clear"
                accessibilityRole="button"
                hitSlop={10}
                onPress={askClearSession}>
                <Text style={[palette.font('bodyMedium', 13), { color: palette.primaryText }]}>
                  {t(locale, 'sessionClear')}
                </Text>
              </Pressable>
            </View>
            {problems.length > 0 ? (
              <View style={styles.fix} testID="change-fix">
                <Text style={[palette.font('body', 14), styles.fixText, { color: palette.text }]}>
                  {t(locale, 'fixCount', { n: problems.length })}
                </Text>
                <Button
                  palette={palette}
                  testID="change-fix-button"
                  label={t(locale, 'fixProblems')}
                  loading={busy}
                  disabled={busy}
                  onPress={() => void fix()}
                />
              </View>
            ) : null}
            {stillOpen.map((item) => (
              <Pressable
                key={item.id}
                testID={`change-session-item-${item.id}`}
                accessibilityRole="button"
                onPress={() => setInput(item.text)}
                style={({ pressed }) => [
                  styles.sessionItem,
                  {
                    paddingHorizontal: palette.inset,
                    backgroundColor: palette.primaryTint,
                    opacity: pressed ? 0.6 : 1,
                  },
                ]}>
                <Text
                  numberOfLines={2}
                  style={[palette.font('bodyMedium', 14), { color: palette.primaryText }]}>
                  {item.text}
                </Text>
                {item.reason ? (
                  <Text
                    numberOfLines={2}
                    style={[palette.font('body', 13), { color: palette.muted }]}>
                    {item.reason}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        )}

        {guide || planBusy ? null : (
          <View style={styles.chips} testID="change-examples">
            {/* "Continue modifying" is the remaining part of the user's own sentence (D-191), not a preset sentence. */}
            {next && !auto ? (
              <Pill
                testID="change-next"
                label={next}
                palette={palette}
                onPress={() => setInput(next)}
              />
            ) : null}
            {/* AI suggested next step (D-355): provided by AI during the last modification, tap to fill into the input box. */}
            {suggest.map((text, i) => (
              <Pill
                key={text}
                testID={`change-suggest-${i}`}
                label={text}
                palette={palette}
                onPress={() => setInput(text)}
              />
            ))}
            {/* Two preset sentences (bypassing model): tap to fill into input box, uses built-in rules to apply entire template upon sending. */}
            {about && !place
              ? null
              : (
                  [
                    ['change-want-receipts', 'wantReceiptsChip'],
                    ['change-want-cards', 'wantCardsChip'],
                  ] as const
                ).map(([testID, key]) => (
                  <Pill
                    key={key}
                    testID={testID}
                    label={t(locale, key)}
                    palette={palette}
                    onPress={() => {
                      const text = t(locale, key);
                      setInput(text);
                      setPresetText(text);
                    }}
                  />
                ))}
            {about && !place ? null : (
              <Pill
                testID="change-pick-style"
                label={t(locale, 'pickStyleChip')}
                icon="palette"
                palette={palette}
                onPress={() => setStylesOpen(true)}
              />
            )}
          </View>
        )}
        {!guide && !planBusy && tinkAgent && handoff ? (
          <Button
            palette={palette}
            testID="change-handoff"
            variant="text"
            label={t(locale, 'handoffButton')}
            onPress={() => void handOff()}
          />
        ) : null}
      </ScrollView>

      {/* "Change style": pops up style selection from bottom (D-095), selecting directly enters draft to preview effect. */}
      <BottomSheet
        palette={palette}
        locale={locale}
        visible={stylesOpen}
        animationType="slide"
        onClose={() => setStylesOpen(false)}
        backdropLabel={t(locale, 'close')}
        bottomPadding={16}
        testID="change-styles"
        style={[
          styles.sheet,
          {
            paddingHorizontal: palette.pad,
            backgroundColor: palette.surface,
          },
        ]}>
        <Text style={[palette.font('title', 16), { color: palette.text }]}>
          {t(locale, 'pickStyle')}
        </Text>
        <StylePicker
          locale={locale}
          current={presetOfTheme(theme)}
          palette={palette}
          onPick={pickStyle}
        />
      </BottomSheet>
    </KeyboardAvoidingView>
  );
}

/** "2 photos and 1 PDF": type and count of files shared in. */
function sharedWhat(
  about: Extract<PlanAbout, { kind: 'shared' }>,
  locale: 'en' | 'zh' | 'fr',
): string {
  const parts = [
    about.images ? t(locale, 'sharedPhotos', { n: about.images }) : null,
    about.pdfs ? t(locale, 'sharedPdfs', { n: about.pdfs }) : null,
    about.videos ? t(locale, 'sharedVideos', { n: about.videos }) : null,
    about.audio ? t(locale, 'sharedAudio', { n: about.audio }) : null,
    about.others ? t(locale, 'sharedOthers', { n: about.others }) : null,
  ].filter(Boolean);
  return parts.join(t(locale, 'ChangeScreen_and_d40e9'));
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  page: { paddingBottom: 48 },
  row: { flexDirection: 'row', gap: 10, marginTop: 4 },
  box: { borderWidth: 1, gap: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  input: { flex: 1, minHeight: 84, textAlignVertical: 'top', padding: 2 },
  sendRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10 },
  progress: { flexShrink: 1, textAlign: 'right' },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  session: { gap: 8 },
  sessionHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  // Buttons wrap to next line on narrow screens or long copy (French).
  fix: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  fixText: { flex: 1, minWidth: 120 },
  sessionItem: { borderRadius: 12, paddingVertical: 8, gap: 2 },
  returnBubble: { alignItems: 'flex-start' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  sheet: {
    paddingTop: 18,
    gap: 14,
  },
});
