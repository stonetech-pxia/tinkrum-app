import { RunError, fileKindOf, isUnused, type FileKind } from '@morph/core';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { runErrorText, t, type StringKey } from '@/i18n';
import { FileRow, openAsset } from '@/renderer/FileList';
import { Icon, UiIcon } from '@/renderer/Icon';
import { usePalette } from '@/renderer/theme';
import { Pill } from '@/renderer/ui';
import { newAssetId } from '@/runtime/ids';
import { loadAssetUsage } from '@/storage/asset-uses';
import type { AssetRecord } from '@/storage/types';
import { deleteUserFiles, mergeUserPdfs, renameUserFile } from '@/storage/user-files';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '@/workspace/context';

type Sort = 'newest' | 'name' | 'size';
const SORTS: { id: Sort; label: StringKey }[] = [
  { id: 'newest', label: 'filesSortNewest' },
  { id: 'name', label: 'filesSortName' },
  { id: 'size', label: 'filesSortSize' },
];
const KIND_LABELS: Record<FileKind, StringKey> = {
  pdf: 'filesKindPdf',
  image: 'filesKindImage',
  doc: 'filesKindDoc',
  sheet: 'filesKindSheet',
  video: 'filesKindVideo',
  audio: 'filesKindAudio',
  other: 'filesKindOther',
};
/** When search terms are missing from the filename but present in the text, display the matching text segment (with surrounding context). */
function snippetOf(text: string | undefined, name: string, query: string, locale: string) {
  const word = query.trim().split(/\s+/)[0]?.toLocaleLowerCase(locale);
  if (!text || !word || name.toLocaleLowerCase(locale).includes(word)) return undefined;
  const at = text.toLocaleLowerCase(locale).indexOf(word);
  if (at < 0) return undefined;
  const start = Math.max(0, at - 16);
  const piece = text
    .slice(start, at + word.length + 40)
    .replace(/\s+/g, ' ')
    .trim();
  return `${start > 0 ? '…' : ''}${piece}…`;
}

const KIND_ORDER: FileKind[] = ['pdf', 'image', 'doc', 'sheet', 'video', 'audio', 'other'];

const baseOf = (name: string) => name.replace(/\.[^./]+$/, '');

/**
 * All Files (D-453): opened by the 'All' option under home screen 'Recent Files'. Like receipts
 * and business card templates, features a search bar, sorting, and type filter at the top, and a
 * list below. Tapping a row opens the file preview page (D-458). Search, sort, filter, and
 * selection do not write data (invariant 15). Each row has a selection checkbox on the right
 * (D-472): selecting it reveals a button toolbar below for renaming (when single selection),
 * merging (when two or more PDFs are selected, combining them into a new file while leaving
 * originals untouched), sharing, and deleting (with confirmation, used in records or page notes).
 * Every action is user-initiated.
 */
export default function FilesScreen() {
  const { repo, files, locale } = useWorkspaceContext();
  const router = useRouter();
  const config = useWorkspace((s) => s.config!);
  const theme = useAppTheme(config);
  const version = useWorkspace((s) => s.assetsVersion);
  const bumpAssets = useWorkspace((s) => s.bumpAssets);
  const palette = usePalette(theme);
  const insets = useSafeAreaInsets();
  // Two lines (D-454): search bar, list borders, and sort/type rows align with page margins; text in the search bar and thumbnails in the list are indented by inset.
  const inset = palette.inset;
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [kind, setKind] = useState<FileKind | null>(null);
  // Text inside files (D-455): only read when there is a search term, kept solely in this page's memory.
  const [texts, setTexts] = useState<Record<string, string>>({});
  const searching = query.trim().length > 0;
  // Ordered by tap sequence (merging follows this order).
  const [selected, setSelected] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!searching || !files.assetText) return;
    const missing = assets.filter((a) => !(a.id in texts));
    if (missing.length === 0) return;
    let alive = true;
    void Promise.all(
      missing.map(
        async (a) => [a.id, (await files.assetText!(a.path).catch(() => null)) ?? ''] as const,
      ),
    ).then((read) => {
      if (alive) setTexts((now) => ({ ...now, ...Object.fromEntries(read) }));
    });
    return () => {
      alive = false;
    };
  }, [searching, assets, texts, files]);

  useEffect(() => {
    let alive = true;
    void repo.listAssets().then((all) => {
      if (alive) setAssets(all);
    });
    return () => {
      alive = false;
    };
  }, [repo, version]);

  const kinds = useMemo(() => {
    const present = new Set(assets.map((a) => fileKindOf(a.mimeType)));
    return KIND_ORDER.filter((k) => present.has(k));
  }, [assets]);

  const shown = useMemo(() => {
    const words = query.trim().toLocaleLowerCase(locale).split(/\s+/).filter(Boolean);
    // Matches either filename or text inside the file (D-455).
    const list = assets.filter((a) => {
      if (kind !== null && fileKindOf(a.mimeType) !== kind) return false;
      const name = a.name.toLocaleLowerCase(locale);
      const text = (texts[a.id] ?? '').toLocaleLowerCase(locale);
      return words.every((w) => name.includes(w) || text.includes(w));
    });
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    return list.sort((a, b) =>
      sort === 'name'
        ? collator.compare(a.name, b.name)
        : sort === 'size'
          ? b.size - a.size
          : b.createdAt - a.createdAt,
    );
  }, [assets, query, kind, sort, locale, texts]);

  // Deleted or moved files are no longer counted as selected.
  const picked = useMemo(
    () =>
      selected.flatMap((id) => {
        const a = assets.find((x) => x.id === id);
        return a ? [a] : [];
      }),
    [selected, assets],
  );
  const toggle = (id: string) =>
    setSelected((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));
  const canMerge = picked.length >= 2 && picked.every((a) => a.mimeType === 'application/pdf');

  function fail(e: unknown) {
    Alert.alert(
      t(locale, 'filesAllTitle'),
      e instanceof RunError ? runErrorText(locale, e.code, e.detail) : String(e),
    );
  }

  async function work(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveName() {
    const asset = renaming && assets.find((a) => a.id === renaming.id);
    if (!asset) return setRenaming(null);
    await work(async () => {
      if (await renameUserFile(asset, renaming.name, repo)) bumpAssets();
      setRenaming(null);
    });
  }

  /** Combine into a new PDF and open its preview page (analogous to completing a quick action, D-457). */
  function merge() {
    void work(async () => {
      const merged = await mergeUserPdfs(
        picked,
        t(locale, 'filesMergedName', { name: baseOf(picked[0]!.name) }),
        repo,
        files,
        { now: () => new Date(), newId: newAssetId },
      );
      setSelected([]);
      bumpAssets();
      openAsset(files, router, merged);
    });
  }

  function share() {
    void work(() =>
      files.shareUris(
        picked.map((a) => ({ uri: files.fileUri(a.path), mimeType: a.mimeType, name: a.name })),
      ),
    );
  }

  function askDelete() {
    const ids = picked.map((a) => a.id);
    void work(async () => {
      const { usage } = await loadAssetUsage(repo, config, ids);
      const used = ids.filter((id) => !isUnused(usage.get(id))).length;
      Alert.alert(
        t(locale, 'filesDeleteTitle', { n: ids.length }),
        used > 0 ? t(locale, 'filesDeleteUsed', { n: used }) : t(locale, 'filesDeleteMessage'),
        [
          { text: t(locale, 'cancel'), style: 'cancel' },
          {
            text: t(locale, 'delete'),
            style: 'destructive',
            onPress: () =>
              void work(async () => {
                await deleteUserFiles(ids, repo, files);
                setSelected([]);
                bumpAssets();
              }),
          },
        ],
      );
    });
  }

  const tool = (id: string, icon: ReactNode, label: string, onPress: () => void, on: boolean) => (
    <Pressable
      key={id}
      testID={id}
      accessibilityRole="button"
      accessibilityState={{ disabled: !on || busy }}
      disabled={!on || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.tool, { opacity: !on || busy ? 0.4 : pressed ? 0.6 : 1 }]}>
      {icon}
      <Text numberOfLines={1} style={[palette.font('body', 11), { color: palette.text }]}>
        {label}
      </Text>
    </Pressable>
  );

  const chip = (id: string, label: string, on: boolean, onPress: () => void) => (
    <Pressable
      key={id}
      testID={id}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[
        styles.chip,
        {
          borderColor: on ? palette.primary : palette.border,
          backgroundColor: on ? palette.primaryTint : 'transparent',
        },
      ]}>
      <Text
        style={[
          palette.font('bodyMedium', 13),
          { color: on ? palette.primaryText : palette.muted },
        ]}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View style={[styles.root, palette.backdrop]} testID="files-screen">
      <FlatList
        data={shown}
        keyExtractor={(a) => a.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { padding: palette.pad }]}
        ListHeaderComponent={
          <View style={styles.head}>
            <TextInput
              testID="files-search"
              value={query}
              onChangeText={setQuery}
              placeholder={t(locale, 'browseSearch')}
              placeholderTextColor={palette.caption}
              autoCorrect={false}
              returnKeyType="search"
              style={[
                styles.input,
                palette.font('body', 15),
                {
                  paddingHorizontal: inset,
                  color: palette.text,
                  borderColor: palette.border,
                  backgroundColor: palette.surface,
                  borderRadius: palette.controlRadius,
                },
              ]}
            />
            <View style={styles.row}>
              <Text style={[palette.font('bodyMedium', 13), { color: palette.caption }]}>
                {t(locale, 'browseSort')}
              </Text>
              {SORTS.map((s) =>
                chip(`files-sort-${s.id}`, t(locale, s.label), sort === s.id, () => setSort(s.id)),
              )}
            </View>
            {kinds.length > 1 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.row}>
                {chip('files-kind-all', t(locale, 'browseFilterAll'), kind === null, () =>
                  setKind(null),
                )}
                {kinds.map((k) =>
                  chip(`files-kind-${k}`, t(locale, KIND_LABELS[k]), kind === k, () => setKind(k)),
                )}
              </ScrollView>
            ) : null}
          </View>
        }
        renderItem={({ item, index }) => (
          <View
            style={[
              { backgroundColor: palette.surface, paddingHorizontal: inset },
              index === 0 && {
                borderTopLeftRadius: palette.radius,
                borderTopRightRadius: palette.radius,
                paddingTop: 2,
              },
              index === shown.length - 1 && {
                borderBottomLeftRadius: palette.radius,
                borderBottomRightRadius: palette.radius,
                paddingBottom: 2,
              },
            ]}>
            {renaming?.id === item.id ? (
              <View
                testID="files-rename"
                style={[
                  styles.rename,
                  index > 0 && styles.renameLine,
                  { borderColor: palette.border },
                ]}>
                <TextInput
                  testID="files-rename-input"
                  autoFocus
                  selectTextOnFocus
                  value={renaming.name}
                  onChangeText={(name) => setRenaming({ id: item.id, name })}
                  onSubmitEditing={() => void saveName()}
                  placeholder={t(locale, 'filesRenamePlaceholder')}
                  placeholderTextColor={palette.caption}
                  returnKeyType="done"
                  style={[
                    styles.input,
                    palette.font('body', 15),
                    {
                      paddingHorizontal: 10,
                      color: palette.text,
                      borderColor: palette.border,
                      borderRadius: palette.controlRadius,
                    },
                  ]}
                />
                <View style={styles.row}>
                  <Pill
                    palette={palette}
                    testID="files-rename-save"
                    label={t(locale, 'save')}
                    onPress={() => void saveName()}
                  />
                  <Pill
                    palette={palette}
                    label={t(locale, 'cancel')}
                    onPress={() => setRenaming(null)}
                  />
                </View>
              </View>
            ) : (
              <FileRow
                asset={item}
                first={index === 0}
                palette={palette}
                locale={locale}
                snippet={snippetOf(texts[item.id], item.name, query, locale)}
                onPress={() => openAsset(files, router, item)}
                trailing={
                  <Check
                    on={selected.includes(item.id)}
                    label={t(locale, 'filesSelect', { name: item.name })}
                    testID={`files-check-${item.id}`}
                    palette={palette}
                    onPress={() => toggle(item.id)}
                  />
                }
              />
            )}
          </View>
        )}
        ListEmptyComponent={
          <View testID="files-none" style={styles.empty}>
            <Icon name="search" size={22} color={palette.caption} />
            <Text style={[palette.font('body', 14), { color: palette.caption }]}>
              {t(locale, assets.length === 0 ? 'noFiles' : 'filesNoMatch')}
            </Text>
          </View>
        }
      />
      {picked.length > 0 ? (
        <View
          testID="files-bar"
          style={[
            styles.bar,
            {
              borderColor: palette.border,
              backgroundColor: palette.surface,
              paddingBottom: insets.bottom + 6,
            },
          ]}>
          <View style={[styles.barHead, { paddingHorizontal: palette.pad }]}>
            <Text
              testID="files-selected"
              style={[palette.font('bodyMedium', 13), { color: palette.muted }]}>
              {t(locale, 'filesSelected', { n: picked.length })}
            </Text>
            <Pressable
              testID="files-clear"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setSelected([])}>
              <Text style={[palette.font('bodyMedium', 13), { color: palette.primaryText }]}>
                {t(locale, 'filesClearSelection')}
              </Text>
            </Pressable>
          </View>
          <View style={styles.tools}>
            {tool(
              'files-rename-start',
              <UiIcon name="edit" size={22} color={palette.primaryText} />,
              t(locale, 'filesRename'),
              () => setRenaming({ id: picked[0]!.id, name: baseOf(picked[0]!.name) }),
              picked.length === 1,
            )}
            {tool(
              'files-merge',
              <Icon name="merge" size={22} color={palette.primaryText} />,
              t(locale, 'filesMerge'),
              merge,
              canMerge,
            )}
            {tool(
              'files-share',
              <UiIcon name="share" size={22} color={palette.primaryText} />,
              t(locale, 'filesShare'),
              share,
              true,
            )}
            {tool(
              'files-delete',
              <UiIcon name="trash" size={22} color={palette.danger} />,
              t(locale, 'filesDelete'),
              askDelete,
              true,
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** Row selection checkbox: same size as record list checkboxes (primary color fill with white checkmark when selected). */
function Check({
  on,
  label,
  testID,
  palette,
  onPress,
}: {
  on: boolean;
  label: string;
  testID: string;
  palette: ReturnType<typeof usePalette>;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      hitSlop={10}
      onPress={onPress}
      style={[
        styles.check,
        {
          borderColor: on ? palette.primary : palette.border,
          backgroundColor: on ? palette.primary : palette.surface,
        },
      ]}>
      {on ? <UiIcon name="done" size={15} color={palette.onPrimary} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 40 },
  head: { gap: 10, marginBottom: 12 },
  input: { borderWidth: 1, paddingVertical: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 40 },
  rename: { gap: 8, paddingVertical: 10 },
  renameLine: { borderTopWidth: StyleSheet.hairlineWidth },
  check: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
  barHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tools: { flexDirection: 'row', paddingTop: 4 },
  tool: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 2 },
});
