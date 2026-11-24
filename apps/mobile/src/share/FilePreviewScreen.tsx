import {
  deskKindOf,
  quickActionsOf,
  sharedSizeProblem,
  type DeskFile,
  type IconName,
  type Workflow,
} from '@morph/core';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  importOffice,
  isImportableOffice,
  type DocDoc,
  type OfficeImport,
} from '@morph/tool-office';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DeskPreview, type OfficePreview } from '../desk/DeskPreview';
import { placeAssetOnDesk, savedWordDoc } from '../desk/saved-source';
import { loadDesk, placeOnDesk } from '../desk/store';
import { folderName, runErrorText, t, type StringKey } from '../i18n';
import { useFileBundleOffer } from '../packs/FileBundleOffer';
import { formatSize } from '../renderer/FileList';
import { BottomSheet } from '../renderer/Overlays';
import { Icon, UiIcon } from '../renderer/Icon';
import { usePalette } from '../renderer/theme';
import { Card, SectionLabel } from '../renderer/ui';
import { baseName, extOf, extOfMime, mimeOf } from '../runtime/actions/helpers';
import { AIEntryButton } from '../shell/ai-entry';
import type { SucceededRuns } from '../storage/types';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '../workspace/context';
import { releaseShare, useIncoming } from './incoming';
import { RecordChooser, useSaveAsRecord } from './RecordChooser';
import { shareRecommendations } from './recommendations';

const now = () => Date.now();

/** Category of a quick action under 'More': first check for format conversion, then organization, then processing tasks like recognition or compression. */
function previewCategory(wf: Workflow): 'convert' | 'process' | 'manage' | 'quick' {
  const actions = wf.steps.map((st) => st.action).filter((id) => !/^(in|out)\./.test(id));
  const any = (re: RegExp) => actions.some((id) => re.test(id));
  if (any(/\.(to[A-Z]\w*|from[A-Z]\w*|convert)$/)) return 'convert';
  if (
    any(/\.(merge|split|pages|selectPages|rotate|protect|unlock|sign|fillForm|pageNumbers|stamp)$/)
  )
    return 'manage';
  if (
    any(
      /^(ocr|translate|scan)\.|\.(compress|resize|adjust|redact|removeBackground|extractText|enhance)$/,
    )
  )
    return 'process';
  return 'quick';
}

type Panel = 'share' | 'record' | 'more';

/**
 * A preview page for a file (D-457): opened directly when receiving a file (via share, picker, or
 * post-scan continuation), replacing the inbox page. It is a container (D-428): displays the file
 * in read-only mode and runs nothing upon entry; the buttons at the bottom only reference tools,
 * running or opening them only when tapped -- editing a PDF opens the desk, converting to Word
 * runs built-in quick actions (jumping straight to Word upon completion, discarding on return),
 * saving records and quick actions, with tools presented in a pop-up panel. All navigations use
 * push, returning back to this page with the received file still intact (the running page carries
 * keep, preventing release of this batch). Files are displayed locally only and are never sent to
 * the AI. Provided by core; cannot be modified by the AI.
 *
 * When `index` has a value, it indicates viewing one file from a multi-file inbox page:
 * view-only, without tool attachment or batch release management.
 */
export function FilePreviewScreen({ index }: { index?: number }) {
  const { repo, files, locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const palette = usePalette(useAppTheme(config));
  const share = useIncoming((s) => s.share);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const member = index !== undefined;
  const file = share?.files[index ?? 0];
  // Query the file processing bundle once after sharing or opening a file (D-456); do not prompt again once queried. Already prompted by the inbox page when there are multiple files.
  const bundle = useFileBundleOffer(palette, locale);
  const fromOutside = !member && !!share && share.files.length > 0 && share.source !== 'result';
  useEffect(() => {
    if (fromOutside) bundle.offer();
    // View each batch of files only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share?.id]);

  // Returned here after the AI creates a new quick action (D-129): the new one is placed at the top and tagged 'Just made', with the panel opened directly so the user can see it.
  const { made } = useLocalSearchParams<{ made?: string }>();
  const [panel, setPanel] = useState<Panel | null>(made && !member ? 'more' : null);
  const [busy, setBusy] = useState(false);
  // The desk placed onto for this page: tapping 'Edit' again returns to the same one, rather than copying a new one each time.
  const [deskId, setDeskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Message displayed after saving to the phone indicating which file was saved and where (D-583).
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const record = useSaveAsRecord(share?.files ?? [], () => setPanel(null));
  // Do not rank recommendations until usage counts are loaded, same as the inbox page.
  const [usage, setUsage] = useState<SucceededRuns | null>(null);
  useEffect(() => {
    if (member) return;
    let alive = true;
    void repo
      .countSucceededRuns()
      .then((counts) => alive && setUsage(counts))
      .catch(() => alive && setUsage(new Map()));
    return () => {
      alive = false;
    };
  }, [repo, share?.id, member]);
  // Releasing the received batch upon leaving this page (D-116); the running page and desk are
  // pushed on top, so this page remains active and is not released prematurely. Set to true when
  // handed over to the AI: AI modifications will open a new preview page carrying this batch,
  // without deleting files here (same as the inbox page).
  const handed = useRef(false);
  useFocusEffect(
    useCallback(() => {
      handed.current = false;
    }, []),
  );
  useEffect(() => {
    const id = share?.id;
    handed.current = false;
    return () => {
      if (!member && !handed.current && id !== undefined) void releaseShare(files, id);
    };
  }, [files, share?.id, member]);

  // Saved Word document (D-470): displayed according to its intermediate format, same as the editor page.
  const [wordDoc, setWordDoc] = useState<DocDoc | null>(null);
  const assetId = file?.assetId;
  useEffect(() => {
    if (!assetId) return;
    let alive = true;
    void repo
      .getAsset(assetId)
      .then((asset) => (asset ? savedWordDoc(files, asset) : null))
      .then((doc) => alive && setWordDoc(doc))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [repo, files, assetId]);

  const info = useMemo(
    () =>
      file
        ? { name: file.name, mimeType: mimeOf(file.name, file.mimeType), size: file.size }
        : null,
    [file],
  );
  // External docx / xlsx files (D-509): read into intermediate format for display; read in memory
  // only without writing anything (viewing changes nothing, invariant 15). The successfully read
  // instance is tracked by file path: if the file changes or is not yet read, it is 'still
  // reading'.
  const officeExt = file ? extOf(file.name) || extOfMime(file.mimeType) : '';
  const fileUri = file?.uri;
  const importable = !!fileUri && isImportableOffice(officeExt);
  const [read, setRead] = useState<{ uri: string; result: OfficeImport } | null>(null);
  const office: OfficePreview | null = !importable
    ? null
    : read?.uri === fileUri
      ? read.result
      : 'loading';
  useEffect(() => {
    if (!fileUri || !importable) return;
    let alive = true;
    void files
      .readUri(fileUri)
      .then(
        (bytes) =>
          importOffice(bytes, officeExt) ?? { ok: false as const, error: 'notOffice' as const },
      )
      .then(
        (result) => alive && setRead({ uri: fileUri, result }),
        () => alive && setRead({ uri: fileUri, result: { ok: false, error: 'damaged' } }),
      );
    return () => {
      alive = false;
    };
  }, [files, fileUri, officeExt, importable]);
  const shown = useMemo<DeskFile | null>(() => {
    if (!file || !info) return null;
    const ext = extOf(file.name);
    return {
      id: 'preview',
      name: baseName(file.name) || file.name,
      ext,
      mimeType: info.mimeType,
      size: file.size ?? 0,
      path: '',
      ...(file.width && file.height ? { width: file.width, height: file.height } : {}),
    };
  }, [file, info]);

  if (!share || !file || !info || !shown) {
    return (
      <View style={[styles.empty, { padding: palette.pad }]} testID="share-screen">
        <Stack.Screen options={{ title: '' }} />
        <Text style={[palette.font('body', 15), { color: palette.muted }]}>
          {t(locale, 'shareGone')}
        </Text>
      </View>
    );
  }

  const kind = deskKindOf(shown);
  const sizeProblem = sharedSizeProblem([info]);
  const wordId = kind === 'pdf' ? 'pdf-doc-word' : kind === 'image' ? 'image-doc-word' : null;

  const systemPreview = async () => {
    setError(null);
    try {
      await files.previewFile({ uri: file.uri, mimeType: info.mimeType, name: file.name });
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(
        code
          ? runErrorText(locale, code, (e as { detail?: Record<string, string> }).detail)
          : String(e),
      );
    }
  };

  /** Place on desk to edit: copies a working copy on first use, leaving the original and the received batch untouched. Returns to this page on back. */
  async function edit() {
    if (busy) return;
    // Password-protected docx / xlsx files (D-509): cannot be opened or edited, so report directly.
    if (office && office !== 'loading' && !office.ok && office.error === 'encrypted') {
      setError(t(locale, 'officeLocked'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const existing = deskId ? await loadDesk(files, deskId) : null;
      // Stored xlsx / docx files in the document library with intermediate format (D-367): can
      // still be edited when placed on the desk (2026-11-06 Samsung: opening a saved Word file from
      // recent files and tapping edit resulted in only 'This file cannot be displayed', D-470).
      const asset =
        !existing && file!.assetId && /\.(xlsx|docx)$/i.test(file!.name)
          ? await repo.getAsset(file!.assetId)
          : null;
      const desk =
        existing ??
        (asset ? await placeAssetOnDesk(files, asset, now()) : null) ??
        (await placeOnDesk(files, [file!], now()));
      setDeskId(desk.id);
      router.push({ pathname: '/desk/[deskId]', params: { deskId: desk.id } });
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(
        code
          ? runErrorText(locale, code, (e as { detail?: Record<string, string> }).detail)
          : String(e),
      );
    } finally {
      setBusy(false);
    }
  }

  /** Run a quick action: use this file as the input for the first step; return to this page on back. */
  function run(workflowId: string, then?: 'desk') {
    setPanel(null);
    router.push({
      pathname: '/run/[workflowId]',
      params: { workflowId, shared: String(share!.id), keep: '1', ...(then ? { then } : {}) },
    });
  }

  function askAI() {
    handed.current = true;
    router.push({ pathname: '/change', params: { shared: String(share!.id) } });
  }

  const { all } = shareRecommendations(quickActionsOf(config), [info], usage ?? new Map(), locale);
  const fitting = usage === null ? [] : all.filter(({ fit }) => fit.ok);

  // D-488: The bottom bar is a rounded panel floating on the page; each button icon is set in a light circular background, with the first one (Edit) being a solid primary-color circle.
  const button = (
    id: string,
    icon: IconName,
    label: string,
    onPress: () => void,
    disabled?: boolean,
    primary?: boolean,
  ) => (
    <Pressable
      key={id}
      testID={id}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tool,
        { opacity: disabled ? 0.4 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] },
      ]}>
      <View
        style={[
          styles.toolIcon,
          { backgroundColor: primary ? palette.primary : palette.primaryTint },
        ]}>
        <Icon name={icon} size={20} color={primary ? palette.onPrimary : palette.primaryText} />
      </View>
      <Text
        numberOfLines={2}
        style={[palette.font('bodyMedium', 11), styles.toolLabel, { color: palette.text }]}>
        {label}
      </Text>
    </Pressable>
  );

  /** Sharing, saving to folder, saving to photo library, printing, system preview: actions performed on this file are always triggered solely by user taps (D-457). */
  const out = { uri: file.uri, name: shown.name, ext: shown.ext, mimeType: info.mimeType };
  async function act(fn: () => Promise<unknown>) {
    setError(null);
    setSavedNote(null);
    try {
      await fn();
      setPanel(null);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setPanel(null);
      setError(
        code
          ? runErrorText(locale, code, (e as { detail?: Record<string, string> }).detail)
          : String(e),
      );
    }
  }
  async function saveToPhone() {
    const done = await files.saveToFolder([out], 'preview', true);
    if (!done) return;
    setSavedNote(
      t(locale, 'previewSavedToFolder', {
        name: out.ext ? `${out.name}.${out.ext}` : out.name,
        folder: folderName(locale, done.folder),
      }),
    );
  }
  const shareRow = (id: string, label: string, onPress: () => void) => (
    <Pressable
      key={id}
      testID={id}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.sheetRow, pressed && { opacity: 0.6 }]}>
      <Text style={[palette.font('body', 16), { color: palette.text }]}>{label}</Text>
    </Pressable>
  );
  const shareRows = () => (
    <>
      {shareRow(
        'preview-share-send',
        t(locale, 'previewShareSend'),
        () => void act(() => files.shareUris([out])),
      )}
      {shareRow('preview-share-folder', t(locale, 'resultFolder'), () => void act(saveToPhone))}
      {kind === 'image'
        ? shareRow(
            'preview-share-photos',
            t(locale, 'resultPhotos'),
            () => void act(() => files.saveToPhotos([file.uri])),
          )
        : null}
      {kind === 'image' || kind === 'pdf'
        ? shareRow(
            'preview-share-print',
            t(locale, 'resultPrint'),
            () => void act(() => files.print(out)),
          )
        : null}
      {shareRow(
        'preview-share-system',
        t(locale, 'deskSystemPreview'),
        () => void act(systemPreview),
      )}
    </>
  );

  /** The most frequently used items in the top row of 'More': signature, printing, save to folder, sharing (referencing CamScanner). Executed only upon tap. */
  /** The most frequently used items in the top row of 'More': signature, printing, save to folder, sharing (referencing CamScanner). Executed only upon tap. */
  const moreTop = () => {
    const items: {
      id: string;
      icon: IconName;
      label: string;
      color: string;
      onPress: () => void;
    }[] = [];
    if (kind === 'pdf' || kind === 'image') {
      items.push({
        id: 'preview-more-sign',
        icon: 'signature',
        label: t(locale, 'previewMoreSign'),
        color: '#12A383',
        onPress: () => {
          setPanel(null);
          void edit();
        },
      });
      items.push({
        id: 'preview-more-print',
        icon: 'printer',
        label: t(locale, 'resultPrint'),
        color: '#2F6FED',
        onPress: () => void act(() => files.print(out)),
      });
    }
    items.push({
      id: 'preview-more-folder',
      icon: 'folder',
      label: t(locale, 'resultFolder'),
      color: '#F29D38',
      onPress: () => void act(saveToPhone),
    });
    items.push({
      id: 'preview-more-send',
      icon: 'share',
      label: t(locale, 'previewShare'),
      color: '#7A5AF8',
      onPress: () => void act(() => files.shareUris([out])),
    });
    return (
      <View style={[styles.grid, styles.section]} testID="preview-more-top">
        {items.map((it) => (
          <View key={it.id} style={styles.cell}>
            <Pressable
              testID={it.id}
              accessibilityRole="button"
              accessibilityLabel={it.label}
              onPress={it.onPress}
              style={({ pressed }) => [styles.cellPress, pressed && { opacity: 0.6 }]}>
              <View style={[styles.cellIcon, { backgroundColor: it.color }]}>
                <Icon name={it.icon} size={24} color="#FFFFFF" />
              </View>
              <Text
                numberOfLines={2}
                style={[palette.font('body', 12), styles.toolLabel, { color: palette.text }]}>
                {it.label}
              </Text>
            </Pressable>
          </View>
        ))}
      </View>
    );
  };

  const moreSections = () => {
    const sections: { id: string; title: StringKey; list: Workflow[] }[] = [
      { id: 'convert', title: 'previewCatConvert', list: [] },
      { id: 'process', title: 'previewCatProcess', list: [] },
      { id: 'manage', title: 'previewCatManage', list: [] },
      { id: 'quick', title: 'previewQuick', list: [] },
    ];
    for (const { wf } of fitting) sections.find((x) => x.id === previewCategory(wf))!.list.push(wf);
    const shown = sections.filter((x) => x.list.length > 0);
    if (shown.length === 0) {
      return (
        <Text style={[palette.font('body', 14), { color: palette.muted }]}>
          {t(locale, 'previewNothing')}
        </Text>
      );
    }
    return shown.map((x) => (
      <View key={x.id} testID={`preview-more-${x.id}`} style={styles.section}>
        <SectionLabel palette={palette}>{t(locale, x.title)}</SectionLabel>
        <View style={styles.grid}>
          {x.list.map((wf) => (
            <View key={wf.id} style={styles.cell} testID={`share-workflow-${wf.id}`}>
              <Pressable
                testID={`share-run-${wf.id}`}
                accessibilityRole="button"
                accessibilityLabel={wf.name}
                onPress={() => run(wf.id)}
                style={({ pressed }) => [styles.cellPress, pressed && { opacity: 0.6 }]}>
                <View style={[styles.cellIcon, { backgroundColor: palette.primaryTint }]}>
                  <Icon name={wf.icon ?? 'workflow'} size={24} color={palette.primaryText} />
                </View>
                <Text
                  numberOfLines={2}
                  style={[palette.font('body', 12), styles.toolLabel, { color: palette.text }]}>
                  {wf.name}
                  {made && wf.id === made && !wf.package
                    ? t(locale, 'ShareScreen_just_made_ed6c1')
                    : ''}
                </Text>
              </Pressable>
            </View>
          ))}
        </View>
      </View>
    ));
  };

  return (
    <View style={styles.flex} testID="share-screen">
      <Stack.Screen
        options={{
          title: file.name,
          headerTitle: () => (
            <View style={styles.titleBox} testID="preview-title">
              <Text numberOfLines={1} style={[palette.font('title', 17), { color: palette.text }]}>
                {file.name}
              </Text>
              <Text
                numberOfLines={1}
                style={[palette.font('bodyMedium', 12), { color: palette.caption }]}>
                {[shown.ext.toUpperCase(), shown.size > 0 ? formatSize(shown.size, locale) : '']
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          ),
          ...(member
            ? {}
            : {
                headerRight: () => (
                  <AIEntryButton palette={palette} locale={locale} onPress={askAI} />
                ),
              }),
        }}
      />
      <View style={styles.flex} testID="file-preview">
        <View
          style={[
            styles.sheet,
            palette.cardStyle(palette.surface),
            { borderRadius: palette.radius, margin: 0, padding: 0, marginHorizontal: 12 },
          ]}>
          <View style={[styles.sheetClip, { borderRadius: Math.max(0, palette.radius - 2) }]}>
            <DeskPreview
              uri={file.uri}
              file={shown}
              files={files}
              palette={palette}
              locale={locale}
              onSystemPreview={() => void systemPreview()}
              wordDoc={wordDoc}
              office={office}
            />
          </View>
        </View>
      </View>
      {error || record.error ? (
        <Text
          testID="share-preview-error"
          style={[palette.font('bodyMedium', 14), styles.error, { color: palette.danger }]}>
          {error ?? record.error}
        </Text>
      ) : null}
      {savedNote && !error ? (
        <Text
          testID="preview-saved-note"
          style={[palette.font('bodyMedium', 14), styles.error, { color: palette.caption }]}>
          {savedNote}
        </Text>
      ) : null}
      {member ? null : sizeProblem ? (
        <Text
          testID="share-too-large"
          style={[
            palette.font('bodyMedium', 15),
            styles.error,
            { color: palette.danger, paddingBottom: insets.bottom + 12 },
          ]}>
          {runErrorText(locale, sizeProblem.code, sizeProblem.detail)}
        </Text>
      ) : (
        <View
          testID="preview-bar"
          style={[
            styles.bar,
            palette.cardStyle(palette.surface),
            {
              borderRadius: Math.min(palette.radius + 6, 32),
              marginBottom: Math.max(insets.bottom, 12),
            },
          ]}>
          {button(
            'preview-edit',
            'signature',
            t(locale, kind === 'pdf' ? 'previewEditPdf' : 'previewEdit'),
            () => void edit(),
            busy,
            true,
          )}
          {wordId
            ? button('preview-word', 'text', t(locale, 'previewToWord'), () => run(wordId, 'desk'))
            : null}
          {button('preview-share', 'share', t(locale, 'previewShare'), () => setPanel('share'))}
          {button('preview-record', 'note', t(locale, 'previewRecord'), () => setPanel('record'))}
          {button('preview-more', 'apps', t(locale, 'previewMore'), () => setPanel('more'))}
        </View>
      )}
      {panel ? (
        <BottomSheet
          palette={palette}
          locale={locale}
          visible
          animationType="none"
          onClose={() => setPanel(null)}
          backdropTestID="preview-panel-backdrop"
          backdropLabel={t(locale, 'close')}
          bottomPadding={12}
          testID={`preview-panel-${panel}`}
          style={[styles.panel, { backgroundColor: palette.surface }]}>
          <View style={[styles.handle, { backgroundColor: palette.border }]} />
          <View style={styles.panelHeader}>
            <Text style={[palette.font('title', 20), { color: palette.text }]}>
              {t(
                locale,
                panel === 'record'
                  ? 'previewRecord'
                  : panel === 'share'
                    ? 'previewShare'
                    : 'previewMore',
              )}
            </Text>
            <Pressable
              testID="preview-panel-close"
              accessibilityRole="button"
              accessibilityLabel={t(locale, 'close')}
              onPress={() => setPanel(null)}
              style={[styles.closeButton, { backgroundColor: palette.primaryTint }]}>
              <UiIcon name="close" size={18} color={palette.text} />
            </Pressable>
          </View>
          {panel === 'more' ? (
            <View style={styles.fileHeader} testID="preview-more-file">
              <View style={[styles.fileIcon, { backgroundColor: palette.primaryTint }]}>
                <Icon name="document" size={22} color={palette.primaryText} />
              </View>
              <Text
                numberOfLines={2}
                style={[palette.font('bodyMedium', 16), styles.flex, { color: palette.text }]}>
                {shown.name}
              </Text>
            </View>
          ) : null}
          <ScrollView style={styles.panelBody}>
            {panel === 'record' ? (
              <Card palette={palette}>
                <RecordChooser
                  count={share.files.length}
                  files={share.files}
                  placing={record.placing}
                  palette={palette}
                  locale={locale}
                  onChoose={(choice) => void record.saveAsRecord(choice)}
                />
              </Card>
            ) : panel === 'share' ? (
              shareRows()
            ) : (
              <>
                {moreTop()}
                {moreSections()}
              </>
            )}
          </ScrollView>
        </BottomSheet>
      ) : null}
      {bundle.element}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  empty: { flex: 1, gap: 16, justifyContent: 'center' },
  error: { paddingHorizontal: 16, paddingVertical: 6 },
  // A rounded panel floating at the bottom of the page (D-488): 12 padding on left and right, with border radius and shadow matching the theme's card style.
  bar: {
    flexDirection: 'row',
    marginHorizontal: 12,
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 4,
    padding: 0,
  },
  tool: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 2 },
  toolIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleBox: { alignItems: 'center', maxWidth: 220 },
  sheet: { flex: 1, marginTop: 4 },
  sheetClip: { flex: 1, overflow: 'hidden' },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: 4 },
  toolLabel: { textAlign: 'center' },
  panel: {
    maxHeight: '90%',
    padding: 16,
    gap: 8,
  },
  panelBody: { flexGrow: 0 },
  panelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  fileIcon: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: { paddingBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '25%', paddingVertical: 6 },
  cellPress: { alignItems: 'center', gap: 6, paddingHorizontal: 2 },
  cellIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetRow: { gap: 2, minHeight: 56, justifyContent: 'center', paddingVertical: 6 },
});
