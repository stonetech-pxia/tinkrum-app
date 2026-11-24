import { formatFileSize, readFiles, type BlockOf, type Locale } from '@morph/core';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { useIncoming } from '../share/incoming';
import type { AssetRecord } from '../storage/types';
import { useCalendar, useWorkspace, useWorkspaceContext } from '../workspace/context';
import type { RenderEnv } from './components';
import { Icon } from './Icon';
import type { Palette } from './theme';
import { Card } from './ui';

export const formatSize = (bytes: number, locale: Locale = 'en') => formatFileSize(bytes, locale);

const extOf = (name: string) => /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toUpperCase() ?? '';

/**
 * File list (look files, reads system table $files): displays user files in the workspace
 * (independent of config version). D-451: each row consists of a thumbnail (original for images,
 * pre-rendered first page for PDFs), file name, and "type · date"; tapping a row opens it with
 * the system preview, and "All" on the right of the title opens the all-files page (D-453).
 * Read-only, no thumbnail generation (invariant 15).
 */
export function FileList({ block, env }: { block: BlockOf<'files'>; env: RenderEnv }) {
  const { repo, files } = useWorkspaceContext();
  const version = useWorkspace((s) => s.assetsVersion);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const router = useRouter();
  const { palette, locale } = env;
  const title = block.show.title;
  const { source } = block;
  const cal = useCalendar();

  useEffect(() => {
    let alive = true;
    // Filtering, sorting, and count all follow source (core's readFiles); migrated file lists filter out UI photos (D-051).
    void repo.listAssets().then((all) => {
      if (alive) setAssets(readFiles(source, all, new Date(), cal));
    });
    return () => {
      alive = false;
    };
  }, [repo, version, source, cal]);

  return (
    <View style={styles.block}>
      <View style={styles.head}>
        <Text style={[palette.font('bodyMedium', 14), { color: palette.caption }]}>{title}</Text>
        {env.interactive && assets.length > 0 ? (
          <Pressable
            testID="files-all"
            accessibilityRole="button"
            hitSlop={8}
            onPress={env.locked ?? (() => router.push('/files'))}>
            <Text style={[palette.font('bodyMedium', 14), { color: palette.primaryText }]}>
              {t(locale, 'filesAll')}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {assets.length === 0 ? (
        <View
          testID="files-empty"
          style={[styles.empty, { borderColor: palette.border, borderRadius: palette.radius }]}>
          <Icon name="document" size={22} color={palette.caption} />
          <Text style={[palette.font('body', 14), styles.center, { color: palette.caption }]}>
            {t(locale, 'noFiles')}
          </Text>
        </View>
      ) : (
        <Card palette={palette} style={styles.card}>
          {assets.map((a, i) => (
            <FileRow
              key={a.id}
              asset={a}
              first={i === 0}
              palette={palette}
              locale={locale}
              disabled={!env.interactive}
              onPress={env.locked ?? (() => openAsset(files, router, a))}
              onLongPress={env.onLongPress}
            />
          ))}
        </Card>
      )}
    </View>
  );
}

/**
 * Opens a user file: enters the file preview page (D-457), same as receiving a file. The file
 * resides in the app's document directory rather than the picker's cache directory; leaving the
 * preview page releases this batch without affecting them (removePickedCopies only deletes cache
 * copies).
 */
export function openAsset(
  files: ReturnType<typeof useWorkspaceContext>['files'],
  router: ReturnType<typeof useRouter>,
  a: AssetRecord,
) {
  useIncoming.getState().receive(
    // Carries file ID (D-455): places the intermediate format stored alongside it onto the desk when editing in the preview page (D-470).
    [
      {
        uri: files.fileUri(a.path),
        name: a.name,
        size: a.size,
        mimeType: a.mimeType,
        assetId: a.id,
      },
    ],
    [],
    'picker',
  );
  router.push('/share');
}

/** A single file row: thumbnail, file name, and "type · date" (shared between home screen recent files and all-files pages). */
export function FileRow({
  asset,
  first,
  palette,
  locale,
  disabled,
  onPress,
  onLongPress,
  snippet,
  trailing,
}: {
  asset: AssetRecord;
  first: boolean;
  palette: Palette;
  locale: Locale;
  /** The snippet of text matching the search within the file (D-455). */
  snippet?: string | undefined;
  disabled?: boolean;
  onPress?: (() => void) | undefined;
  onLongPress?: (() => void) | undefined;
  /** Trailing element on the right of the row (selection checkbox on the all-files page, D-472). */
  trailing?: ReactNode;
}) {
  const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(
    new Date(asset.createdAt),
  );
  return (
    <Pressable
      testID={`file-${asset.name}`}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
      ]}>
      <Thumb asset={asset} palette={palette} />
      <View style={styles.text}>
        <Text numberOfLines={1} style={[palette.font('bodyMedium', 15), { color: palette.text }]}>
          {asset.name}
        </Text>
        <Text style={[palette.font('body', 12), { color: palette.caption }]}>
          {[extOf(asset.name), date].filter(Boolean).join(' · ')}
        </Text>
        {snippet ? (
          <Text
            testID={`file-snippet-${asset.id}`}
            numberOfLines={2}
            style={[palette.font('body', 13), { color: palette.muted }]}>
            {snippet}
          </Text>
        ) : null}
      </View>
      {trailing}
    </Pressable>
  );
}

/** Thumbnail: original for images, first page for PDFs (D-451), and icons for others. */
function Thumb({ asset, palette }: { asset: AssetRecord; palette: Palette }) {
  const { files } = useWorkspaceContext();
  const uri = asset.mimeType.startsWith('image/')
    ? files.fileUri(asset.path)
    : asset.mimeType === 'application/pdf'
      ? (files.thumbnailUri?.(asset.path) ?? null)
      : null;
  const frame = [
    styles.thumb,
    { backgroundColor: palette.background, borderColor: palette.border },
  ];
  if (uri)
    return (
      <Image
        testID={`file-thumb-${asset.id}`}
        source={{ uri }}
        contentFit="cover"
        allowDownscaling
        style={frame}
      />
    );
  return (
    <View style={[frame, styles.iconThumb]}>
      <Icon
        name={
          asset.mimeType.startsWith('video/')
            ? 'video'
            : asset.mimeType.startsWith('audio/')
              ? 'audio'
              : 'document'
        }
        size={18}
        color={palette.secondary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  // Title outside the box: aligned with page margins and card edges (D-454).
  head: { flexDirection: 'row', justifyContent: 'space-between' },
  card: { paddingVertical: 4, gap: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  text: { flex: 1, gap: 2 },
  thumb: { width: 34, height: 44, borderRadius: 5, borderWidth: StyleSheet.hairlineWidth },
  iconThumb: { alignItems: 'center', justifyContent: 'center' },
  empty: { borderWidth: 1, borderStyle: 'dashed', alignItems: 'center', gap: 6, padding: 24 },
  center: { textAlign: 'center' },
});
