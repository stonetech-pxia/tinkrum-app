import { appViewOf, stepLabel, quickActionsOf, type Workflow } from '@morph/core';

import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ScrollViewInstance,
} from 'react-native';

import { BottomSheet } from '../renderer/Overlays';
import { t } from '../i18n';
import { UiIcon, type UiIconName } from '../renderer/Icon';
import { usePalette, type Palette } from '../renderer/theme';
import { aboutPlace } from '../shell/ai-entry';
import { NeedButton } from '../shell/NeedButton';
import { TinkBubble } from '../shell/TinkBubble';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { shownConfig, type Draft, type DraftChatReply, type DraftStep } from '../workspace/store';
import { useDraftUi } from './ui';
import { useAfterApply, useApplyDraft } from './useApplyDraft';

/**
 * Page scripts: read back each block and pass to App (EditedPage), execute toolbar commands
 * (bold, italic, underline, font size, alignment), report cursor position and selected text
 * styles to App (toolbar button states, whether to show table controls). Style reading checks
 * tags and inline styles only (ignores computed styles), resolving to the nearest ancestor.
 */
export function DraftBar({
  palette,
  bottom,
  top,
  tinkRight,
}: {
  palette: Palette;
  bottom: number;
  top: number;
  tinkRight: number;
}) {
  const { locale } = useWorkspaceContext();
  const draft = useWorkspace((s) => s.draft);
  const busy = useWorkspace((s) => s.busy);
  const stepBack = useWorkspace((s) => s.stepBack);
  const closeDraft = useWorkspace((s) => s.closeDraft);
  const setChatOpen = useDraftUi((s) => s.setChatOpen);
  const chatOpen = useDraftUi((s) => s.chatOpen);
  const seenStep = useDraftUi((s) => s.seenStep);
  const markSeen = useDraftUi((s) => s.markSeen);
  const apply = useApplyDraft();
  if (!draft?.open) return null;
  const last = draft.steps.at(-1)!;
  const replyShown = !chatOpen && seenStep !== last.changeRequestId;
  const canStepBack = draft.steps.length > 1;

  const button = (
    id: string,
    icon: UiIconName,
    label: string,
    onPress: () => void,
    opts: { primary?: boolean; disabled?: boolean } = {},
  ) => {
    const color = opts.primary ? palette.onPrimary : palette.text;
    return (
      <Pressable
        key={id}
        testID={`draft-${id}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: !!opts.disabled }}
        disabled={opts.disabled || busy}
        onPress={onPress}
        style={({ pressed }) => [
          styles.button,
          opts.primary && { backgroundColor: palette.primary },
          (opts.disabled || pressed) && { opacity: opts.disabled ? 0.35 : 0.7 },
        ]}>
        <UiIcon name={icon} size={20} color={color} />
        <Text style={[palette.font('bodyBold', 11), { color }]}>{label}</Text>
      </Pressable>
    );
  };

  return (
    <>
      {/* Image bytes -> data: URL (editing pages do not read files, images are embedded directly into the page). Clipped images are JPG; external docx images (D-509) are identified as PNG, GIF, or BMP from file headers. */}
      {replyShown ? (
        <Pressable
          testID="draft-dim"
          accessibilityLabel={t(locale, 'draftReplyHide')}
          style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim }]}
          onPress={() => markSeen(last.changeRequestId)}
        />
      ) : null}
      {chatOpen ? null : (
        <TinkBubble
          // Draft mode (D-190) four grouped buttons at the bottom: edit (continue chatting in chat box), step back, apply, leave (draft is preserved). Displayed on both the shell and pushed pages; AI cannot modify it (not in config). The latest response is a Tink bubble at the top right (D-526): `top` is bubble top edge, `tinkRight` is Tink center distance from the right (varies by page title bar, passed by page). Tapping "Got it" collapses into three dots, tapping three dots expands again; exiting draft removes the bubble.
          key={last.changeRequestId}
          palette={palette}
          top={top}
          tinkRight={tinkRight}
          collapsed={!replyShown}
          gotIt={t(locale, 'guideGotIt')}
          expandLabel={t(locale, 'draftReplyShow')}
          onGotIt={() => markSeen(last.changeRequestId)}
          onExpand={() => markSeen(null)}>
          <DraftReply draft={draft} palette={palette} />
        </TinkBubble>
      )}
      <View pointerEvents="box-none" style={[styles.wrap, { bottom }]}>
        <View
          testID="draft-bar"
          style={[
            styles.bar,
            palette.cardStyle(palette.surface),
            { borderColor: palette.border, borderRadius: 999 },
          ]}>
          {button('edit', 'chat', t(locale, 'draftEdit'), () => setChatOpen(true))}
          {button('back', 'undo', t(locale, 'draftBack'), () => void stepBack(), {
            disabled: !canStepBack,
          })}
          {button('apply', 'done', t(locale, 'draftApply'), () => void apply(), {
            primary: true,
          })}
          {button('leave', 'close', t(locale, 'draftLeave'), closeDraft)}
        </View>
      </View>
    </>
  );
}

/**
 * Interface dims when content edits are displayed, tap to collapse (stops dimming after
 * collapse).
 */
export function DraftChatSheet() {
  const open = useWorkspace((s) => !!s.draft?.open);
  // New step response content changed, remeasure size.
  const config = useWorkspace(shownConfig)!;
  const appId = useWorkspace((s) => s.appId);
  const palette = usePalette(appViewOf(config, appId).theme);
  const chatOpen = useDraftUi((s) => s.chatOpen);
  const setChatOpen = useDraftUi((s) => s.setChatOpen);
  // Chat box placed outside the shell: shell remounts on every change step (ErrorBoundary key), so the chat box cannot slide out alongside it.
  useEffect(() => {
    if (!open) setChatOpen(false);
  }, [open, setChatOpen]);
  return (
    <DraftChat visible={open && chatOpen} palette={palette} onClose={() => setChatOpen(false)} />
  );
}

/** Use draft configuration; root layout navigation header still follows the saved version. Uses this app's style within the app (D-485). */
function addedWorkflow(draft: Draft, index: number): Workflow | undefined {
  const step = draft.steps[index]!;
  const before = index > 0 ? draft.steps[index - 1]!.config : null;
  const known = new Set(before ? quickActionsOf(before).map((w) => w.id) : []);
  const added = step.ops.flatMap((op) =>
    op.op === 'addTool' && typeof op.tool === 'object' && op.tool.kind === 'quickAction'
      ? [op.tool.id]
      : [],
  );
  const id = added.find((x) => !known.has(x));
  return id ? quickActionsOf(step.config).find((w) => w.id === id) : undefined;
}

/** Draft is discarded if no draft step can be applied after features take effect (D-411): chat box collapses together, and the next draft should not open with it immediately. */
function DraftReply({ draft, palette }: { draft: Draft; palette: Palette }) {
  return <StepReply draft={draft} index={draft.steps.length - 1} palette={palette} onBubble />;
}

/** Newly created quick action: compare this step with the previous one to find the added one. */
function StepReply({
  draft,
  index,
  palette,
  animate = true,
  onBubble = false,
}: {
  draft: Draft;
  index: number;
  palette: Palette;
  animate?: boolean;
  /** Latest step response: what changed (newly created quick actions listing steps, growing one by one) and AI explanation. Placed in Tink's bubble. */
  onBubble?: boolean;
}) {
  const step = draft.steps[index]!;
  const workflow = addedWorkflow(draft, index);
  const ink = onBubble ? palette.onPrimary : palette.text;
  const body = [palette.font('body', 14), { color: ink }];
  return (
    <View style={styles.stepReply}>
      {workflow ? (
        <GrowingSteps workflow={workflow} palette={palette} animate={animate} onBubble={onBubble} />
      ) : (
        step.lines.slice(0, 4).map((line, i) => (
          <Text key={i} style={body}>
            • {line}
          </Text>
        ))
      )}
      {step.notes?.map((note, i) => (
        <Text
          key={`n${i}`}
          testID={`draft-note-${i}`}
          style={[
            palette.font('body', 13),
            onBubble ? { color: palette.onPrimary, opacity: 0.85 } : { color: palette.muted },
          ]}>
          {note}
        </Text>
      ))}
    </View>
  );
}

/** Step response content (shared between chat box and latest step response). */
function GrowingSteps({
  workflow,
  palette,
  animate,
  onBubble,
}: {
  workflow: Workflow;
  palette: Palette;
  animate: boolean;
  onBubble: boolean;
}) {
  const ink = onBubble ? palette.onPrimary : palette.text;
  const { locale, registry } = useWorkspaceContext();
  const [shown] = useState(() => workflow.steps.map(() => new Animated.Value(animate ? 0 : 1)));
  useEffect(() => {
    if (!animate) return;
    Animated.stagger(
      220,
      shown.map((v) => Animated.timing(v, { toValue: 1, duration: 300, useNativeDriver: true })),
    ).start();
  }, [animate, shown]);
  return (
    <View testID="draft-steps" style={styles.stepReply}>
      <Text style={[palette.font('bodyBold', 14), { color: ink }]}>{workflow.name}</Text>
      {workflow.steps.map((step, i) => (
        <Animated.View
          key={step.id}
          testID={`draft-step-${step.id}`}
          style={[
            styles.step,
            {
              opacity: shown[i],
              transform: [
                { translateY: shown[i]!.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) },
              ],
            },
          ]}>
          <View
            style={[
              styles.stepNo,
              { backgroundColor: onBubble ? 'rgba(255,255,255,0.25)' : palette.primaryTint },
            ]}>
            <Text
              style={[
                palette.font('bodyBold', 11),
                { color: onBubble ? palette.onPrimary : palette.primaryText },
              ]}>
              {i + 1}
            </Text>
          </View>
          <Text style={[palette.font('body', 14), styles.flex, { color: ink }]}>
            {stepLabel(registry.actions.get(step.action), step.params, locale) ?? step.action}
          </Text>
        </Animated.View>
      ))}
    </View>
  );
}

/**
 * Placed inside Tink's bubble (primary color background): text uses bubble text color.
 */
function DraftChat({
  visible,
  palette,
  onClose,
}: {
  visible: boolean;
  palette: Palette;
  onClose: () => void;
}) {
  const { locale } = useWorkspaceContext();
  const draft = useWorkspace((s) => s.draft);
  const busy = useWorkspace((s) => s.busy);
  const draftChange = useWorkspace((s) => s.draftChange);
  const closeDraft = useWorkspace((s) => s.closeDraft);
  const router = useRouter();
  const [input, setInput] = useState('');
  const scroll = useRef<ScrollViewInstance>(null);
  const steps = draft?.steps ?? [];
  const chatAbout = useDraftUi((s) => s.chatAbout);
  const config = useWorkspace(shownConfig);
  // Newly created quick action: steps grow one by one.
  const place = aboutPlace(chatAbout ?? draft?.origin.about, config, locale);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput('');
    // "Edit": chat box pulled up from bottom (D-190). Every message modifies the draft with another step, updating the app above; if impossible, explains the reason and provides clickable examples. Functional items take effect immediately (D-411), keeping the draft open while chatting here.
    const result = await draftChange(trimmed, chatAbout ?? undefined);
    // Refers to major work (D-415): planned to be viewed on the AI modification page. Keep the draft.
    if (result.kind === 'build') {
      onClose();
      closeDraft();
      router.push('/change');
      return;
    }
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
  }

  const bubble = (mine: boolean) => [
    styles.bubble,
    mine
      ? { alignSelf: 'flex-end' as const, backgroundColor: palette.primaryTint }
      : { alignSelf: 'flex-start' as const, backgroundColor: palette.background },
    { borderRadius: palette.controlRadius },
  ];

  return (
    <BottomSheet
      palette={palette}
      locale={locale}
      visible={visible}
      animationType="slide"
      onClose={onClose}
      backdropLabel={t(locale, 'draftChatClose')}
      bottomPadding={12}
      testID="draft-chat"
      style={[
        styles.sheet,
        {
          backgroundColor: palette.surface,
          borderColor: palette.border,
        },
      ]}>
      <View style={styles.replyHead}>
        <Text style={[palette.font('title', 16), styles.flex, { color: palette.text }]}>
          {t(locale, 'draftChatTitle')}
        </Text>
        <Pressable testID="draft-chat-close" hitSlop={10} onPress={onClose}>
          <Text style={[palette.font('bodyBold', 15), { color: palette.primaryText }]}>
            {t(locale, 'draftChatClose')}
          </Text>
        </Pressable>
      </View>
      {place ? (
        <Text
          testID="draft-chat-about"
          style={[palette.font('bodyMedium', 13), { color: palette.muted }]}>
          {place.title}
        </Text>
      ) : null}
      <ScrollView
        ref={scroll}
        style={styles.flex}
        contentContainerStyle={styles.messages}
        keyboardShouldPersistTaps="handled">
        {draft
          ? steps.map((step: DraftStep, i) => (
              <View key={step.changeRequestId} style={styles.turn}>
                <View style={bubble(true)}>
                  <Text style={[palette.font('body', 14), { color: palette.text }]}>
                    {step.input}
                  </Text>
                </View>
                <View style={bubble(false)} testID={`draft-chat-reply-${i}`}>
                  <StepReply
                    draft={draft}
                    index={i}
                    palette={palette}
                    animate={i === steps.length - 1}
                  />
                </View>
                {draft.replies
                  .filter((r) => r.afterSteps === i + 1)
                  .map((r, j) => (
                    <ReplyBubble
                      key={j}
                      reply={r}
                      palette={palette}
                      style={bubble(false)}
                      onExample={setInput}
                    />
                  ))}
              </View>
            ))
          : null}
      </ScrollView>
      <View style={[styles.inputRow, { borderColor: palette.border }]}>
        <TextInput
          testID="draft-chat-input"
          value={input}
          onChangeText={setInput}
          placeholder={t(locale, 'draftChatPlaceholder')}
          placeholderTextColor={palette.caption}
          multiline
          style={[styles.input, palette.font('body', 15), { color: palette.text }]}
        />
        <Pressable
          testID="draft-chat-send"
          accessibilityRole="button"
          accessibilityLabel={t(locale, 'send')}
          disabled={busy}
          onPress={() => void send(input)}
          style={[styles.send, { backgroundColor: palette.primary }]}>
          {busy ? (
            <ActivityIndicator color={palette.onPrimary} />
          ) : (
            <UiIcon name="send" size={18} color={palette.onPrimary} />
          )}
        </Pressable>
      </View>
    </BottomSheet>
  );
}

function ReplyBubble({
  reply,
  palette,
  style,
  onExample,
}: {
  reply: DraftChatReply;
  palette: Palette;
  style: object[];
  onExample: (text: string) => void;
}) {
  const { locale } = useWorkspaceContext();
  const busy = useWorkspace((s) => s.busy);
  const continueWithDraft = useWorkspace((s) => s.continueWithDraft);
  const afterApply = useAfterApply();
  const message = reply.kind === 'steppedBack' ? reply.message : `${reply.input}\n${reply.message}`;
  const { waiting } = reply;
  return (
    <View style={style} testID="draft-chat-rejected">
      <Text style={[palette.font('body', 14), { color: palette.text }]}>{message}</Text>
      {reply.examples.map((example) => (
        <Pressable key={example} onPress={() => onExample(example)} hitSlop={4}>
          <Text style={[palette.font('bodyBold', 13), { color: palette.primaryText }]}>
            {example}
          </Text>
        </Pressable>
      ))}
      {/* Apply the draft only when the user taps it (D-413, invariants 7, 16). */}
      {waiting ? (
        <Pressable
          testID="draft-chat-apply-continue"
          accessibilityRole="button"
          disabled={busy}
          hitSlop={4}
          onPress={() =>
            void continueWithDraft(waiting).then((result) => {
              if (result.kind === 'applied') afterApply(result.applied);
            })
          }>
          <Text style={[palette.font('bodyBold', 13), { color: palette.primaryText }]}>
            {t(locale, 'draftApplyContinue')}
          </Text>
        </Pressable>
      ) : null}
      {reply.kind === 'rejected' ? (
        <NeedButton text={reply.input} reason={reply.reason} palette={palette} locale={locale} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  wrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center', gap: 10 },
  bar: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minWidth: 68,
  },
  replyHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepReply: { gap: 5 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepNo: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheet: {
    height: '58%',
    flexShrink: 1,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 10,
  },
  messages: { gap: 12, paddingBottom: 8 },
  turn: { gap: 8 },
  bubble: { maxWidth: '88%', paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22,
    paddingLeft: 14,
    paddingRight: 5,
    paddingVertical: 5,
  },
  input: { flex: 1, maxHeight: 110, paddingVertical: 6 },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
});
