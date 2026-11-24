import { Dialog, BottomSheet } from '../renderer/Overlays';
import {
  type AskRequest,
  calendarOf,
  canRedo,
  canUndo,
  currentFiles,
  type Desk,
  type DeskFile,
  deskKindOf,
  type DeskStep,
  deskToolAsks,
  deskToolbar,
  deskToolWorkflow,
  initialParams,
  stepLabel,
  quickActionsOf,
  resolveDeskLayout,
  type RunEvent,
  type Workflow,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { folderName, runErrorText, t } from '../i18n';
import type { RenderEnv } from '../renderer/components';
import { Item } from '../renderer/registry';
import {
  deskReturnChoices,
  deskReturnOf,
  endDeskReturn,
  type DeskReturn,
  type DeskReturnMode,
} from '../renderer/attachment-desk';
import { usePalette, type Palette } from '../renderer/theme';
import { Button } from '../renderer/ui';
import { AskPanel } from '../run/AskPanel';
import { newAssetId, startRun } from '../runtime/runner';
import { AIEntry } from '../shell/ai-entry';
import { BannerAnchor } from '../shell/Banner';
import { useShellEnv } from '../shell/Shell';
import { useConfirmLeave } from '../shell/useConfirmLeave';
import { Toast } from '../shell/Toast';
import { deleteUserFiles } from '../storage/user-files';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '../workspace/context';
import { shownConfig } from '../workspace/store';
import { DraftBar } from '../draft/DraftBar';
import type { Box, DocDoc, DocPage, TableDoc } from '@morph/tool-office';

import { DeskEditor } from './DeskEditor';
import { DeskPreview } from './DeskPreview';
import { DeskToolbar, roomEntries, toolEntries, type ToolEntry } from './DeskToolbar';
import { saveDeskFiles } from './saved-source';
import {
  clearDesk,
  commitRun,
  deskFileUri,
  deskPickedWithSources,
  loadDesk,
  recoverEditDraft,
  redo,
  undo,
} from './store';
import { useDeskEdit } from './useDeskEdit';
import { WordEditor } from './WordEditor';
import { useRunHost } from './useRunHost';

// File room (file-room DESIGN §4, D-360): center features a large preview of desk files, with a row
// of tools at the bottom (or top). Using a tool or quick action produces a new version on the desk,
// with undo/redo at the top; "Done" saves, shares, or clears the desk. Layout comes from config
// (WorkspaceConfig.desk, D-358), defaulting to centered preview and bottom toolbar if unspecified.
// Tools apply to all files of the same kind as the currently viewed one (multi-select in R6). Files
// remain local and are invisible to the AI. Results of Excel/Word conversions act as editors on the
// desk (R2, D-366): selecting items tucks away the toolbar and switches to the editing layer;
// continuous edits are synthesized into a single version when using tools, opening "Done", leaving,
// switching files, or moving the app to the background, presenting a single set of undo controls at
// the top (useDeskEdit).

/** Current time in milliseconds: placed outside the component, used only in post-tap handlers. */
const nowMs = () => Date.now();

/** Preview height ratio relative to screen (when layout preview is not fill). */
const PREVIEW_SHARE = { large: 0.62, medium: 0.45 } as const;

/** Height occupied by the four draft buttons (excluding bottom safe area). */
const DRAFT_BAR_SPACE = 84;

interface Busy {
  label: string;
  done?: number;
  total?: number;
  unit?: 'percent';
}

export function DeskScreen({ deskId }: { deskId: string }) {
  const { repo, files, registry, locale } = useWorkspaceContext();
  // Displays drafts in draft mode (D-190): AI-modified toolbars and layouts are viewed here (D-406).
  const config = useWorkspace(shownConfig)!;
  const revisionId = useWorkspace((s) => s.head!.id);
  const bumpAssets = useWorkspace((s) => s.bumpAssets);
  const bumpRecords = useWorkspace((s) => s.bumpRecords);
  const palette = usePalette(useAppTheme(config));
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: screenHeight, width: screenWidth } = useWindowDimensions();
  const host = useRunHost(palette, locale);
  const { navigate, locked, inDraft } = useShellEnv();

  const [desk, setDeskState] = useState<Desk | null | 'gone'>(null);
  const deskRef = useRef<Desk | null>(null);
  const setDesk = (next: Desk) => {
    deskRef.current = next;
    setDeskState(next);
  };
  const [shownId, setShownId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [panel, setPanel] = useState<(AskRequest & { entry: ToolEntry }) | null>(null);
  const [sheet, setSheet] = useState(false);
  const [saved, setSaved] = useState(false);
  // Saved to phone (copied to the selected folder in the Files app): target folder destination.
  const [folderSaved, setFolderSaved] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const signal = useRef({ cancelled: false });
  const alive = useRef(true);
  /** Desk cleared: skip closing edits upon departure. */
  const cleared = useRef(false);
  /** Notified about unsupported formats when regenerating external files (D-509): logged once per desk session. */
  const toldRebuilt = useRef(false);
  // Desk is not retained (D-462, superseding "keep on desk initially"): cleared upon leaving; items
  // to keep must be saved or shared via "Done". When there are unsaved changes, prompts "Discard
  // changes?" before leaving (see beforeRemove below).
  useEffect(
    () => () => {
      if (cleared.current) return;
      cleared.current = true;
      void clearDesk(files, deskId);
    },
    [files, deskId],
  );
  /** Version number on the desk when saved: if unmodified afterwards, prompts for "Discard changes?" can be skipped. */
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    alive.current = true;
    void loadDesk(files, deskId)
      // Synthesize unclosed edits from the previous session (app terminated) into a single version.
      .then((d) => (d ? recoverEditDraft(files, d, Date.now()) : null))
      .then(
        (d) => {
          if (!alive.current) return;
          if (d) setDesk(d);
          else setDeskState('gone');
        },
        () => alive.current && setDeskState('gone'),
      );
    return () => {
      alive.current = false;
      signal.current.cancelled = true;
    };
  }, [files, deskId]);

  const layout = useMemo(() => resolveDeskLayout(config.containers.desk), [config.containers.desk]);
  const list = desk && desk !== 'gone' ? currentFiles(desk) : [];
  const shown = list.find((f) => f.id === shownId) ?? list[0] ?? null;
  const kind = shown ? deskKindOf(shown) : 'other';
  // Targets match all files of the same kind as the current view when shown (e.g., combining 5 photos into a single PDF).
  const targets = shown ? list.filter((f) => deskKindOf(f) === kind) : [];
  const tools = useMemo(
    () =>
      toolEntries(
        deskToolbar(kind, layout.tools, registry, quickActionsOf(config), locale),
        targets,
        registry,
        quickActionsOf(config),
        locale,
      ),
    // Targets depend on list and kind changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, layout.tools, registry, config.tools, locale, list],
  );
  const groups = [...tools, roomEntries(locale, kind)];

  const edit = useDeskEdit({
    files,
    desk: deskRef,
    file: shown,
    onSealed: (next, fileId) => {
      setDesk(next);
      setShownId(fileId);
    },
  });
  // Synthesizes edits upon leaving the room or moving app to background (using latest edit: its seal is a read-only ref).
  const editRef = useRef(edit);
  useEffect(() => {
    editRef.current = edit;
  });
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && !cleared.current) void editRef.current.seal();
    });
    return () => {
      sub.remove();
      if (!cleared.current) void editRef.current.seal();
    };
  }, []);
  // Unsaved changes when going back (via button or gesture): prompts "Discard changes?" first (2026-11-06 test: watermark added, cells edited, going back silently discarded them).
  const leave = useConfirmLeave(
    desk !== null && desk !== 'gone' && (edit.dirty || desk.current !== savedAt),
    'deskDiscardMessage',
    locale,
  );
  const onSelecting = useCallback((on: boolean) => setSelecting(on), []);
  // Navigation bar sits below the keyboard when open, eliminating the need to reserve bottom height.
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const subs = [
      Keyboard.addListener('keyboardDidShow', () => setKeyboard(true)),
      Keyboard.addListener('keyboardDidHide', () => setKeyboard(false)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  if (desk === null) {
    return <ActivityIndicator style={[styles.flex, { backgroundColor: palette.background }]} />;
  }
  if (desk === 'gone') {
    return (
      <View
        testID="desk-gone"
        style={[styles.center, { backgroundColor: palette.background, paddingTop: insets.top }]}>
        <Text style={[palette.font('body', 15), { color: palette.muted }]}>
          {t(locale, 'deskGone')}
        </Text>
        <Button palette={palette} label={t(locale, 'close')} onPress={() => router.back()} />
      </View>
    );
  }

  const label = (step: Workflow['steps'][number]) =>
    stepLabel(registry.actions.get(step.action), step.params, locale) ?? step.action;

  async function run(workflow: Workflow, by: DeskStep, on: readonly DeskFile[]) {
    const current = deskRef.current;
    if (!current || busy) return;
    setError(null);
    setSaved(false);
    setFolderSaved(null);
    const steps = workflow.steps;
    setBusy({ label: label(steps[Math.min(1, steps.length - 1)]!) });
    signal.current = { cancelled: false };
    const onEvent = (e: RunEvent) => {
      if (!alive.current || e.index === 0) return;
      setBusy((b) =>
        e.kind === 'step'
          ? { label: label(steps[e.index]!) }
          : {
              label: b?.label ?? label(steps[e.index]!),
              done: e.done,
              total: e.total,
              ...(e.unit ? { unit: e.unit } : {}),
            },
      );
    };
    const started = await startRun({
      workflow,
      revisionId,
      repo,
      files,
      registry,
      locale,
      now: () => new Date(),
      newId: newAssetId,
      ui: host.ui,
      collections: config.data.tables,
      calendar: calendarOf(config),
      packs: host.packs ?? null,
      ...(host.askParams ? { askParams: host.askParams } : {}),
      ...(host.ensurePack ? { ensurePack: host.ensurePack } : {}),
      ...(host.ensurePacks ? { ensurePacks: host.ensurePacks } : {}),
      signal: signal.current,
      onEvent,
      incoming: await deskPickedWithSources(files, current, on),
    });
    try {
      const result = started.result;
      if (result.status === 'succeeded') {
        const before = new Set(currentFiles(current).map((f) => f.id));
        const commit = await commitRun(
          files,
          current,
          on.map((f) => f.id),
          result.value,
          by,
          nowMs(),
        );
        if (!alive.current) return;
        if (commit.desk !== current) {
          setDesk(commit.desk);
          // View the newly generated first item (result of conversion or splitting).
          const fresh = currentFiles(commit.desk).find((f) => !before.has(f.id));
          if (fresh) setShownId(fresh.id);
        }
        if (commit.text !== undefined) setText(commit.text);
        if (result.saved.length > 0) bumpAssets();
      } else if (result.status === 'failed' && alive.current) {
        setError(runErrorText(locale, result.error.code, result.error.detail));
      }
      if (workflow.steps.some((s) => s.action === 'out.addRecord')) bumpRecords();
    } catch (e) {
      if (alive.current) setError(String(e instanceof Error ? e.message : e));
    } finally {
      await started.dispose();
      if (alive.current) setBusy(null);
    }
  }

  /** Current desk files of the same kind as the currently viewed one after sealing edits (tools apply to them). */
  async function sealedTargets(): Promise<DeskFile[]> {
    const d = (await edit.seal()) ?? deskRef.current;
    return d ? currentFiles(d).filter((f) => deskKindOf(f) === kind) : [];
  }

  async function press(entry: ToolEntry) {
    if (busy) return;
    // View-only in draft mode (D-190).
    if (locked) return locked();
    // Synthesize edits into a single version before using other tools, saving, or sharing (§11.2).
    const on = await sealedTargets();
    if (entry.room === 'share') return void act(shareAll);
    if (entry.room === 'save') return void act(save);
    if (entry.room === 'folder') return void act(saveToPhone);
    if (entry.room === 'preview') return systemPreview();
    if (entry.workflow) {
      void run(entry.workflow, { kind: 'workflow', workflowId: entry.workflow.id }, on);
      return;
    }
    const item = entry.item;
    if (typeof item !== 'object') return;
    const action = registry.actions.get(item.action)!;
    const preset = item.preset ? action.presets?.find((p) => p.id === item.preset) : undefined;
    const params = preset ? { ...preset.values } : initialParams(action);
    const keys = deskToolAsks(action);
    // When there are parameters to prompt for and it is not a manual tool: pops up the parameter
    // panel first, executing only upon tapping "Apply" (results are unknown until execution
    // finishes, D-360). Parameterless tools (recognition category, D-278) run immediately (D-363).
    if (!preset && !action.local && keys.length > 0) {
      setPanel({
        entry,
        step: { id: 'desk-step', action: action.id, params },
        action,
        keys,
        params,
        input: null,
      });
      return;
    }
    void applyTool(action.id, params);
  }

  async function applyTool(actionId: string, params: Record<string, unknown>) {
    const on = await sealedTargets();
    const workflow = deskToolWorkflow(actionId, on, registry, params);
    if (!workflow) return;
    void run(workflow, { kind: 'action', action: actionId }, on);
  }

  const nowFiles = () => (deskRef.current ? currentFiles(deskRef.current) : list);
  const items = () =>
    nowFiles().map((f) => ({
      uri: deskFileUri(files, desk, f.path),
      name: f.name,
      ext: f.ext,
      mimeType: f.mimeType,
      size: f.size,
    }));

  /**
   * Files to save or share contain modified external docx / xlsx files (regenerated, D-509):
   * explains which formats are dropped on the first occurrence via a prompt, proceeding only upon
   * tapping "Continue", while "Cancel" does nothing. Unmodified external files save copies of
   * their originals without requiring a prompt.
   */
  function confirmRebuilt(list: readonly DeskFile[]): Promise<boolean> {
    const kinds = new Set(
      list.filter((f) => f.source?.imported === 'rebuilt').map((f) => f.source!.kind),
    );
    if (toldRebuilt.current || kinds.size === 0) return Promise.resolve(true);
    const message = [
      ...(kinds.has('doc') ? [t(locale, 'officeRebuiltDoc')] : []),
      ...(kinds.has('table') ? [t(locale, 'officeRebuiltSheet')] : []),
    ].join('\n\n');
    return new Promise((resolve) => {
      Alert.alert(
        t(locale, 'officeRebuiltTitle'),
        message,
        [
          { text: t(locale, 'cancel'), style: 'cancel', onPress: () => resolve(false) },
          {
            text: t(locale, 'officeRebuiltContinue'),
            onPress: () => {
              toldRebuilt.current = true;
              resolve(true);
            },
          },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      );
    });
  }

  /** Share desk files (toolbar / "Share" in "Done"). */
  async function shareAll() {
    if (await confirmRebuilt(nowFiles())) await files.shareUris(items());
  }

  /** Save as user files; Excel and Word conversion results retain intermediate formats and original images so they can be re-edited on the desk later (D-367). */
  async function save() {
    const d = deskRef.current;
    if (!d) return;
    if (!(await confirmRebuilt(currentFiles(d)))) return;
    await saveDeskFiles(files, repo, d, currentFiles(d), {
      now: () => new Date(),
      newId: newAssetId,
    });
    bumpAssets();
    setSavedAt(d.current);
    setSaved(true);
  }

  /**
   * Save to phone: each time, let the user pick a folder in the Files app and copy the file into
   * it (D-120); on cancel, nothing changes. For edited external docx / xlsx, warn beforehand
   * about which formats are not kept, just like saving and sharing (D-509). Once saved, it counts
   * as saved: if not modified further, leaving no longer prompts with "Discard changes?" (D-512).
   */
  async function saveToPhone() {
    if (!(await confirmRebuilt(nowFiles()))) return;
    const d = deskRef.current;
    const done = await files.saveToFolder(items(), 'desk', true);
    if (!done) return;
    setFolderSaved(done.folder);
    if (d) setSavedAt(d.current);
  }

  async function act(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(
        code
          ? runErrorText(locale, code, (e as { detail?: Record<string, string> }).detail)
          : String(e),
      );
    }
  }

  /**
   * "Use original image" (D-467): crop the box area (in original image pixels) from the original
   * image of this page, and save it as a temp file; move it into the desk when closing the
   * editor. The OCR image and the original image may have different dimensions, scale
   * proportionally.
   */
  async function cropOriginal(page: DocPage, box: Box): Promise<string | null> {
    const current = deskRef.current;
    if (!current || !page.source) return null;
    try {
      const size = await files.imageSize(page.source);
      const kx = size.width / page.width;
      const ky = size.height / page.height;
      const x = Math.max(0, Math.round(box.x * kx));
      const y = Math.max(0, Math.round(box.y * ky));
      const crop = {
        x,
        y,
        width: Math.max(1, Math.min(size.width - x, Math.round(box.width * kx))),
        height: Math.max(1, Math.min(size.height - y, Math.round(box.height * ky))),
      };
      const out = await files.transformImage(
        page.source,
        { crop },
        { format: 'jpeg', quality: 0.9 },
        `desk-${current.id}`,
        `original-${Date.now()}.jpg`,
      );
      return out.uri;
    } catch {
      setError(t(locale, 'wordOriginalFailed'));
      return null;
    }
  }

  const systemPreview = () =>
    shown &&
    void act(() =>
      files.previewFile({
        uri: deskFileUri(files, desk, shown.path),
        mimeType: shown.mimeType,
        name: `${shown.name}.${shown.ext}`,
      }),
    );

  /**
   * Desk populated from a record's attachment (D-395): "Done" always asks whether to "Add as new
   * attachment" or "Replace original"; on cancel, opens "Done" as usual, record unchanged. If
   * attachments are full, only replacement is allowed. When the form is already closed, it acts
   * as a normal desk.
   */
  function finish() {
    const back = deskReturnOf(deskId);
    const d = deskRef.current;
    const ids = back?.ids();
    if (!back || !ids || !d) return setSheet(true);
    const can = deskReturnChoices(ids, back.assetId, currentFiles(d).length);
    Alert.alert(
      t(locale, 'deskBackTitle'),
      t(locale, can.add ? 'deskBackMessage' : can.replace ? 'deskBackFull' : 'deskBackNoRoom'),
      [
        ...(can.add
          ? [
              {
                text: t(locale, 'deskBackAdd'),
                onPress: () => void act(() => giveBack(back, 'add')),
              },
            ]
          : []),
        ...(can.replace
          ? [
              {
                text: t(locale, 'deskBackReplace'),
                onPress: () => void act(() => giveBack(back, 'replace')),
              },
            ]
          : []),
        { text: t(locale, 'cancel'), style: 'cancel' as const, onPress: () => setSheet(true) },
      ],
    );
  }

  /** Save files on the desk as user files and return them to the form (still requires the user to tap save), then clear this desk and return to the form. */
  async function giveBack(back: DeskReturn, mode: DeskReturnMode) {
    const d = deskRef.current;
    if (!d) return;
    if (!(await confirmRebuilt(currentFiles(d)))) return;
    const fresh = await saveDeskFiles(files, repo, d, currentFiles(d), {
      now: () => new Date(),
      newId: newAssetId,
    });
    bumpAssets();
    // The form closed in the meantime: the newly saved file is unused, delete it; keep the desk.
    if (!back.deliver(mode, fresh)) {
      await deleteUserFiles(fresh, repo, files);
      return;
    }
    endDeskReturn(deskId);
    cleared.current = true;
    await clearDesk(files, deskId);
    leave();
  }

  const allImages = list.every((f) => deskKindOf(f) === 'image');
  const printable = list.every((f) => ['image', 'pdf'].includes(deskKindOf(f)));
  const env: RenderEnv = {
    config,
    palette,
    locale,
    registry,
    interactive: true,
    navigate,
    ...(locked ? { locked } : {}),
  };
  const slot = (components: typeof layout.above, id: string) =>
    components.length > 0 ? (
      <View testID={id} style={[styles.slot, { gap: palette.gap }]}>
        {components.map((c) => (
          <Item key={c.id} component={c} env={env} />
        ))}
      </View>
    ) : null;

  const toolbar = (
    <View
      style={[
        styles.toolbar,
        palette.cardStyle(palette.surface),
        {
          borderRadius: Math.min(palette.radius + 6, 32),
          margin: 0,
          padding: 0,
          marginHorizontal: 12,
          marginVertical: 8,
          ...(layout.toolbar === 'bottom' ? { marginBottom: Math.max(insets.bottom, 12) } : {}),
        },
      ]}>
      {targets.length > 1 ? (
        <Text
          testID="desk-targets"
          style={[palette.font('body', 12), styles.targets, { color: palette.caption }]}>
          {t(locale, 'deskTargets', { n: targets.length })}
        </Text>
      ) : null}
      {tools.length === 0 ? (
        <Text
          testID="desk-no-tools"
          style={[palette.font('body', 13), styles.targets, { color: palette.muted }]}>
          {t(locale, 'deskNoTools')}
        </Text>
      ) : null}
      <DeskToolbar groups={groups} palette={palette} disabled={busy !== null} onPress={press} />
    </View>
  );

  // Top bar has only one set of undo (§10 question 4): when the editor is open, step through edits; otherwise, undo the whole version.
  const editHistory = edit.session?.history;
  // Allow undo even when freshly typed text on the page has not yet been merged into a single step (D-465).
  const editUndo = (editHistory?.past.length ?? 0) > 0 || edit.dirty;
  const editRedo = (editHistory?.future.length ?? 0) > 0;
  const showToolbar = !selecting;
  // When the bottom toolbar is absent (content selected and switched to edit layer, toolbar at the top), leave room at the very bottom of the view for the system navigation bar (Samsung real device, 2026-10-30).
  const bottomInset =
    (layout.toolbar !== 'bottom' || !showToolbar) && !keyboard ? insets.bottom : 0;
  const preview = !shown ? null : shown.source && edit.session !== null ? (
    edit.session === undefined ? (
      <ActivityIndicator style={styles.flex} color={palette.primary} />
    ) : edit.session.kind === 'doc' ? (
      <WordEditor
        key={edit.session.fileId}
        doc={edit.session.history.present as DocDoc}
        palette={palette}
        locale={locale}
        width={screenWidth}
        readImage={(uri) => files.readUri(uri)}
        cropOriginal={cropOriginal}
        onApply={edit.apply}
        onSelecting={onSelecting}
        onTyping={edit.typing}
      />
    ) : (
      <DeskEditor
        key={edit.session.fileId}
        doc={edit.session.history.present as TableDoc}
        palette={palette}
        locale={locale}
        width={screenWidth}
        onApply={edit.apply}
        onSelecting={onSelecting}
      />
    )
  ) : (
    // D-488: Large previews for images and PDFs are placed inside a rounded "paper card" (same as the preview page): outer layer gets a shadow, inner layer is clipped with rounded corners.
    <View
      style={[styles.paper, palette.cardStyle(palette.surface), { borderRadius: palette.radius }]}>
      <View style={[styles.paperClip, { borderRadius: Math.max(0, palette.radius - 2) }]}>
        <DeskPreview
          desk={desk}
          file={shown}
          files={files}
          palette={palette}
          locale={locale}
          onSystemPreview={systemPreview}
        />
      </View>
    </View>
  );

  return (
    // Android also needs padding: full-screen pages do not shrink with the keyboard, Samsung
    // keyboard covers editing input fields (same as AskPanel). When the window actually shrinks,
    // the keyboard no longer overlaps the page, and padding is 0.
    <KeyboardAvoidingView
      testID="desk-screen"
      behavior="padding"
      style={[styles.flex, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderColor: palette.border }]}>
        <HeaderButton
          id="desk-close"
          text="‹"
          palette={palette}
          onPress={() => router.back()}
          disabled={busy !== null}
          bold
        />
        <Text
          numberOfLines={1}
          style={[palette.font('title', 17), styles.flex, { color: palette.text }]}>
          {shown ? `${shown.name}.${shown.ext}` : ''}
        </Text>
        {busy === null ? (
          <AIEntry about={{ kind: 'desk', fileKind: kind }} palette={palette} />
        ) : null}
        <HeaderButton
          id="desk-undo"
          text="↶"
          label={t(locale, 'undo')}
          palette={palette}
          onPress={() =>
            editUndo ? edit.undo() : void undo(files, desk, Date.now()).then(setDesk)
          }
          disabled={busy !== null || !(editUndo || canUndo(desk))}
        />
        <HeaderButton
          id="desk-redo"
          text="↷"
          label={t(locale, 'tableRedo')}
          palette={palette}
          onPress={() =>
            editRedo ? edit.redo() : void redo(files, desk, Date.now()).then(setDesk)
          }
          disabled={busy !== null || !(editRedo || (!edit.dirty && canRedo(desk)))}
        />
        <HeaderButton
          id="desk-done"
          text={t(locale, 'done')}
          primary
          palette={palette}
          onPress={() =>
            void edit.seal().then(() => {
              setSaved(false);
              setFolderSaved(null);
              finish();
            })
          }
          disabled={busy !== null}
          bold
        />
      </View>

      {inDraft ? null : <BannerAnchor palette={palette} />}
      {layout.toolbar === 'top' && showToolbar ? toolbar : null}
      {slot(layout.above, 'desk-above')}
      <View
        style={
          layout.preview === 'fill'
            ? styles.flex
            : { height: Math.round(screenHeight * PREVIEW_SHARE[layout.preview]) }
        }>
        {preview}
        {busy ? (
          <BusyCover
            busy={busy}
            palette={palette}
            locale={locale}
            onCancel={() => {
              signal.current.cancelled = true;
            }}
          />
        ) : null}
      </View>
      {error ? (
        <Text
          testID="desk-error"
          style={[palette.font('bodyMedium', 14), styles.error, { color: palette.danger }]}>
          {error}
        </Text>
      ) : null}
      {saved && !sheet ? (
        <Text
          testID="desk-saved"
          style={[palette.font('bodyMedium', 14), styles.error, { color: palette.caption }]}>
          {t(locale, 'resultSaved')}
        </Text>
      ) : null}
      {folderSaved && !sheet ? (
        <Text
          testID="desk-folder-saved"
          style={[palette.font('bodyMedium', 14), styles.error, { color: palette.caption }]}>
          {t(locale, 'resultFolderDone', { name: folderName(locale, folderSaved) })}
        </Text>
      ) : null}
      {layout.strip && list.length > 1 ? (
        <ScrollView
          horizontal
          testID="desk-strip"
          // Single row normal height (horizontal ScrollView defaults to flexGrow: 1, which would cause it to be stretched).
          style={styles.bar}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.strip}>
          {list.map((f, i) => {
            const on = f === shown;
            return (
              <Pressable
                key={f.id}
                testID={`desk-file-${i}`}
                onPress={() => void edit.seal().then(() => setShownId(f.id))}
                style={[
                  styles.chip,
                  {
                    borderColor: on ? palette.primary : palette.border,
                    backgroundColor: on ? palette.primaryTint : palette.surface,
                  },
                ]}>
                <Text
                  numberOfLines={1}
                  style={[palette.font(on ? 'bodyBold' : 'body', 13), { color: palette.text }]}>
                  {`${f.name}.${f.ext}`}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {slot(layout.below, 'desk-below')}
      {layout.preview === 'fill' ? null : <View style={styles.flex} />}
      {layout.toolbar === 'bottom' && showToolbar ? toolbar : null}
      {bottomInset > 0 ? <View testID="desk-bottom-inset" style={{ height: bottomInset }} /> : null}
      {/* The four draft buttons do not obscure the toolbar: the toolbar is what needs to be seen. */}
      {inDraft ? <View style={{ height: DRAFT_BAR_SPACE + insets.bottom }} /> : null}

      {panel ? (
        <AskPanel
          request={panel}
          palette={palette}
          locale={locale}
          now={new Date()}
          okLabel={t(locale, 'deskApply')}
          onAnswer={(answer) => {
            const p = panel;
            setPanel(null);
            if (answer) {
              // Passwords are not included in the parameters structure, the executor will prompt for them again at runtime (D-194).
              const params = { ...p.params, ...answer };
              for (const f of p.action.fields) if (f.kind === 'secret') delete params[f.key];
              applyTool(p.action.id, params);
            }
          }}
        />
      ) : null}
      {host.elements}

      {text !== null ? (
        <Dialog
          palette={palette}
          locale={locale}
          visible
          animationType="fade"
          onClose={() => setText(null)}
          backdropLabel={t(locale, 'close')}
          style={[
            styles.dialog,
            { backgroundColor: palette.surface, borderRadius: palette.radius },
          ]}>
          <Text style={[palette.font('title', 18), { color: palette.text }]}>
            {t(locale, 'deskTextTitle')}
          </Text>
          <ScrollView style={styles.textScroll}>
            <Text
              selectable
              testID="desk-text"
              style={[palette.font('body', 15), { color: palette.text }]}>
              {text}
            </Text>
          </ScrollView>
          <Text style={[palette.font('body', 13), { color: palette.caption }]}>
            {t(locale, 'resultTextNote')}
          </Text>
          <View style={styles.actions}>
            <HeaderButton
              id="desk-text-copy"
              text={t(locale, 'resultCopy')}
              palette={palette}
              onPress={() => void act(() => files.copyText(text))}
            />
            <HeaderButton
              id="desk-text-close"
              text={t(locale, 'close')}
              palette={palette}
              onPress={() => setText(null)}
              bold
            />
          </View>
        </Dialog>
      ) : null}

      {sheet ? (
        <BottomSheet
          palette={palette}
          locale={locale}
          visible
          animationType="fade"
          onClose={() => setSheet(false)}
          backdropTestID="desk-sheet-backdrop"
          backdropLabel={t(locale, 'close')}
          bottomPadding={8}
          style={[
            styles.sheet,
            {
              backgroundColor: palette.surface,
              borderColor: palette.border,
            },
          ]}>
          <SheetRow
            id="desk-save"
            label={t(locale, saved ? 'resultSaved' : 'resultSave')}
            palette={palette}
            disabled={saved}
            onPress={() => void act(save)}
          />
          <SheetRow
            id="desk-folder"
            label={
              folderSaved
                ? t(locale, 'resultFolderDone', { name: folderName(locale, folderSaved) })
                : t(locale, 'resultFolder')
            }
            palette={palette}
            onPress={() => void act(saveToPhone)}
          />
          <SheetRow
            id="desk-share"
            label={t(locale, 'resultShare')}
            palette={palette}
            onPress={() => void act(shareAll)}
          />
          {allImages ? (
            <SheetRow
              id="desk-photos"
              label={t(locale, 'resultPhotos')}
              palette={palette}
              onPress={() => void act(() => files.saveToPhotos(items().map((i) => i.uri)))}
            />
          ) : null}
          {printable ? (
            <SheetRow
              id="desk-print"
              label={t(locale, 'resultPrint')}
              palette={palette}
              onPress={() =>
                void act(async () => {
                  for (const item of items()) await files.print(item);
                })
              }
            />
          ) : null}
          <SheetRow
            id="desk-sheet-preview"
            label={t(locale, 'deskSystemPreview')}
            palette={palette}
            onPress={() => {
              setSheet(false);
              systemPreview();
            }}
          />
          <SheetRow
            id="desk-sheet-cancel"
            label={t(locale, 'cancel')}
            palette={palette}
            onPress={() => setSheet(false)}
          />
        </BottomSheet>
      ) : null}
      {inDraft ? (
        <>
          {/* Top bar height is 56 (same as the header above), Tink is to the left of the undo, redo, and finish buttons: about 190 from the right. */}
          <DraftBar
            palette={palette}
            bottom={insets.bottom + 12}
            top={insets.top + 56 + 8}
            tinkRight={190}
          />
          <Toast palette={palette} bottom={insets.bottom + DRAFT_BAR_SPACE} />
        </>
      ) : null}
    </KeyboardAvoidingView>
  );
}

/**
 * Top bar buttons (D-488): back, undo, and redo are light circular small buttons, "Finish" is a
 * primary-color filled pill (primary action). text is the displayed label; dims when disabled.
 */
function HeaderButton({
  id,
  text,
  palette,
  onPress,
  disabled = false,
  bold = false,
  primary = false,
  label,
}: {
  id: string;
  text: string;
  palette: Palette;
  onPress: () => void;
  disabled?: boolean;
  bold?: boolean;
  /** Primary action: primary-color filled. */
  primary?: boolean;
  /** Screen reader label (used when text is a symbol). */
  label?: string;
}) {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label ?? text}
      hitSlop={6}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.headerButton,
        { backgroundColor: primary ? palette.primary : palette.primaryTint },
        { opacity: disabled ? 0.35 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] },
      ]}>
      <Text
        style={[
          palette.font(bold || primary ? 'bodyBold' : 'bodyMedium', primary ? 15 : 16),
          { color: primary ? palette.onPrimary : palette.primaryText },
        ]}>
        {text}
      </Text>
    </Pressable>
  );
}

function SheetRow({
  id,
  label,
  palette,
  onPress,
  danger,
  disabled,
}: {
  id: string;
  label: string;
  palette: Palette;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.sheetRow, { opacity: disabled ? 0.5 : pressed ? 0.6 : 1 }]}>
      <Text style={[palette.font('body', 16), { color: danger ? palette.danger : palette.text }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Overlay on the preview when running a tool: name of this step, progress, stop. */
function BusyCover({
  busy,
  palette,
  locale,
  onCancel,
}: {
  busy: Busy;
  palette: Palette;
  locale: 'en' | 'zh' | 'fr';
  onCancel: () => void;
}) {
  const amount =
    busy.total && busy.total > 0
      ? ` · ${t(locale, busy.unit === 'percent' ? 'runPercent' : 'runProgress', {
          done: busy.done ?? 0,
          total: busy.total,
        })}`
      : '';
  return (
    <View
      testID="desk-busy"
      style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: palette.scrim }]}>
      <View
        style={[
          styles.busyCard,
          { backgroundColor: palette.surface, borderRadius: palette.radius },
        ]}>
        <ActivityIndicator color={palette.primary} />
        <Text style={[palette.font('bodyMedium', 15), { color: palette.text }]}>
          {`${busy.label}${amount}`}
        </Text>
        <Button
          palette={palette}
          variant="outline"
          testID="desk-cancel"
          label={t(locale, 'runCancel')}
          onPress={onCancel}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    // Same height as the page stack navigation bar (used by the preview page), preventing the top bar from jumping when entering the desk from the preview page.
    minHeight: Platform.OS === 'ios' ? 44 : 56,
  },
  headerButton: {
    minWidth: 36,
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolbar: { marginHorizontal: 12, marginVertical: 8, overflow: 'hidden' },
  paper: { flex: 1, marginHorizontal: 12, marginTop: 2 },
  paperClip: { flex: 1, overflow: 'hidden' },
  targets: { paddingHorizontal: 14, paddingTop: 6 },
  slot: { paddingHorizontal: 12, paddingVertical: 8 },
  error: { paddingHorizontal: 16, paddingVertical: 6 },
  bar: { flexGrow: 0, flexShrink: 0 },
  strip: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
  },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    minHeight: 32,
    justifyContent: 'center',
    maxWidth: 200,
  },
  cover: { alignItems: 'center', justifyContent: 'center' },
  busyCard: { padding: 20, gap: 12, alignItems: 'center', minWidth: 220 },
  dialog: { padding: 22, gap: 14, maxHeight: '100%' },
  textScroll: { flexGrow: 0, flexShrink: 1 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 24 },
  sheet: {
    padding: 16,
    gap: 2,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sheetRow: { minHeight: 48, justifyContent: 'center' },
});
