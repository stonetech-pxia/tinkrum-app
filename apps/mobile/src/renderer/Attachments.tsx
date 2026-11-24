import {
  MAX_ATTACHMENTS,
  MEDIA_LIMITS,
  RunError,
  attachmentIds,
  type Collection,
  type DataRecord,
} from '@morph/core';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { placeAssetOnDesk } from '../desk/saved-source';
import { placeOnDesk } from '../desk/store';
import { runErrorText, t, type StringKey } from '../i18n';
import { FileViewer, type ViewerItem } from '../share/FileViewer';
import type { AssetRecord } from '../storage/types';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { applyDeskReturn, holdDeskReturn } from './attachment-desk';
import type { RenderEnv } from './components';
import { BottomSheet } from './Overlays';
import { Icon } from './Icon';
import {
  importUserFiles,
  type FilesImport,
  type ImportProblem,
  type SlotSource,
} from './slot-file';
import type { Palette } from './theme';

// Read a set of user files. Unread ones are undefined, ones not on this device (deleted) are null.

/** Read a set of user files. Unread ones are undefined, ones not on this device (deleted) are null. */
export function useAssets(ids: readonly string[]): Map<string, AssetRecord | null> {
  const { repo } = useWorkspaceContext();
  const key = ids.join(',');
  const [loaded, setLoaded] = useState<{ key: string; assets: Map<string, AssetRecord | null> }>({
    key: '',
    assets: new Map(),
  });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void Promise.all(key.split(',').map((id) => repo.getAsset(id))).then((list) => {
      if (alive)
        setLoaded({ key, assets: new Map(key.split(',').map((id, i) => [id, list[i] ?? null])) });
    });
    return () => {
      alive = false;
    };
  }, [repo, key]);
  return loaded.key === key ? loaded.assets : new Map();
}

/** Fullscreen left/right browsing of photos and videos within the app (same as inbox page, D-238); other files handed over to system preview. */
const inViewer = (a: AssetRecord) =>
  a.mimeType.startsWith('image/') || a.mimeType.startsWith('video/');

/** All user files saved by Morph (file ID -> file), re-read when files are added or removed. List read all at once, not queried item by item. */
export function useAssetIndex(): Map<string, AssetRecord> | null {
  const { repo } = useWorkspaceContext();
  const version = useWorkspace((s) => s.assetsVersion);
  const [index, setIndex] = useState<Map<string, AssetRecord> | null>(null);
  useEffect(() => {
    let alive = true;
    void repo.listAssets().then((all) => alive && setIndex(new Map(all.map((a) => [a.id, a]))));
    return () => {
      alive = false;
    };
  }, [repo, version]);
  return index;
}

/** First image in a record's attachments (by field order, then file order); null if none. */
export function firstImage(
  record: DataRecord,
  collection: Collection,
  index: ReadonlyMap<string, AssetRecord>,
): AssetRecord | null {
  for (const f of collection.fields) {
    if (f.type !== 'file') continue;
    for (const id of attachmentIds(record.values[f.id])) {
      const a = index.get(id);
      if (a?.mimeType.startsWith('image/')) return a;
    }
  }
  return null;
}

/**
 * Thumbnail: expo-image decodes according to display size (allowDownscaling, Android Glide scales
 * down during decoding), preventing tens-of-megapixels photos from loading entirely into memory.
 */
export function AttachmentThumb({
  asset,
  size,
  radius,
  testID,
}: {
  asset: AssetRecord;
  size: number;
  radius: number;
  testID?: string;
}) {
  const { files } = useWorkspaceContext();
  return (
    <Image
      testID={testID}
      source={{ uri: files.fileUri(asset.path) }}
      contentFit="cover"
      allowDownscaling
      recyclingKey={asset.id}
      style={{ width: size, height: size, borderRadius: radius }}
    />
  );
}

export const IMPORT_PROBLEMS: Record<ImportProblem, StringKey> = {
  tooLarge: 'fileSlotTooLarge',
  noSpace: 'fileSlotNoSpace',
  copyFailed: 'fileSlotCopyFailed',
};

/**
 * Select from chosen sources (camera, photo library, "Files"), copy selected ones (up to max,
 * constrained by pick) into the app (same as file entry point, slot-file.ts). Returns saved file
 * IDs; empty if cancelled. Prompts if issues occur, still returns successfully saved ones. Source
 * selection prompt uses SourceChoice below: avoids system dialog because Android system dialog
 * has at most three buttons, causing "Cancel" to be dropped.
 */
async function importChosen(
  locale: RenderEnv['locale'],
  title: string,
  pick: (source: SlotSource) => Promise<FilesImport>,
  source: SlotSource,
): Promise<string[]> {
  let result: FilesImport;
  try {
    result = await pick(source);
  } catch (e) {
    // No camera or permission denied.
    Alert.alert(
      title,
      e instanceof RunError
        ? runErrorText(locale, e.code, e.detail)
        : t(locale, 'fileSlotCopyFailed'),
    );
    return [];
  }
  if (result.kind === 'cancelled') return [];
  if (result.problem)
    Alert.alert(
      title,
      t(locale, IMPORT_PROBLEMS[result.problem], {
        gb: MEDIA_LIMITS.maxFileBytes / 1024 / 1024 / 1024,
      }),
    );
  return result.assetIds;
}

/** Prompt for source selection: take photo, photo library, "Files", and "cancel", tapping empty space also cancels. */
function SourceChoice({
  title,
  palette,
  locale,
  onChoose,
  onCancel,
}: {
  title: string;
  palette: Palette;
  locale: RenderEnv['locale'];
  onChoose: (source: SlotSource) => void;
  onCancel: () => void;
}) {
  const option = (id: string, label: StringKey, source: SlotSource) => (
    <Pressable
      key={id}
      testID={`attachment-source-${id}`}
      accessibilityRole="button"
      onPress={() => onChoose(source)}
      style={styles.option}>
      <Text style={[palette.font('bodyMedium', 16), { color: palette.text }]}>
        {t(locale, label)}
      </Text>
    </Pressable>
  );
  return (
    <BottomSheet
      palette={palette}
      locale={locale}
      visible
      animationType="fade"
      onClose={onCancel}
      backdropTestID="attachment-source-backdrop"
      backdropLabel={t(locale, 'cancel')}
      testID="attachment-source"
      style={[styles.sheet, { backgroundColor: palette.surface, borderRadius: palette.radius }]}>
      <Text style={[palette.font('title', 17), { color: palette.text }]}>{title}</Text>
      {option('camera', 'attachmentTakePhoto', 'camera')}
      {option('photos', 'fileSlotFromPhotos', 'photos')}
      {option('files', 'fileSlotFromFiles', 'files')}
      <Pressable
        testID="attachment-source-cancel"
        accessibilityRole="button"
        onPress={onCancel}
        style={styles.option}>
        <Text style={[palette.font('bodyBold', 16), { color: palette.muted }]}>
          {t(locale, 'cancel')}
        </Text>
      </Pressable>
    </BottomSheet>
  );
}

/**
 * Record page provider for new user files created in forms (D-395: brought back from desk edits):
 * record page deletes unused ones upon leaving without saving, same as copies copied from inbox
 * page (D-392). Provided only by record page; attachments cannot be placed on the desk without
 * it.
 */
export const FormFilesContext = createContext<{ hold(ids: readonly string[]): void } | null>(null);

/**
 * Attachments field input (D-263): lists each file, allows adding (camera, photo library,
 * "Files"), reordering, and removing. Tapping a file previews it (photos, videos fullscreen
 * browse, others via system preview). Removal only unlinks it from this record; the file itself
 * remains in storage. "..." menu allows sharing or placing on the desk for editing (D-395).
 */
export function AttachmentsInput({
  field,
  value,
  onChange,
  palette,
  locale,
  disabled,
  testID,
}: {
  field: { name: string };
  value: unknown;
  onChange: (value: unknown) => void;
  palette: Palette;
  locale: RenderEnv['locale'];
  disabled?: boolean | undefined;
  testID: string;
}) {
  const { files, repo } = useWorkspaceContext();
  const bumpAssets = useWorkspace((s) => s.bumpAssets);
  const ids = attachmentIds(value);
  const assets = useAssets(ids);
  const room = MAX_ATTACHMENTS - ids.length;
  const [viewing, setViewing] = useState<{ items: ViewerItem[]; start: number } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const router = useRouter();
  const formFiles = useContext(FormFilesContext);
  // Use latest values and onChange when brought back from desk edits (form is below desk, may have re-rendered during the period).
  const latest = useRef({ ids, onChange });
  useEffect(() => {
    latest.current = { ids, onChange };
  });
  const mounted = useRef(true);
  const releases = useRef<(() => void)[]>([]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const release of releases.current) release();
      releases.current = [];
    };
  }, []);

  // Tap a file: photos and videos fullscreen left/right browse all photos and videos in this field;
  // other files use system preview (iOS QuickLook, Android hands over to compatible app), same as
  // file entry point.
  async function open(asset: AssetRecord) {
    if (inViewer(asset)) {
      const media = ids.flatMap((id) => {
        const a = assets.get(id);
        return a && inViewer(a) ? [a] : [];
      });
      setViewing({
        items: media.map((a) => ({
          uri: files.fileUri(a.path),
          kind: a.mimeType.startsWith('video/') ? 'video' : 'image',
        })),
        start: media.findIndex((a) => a.id === asset.id),
      });
      return;
    }
    try {
      await files.previewFile({
        uri: files.fileUri(asset.path),
        mimeType: asset.mimeType,
        name: asset.name,
      });
    } catch (e) {
      Alert.alert(
        field.name,
        e instanceof RunError
          ? runErrorText(locale, e.code, e.detail)
          : runErrorText(locale, 'previewFailed'),
      );
    }
  }

  // "..." (D-395): share this file, or place it on the desk for editing.
  function more(asset: AssetRecord) {
    Alert.alert(asset.name, undefined, [
      { text: t(locale, 'resultShare'), onPress: () => void share(asset) },
      ...(formFiles ? [{ text: t(locale, 'deskPlace'), onPress: () => void toDesk(asset) }] : []),
      { text: t(locale, 'cancel'), style: 'cancel' as const },
    ]);
  }

  // Share this stored file: user files are stored in assets/<id>/<name>, shared with this exact name.
  async function share(asset: AssetRecord) {
    try {
      await files.shareUris([{ uri: files.fileUri(asset.path), mimeType: asset.mimeType }]);
    } catch (e) {
      Alert.alert(
        field.name,
        e instanceof RunError ? runErrorText(locale, e.code, e.detail) : String(e),
      );
    }
  }

  // Place on desk: copy into a new desk (files in record untouched; xlsx / docx stored in workspace
  // retain intermediate format, D-367), prompt how to return when tapping "Done" on desk
  // (DeskScreen), returned files enter form, and save must still be tapped.
  async function toDesk(asset: AssetRecord) {
    try {
      const now = Date.now();
      const desk =
        (/\.(xlsx|docx)$/i.test(asset.name) ? await placeAssetOnDesk(files, asset, now) : null) ??
        (await placeOnDesk(
          files,
          [
            {
              uri: files.fileUri(asset.path),
              name: asset.name,
              mimeType: asset.mimeType,
              size: asset.size,
            },
          ],
          now,
        ));
      releases.current.push(
        holdDeskReturn(desk.id, {
          assetId: asset.id,
          ids: () => (mounted.current ? latest.current.ids : null),
          deliver: (mode, fresh) => {
            if (!mounted.current) return false;
            formFiles?.hold(fresh);
            latest.current.onChange(applyDeskReturn(latest.current.ids, asset.id, mode, fresh));
            return true;
          },
        }),
      );
      router.push({ pathname: '/desk/[deskId]', params: { deskId: desk.id } });
    } catch (e) {
      Alert.alert(
        field.name,
        e instanceof RunError ? runErrorText(locale, e.code, e.detail) : String(e),
      );
    }
  }

  async function add(source: SlotSource) {
    setChoosing(false);
    const added = await importChosen(
      locale,
      field.name,
      (src) => importUserFiles(src, room, files, repo),
      source,
    );
    if (added.length === 0) return;
    bumpAssets();
    onChange([...ids, ...added].slice(0, MAX_ATTACHMENTS));
  }

  const move = (from: number, to: number) => {
    const next = [...ids];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id!);
    onChange(next);
  };
  const action = (label: StringKey, id: string, onPress: () => void, show = true) =>
    show ? (
      <Pressable testID={id} disabled={disabled} hitSlop={8} onPress={onPress}>
        <Text style={[palette.font('bodyBold', 13), { color: palette.muted }]}>
          {t(locale, label)}
        </Text>
      </Pressable>
    ) : null;

  return (
    <View style={styles.list}>
      {ids.map((id, i) => {
        const asset = assets.get(id);
        return (
          <View key={id} style={styles.row}>
            <Pressable
              testID={`${testID}-file-${i}`}
              disabled={!asset}
              onPress={() => asset && void open(asset)}
              style={[styles.flex, styles.row]}>
              {asset?.mimeType.startsWith('image/') ? (
                <AttachmentThumb
                  asset={asset}
                  size={40}
                  radius={6}
                  testID={`${testID}-thumb-${i}`}
                />
              ) : (
                <Icon
                  name={asset?.mimeType.startsWith('video/') ? 'video' : 'document'}
                  size={18}
                  color={palette.secondary}
                />
              )}
              <Text
                numberOfLines={1}
                style={[styles.flex, palette.font('bodyMedium', 15), { color: palette.text }]}>
                {asset ? asset.name : asset === null ? t(locale, 'attachmentMissing') : ''}
              </Text>
            </Pressable>
            {asset ? (
              <Pressable
                testID={`${testID}-more-${i}`}
                accessibilityRole="button"
                accessibilityLabel={t(locale, 'attachmentMore', { name: asset.name })}
                disabled={disabled}
                hitSlop={8}
                onPress={() => more(asset)}>
                <Text style={[palette.font('bodyBold', 15), { color: palette.muted }]}>…</Text>
              </Pressable>
            ) : null}
            {action('attachmentMoveUp', `${testID}-up-${i}`, () => move(i, i - 1), i > 0)}
            {action(
              'attachmentMoveDown',
              `${testID}-down-${i}`,
              () => move(i, i + 1),
              i < ids.length - 1,
            )}
            {action('removeAttachment', `${testID}-remove-${i}`, () =>
              onChange(ids.filter((x) => x !== id)),
            )}
          </View>
        );
      })}
      {viewing ? (
        <FileViewer
          items={viewing.items}
          start={viewing.start}
          onClose={() => setViewing(null)}
          palette={palette}
          locale={locale}
        />
      ) : null}
      {choosing ? (
        <SourceChoice
          title={field.name}
          palette={palette}
          locale={locale}
          onChoose={(source) => void add(source)}
          onCancel={() => setChoosing(false)}
        />
      ) : null}
      {room > 0 ? (
        <Pressable
          testID={`${testID}-add`}
          disabled={disabled}
          onPress={() => setChoosing(true)}
          style={styles.row}>
          <Icon name="plus" size={18} color={palette.primaryText} />
          <Text style={[palette.font('bodyBold', 14), { color: palette.primaryText }]}>
            {t(locale, 'attachmentAdd')}
          </Text>
        </Pressable>
      ) : (
        <Text style={[palette.font('body', 13), { color: palette.caption }]}>
          {t(locale, 'attachmentsFull', { n: MAX_ATTACHMENTS })}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  sheet: { marginHorizontal: 16, marginBottom: 24, padding: 16, gap: 4 },
  option: { minHeight: 48, justifyContent: 'center' },
});
