import {
  formatFileSize,
  type Locale,
  mediaKindOf,
  totalSize,
  type RunItem,
  type RunValue,
} from '@morph/core';

import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { folderName, runErrorText, t, type StringKey } from '../i18n';
import { Icon } from '../renderer/Icon';
import type { Palette } from '../renderer/theme';
import { Card, Pill } from '../renderer/ui';
import { FileViewer } from '../share/FileViewer';
import { MediaRow } from './MediaRow';
import { canEditTable, canEditWord } from './office-items';

// Result preview (TOOLS_DESIGN §3): image thumbnails, PDF page count and size, full text (displayed
// locally only). Results page always provides Save, Share, Save to folder, Save to album (images),
// Print (PDF / images), Copy (text).

export const formatBytes = (bytes: number, locale: Locale = 'en') => formatFileSize(bytes, locale);

export interface ResultActions {
  save(): Promise<void>;
  share(): Promise<void>;
  /** choose: change to a different folder (otherwise save to remembered folder). Returns folder name, returns null if user cancels (button does not show "Saved"). */
  saveToFolder(choose: boolean): Promise<string | null>;
  /** Name of the remembered folder (D-123). */
  rememberedFolder(): string | null;
  saveToPhotos(): Promise<void>;
  print(): Promise<void>;
  copy(): Promise<void>;
  continueProcessing?(): Promise<void>;
  /** Open a result file (PDF, etc.) using system preview (D-277); images viewed full-screen within the app. */
  preview?(item: RunItem): Promise<void>;
  /** Conversion results for Excel, Word: place on desk for editing (D-366, replacing original "View and edit"). */
  putOnDesk?(item: RunItem): Promise<void>;
}

function ItemRow({
  item,
  palette,
  locale,
  onOpen,
}: {
  item: RunItem;
  palette: Palette;
  locale: Locale;
  /** Tap thumbnail or this row: view image full-screen, other files use system preview (D-277). */
  onOpen?: () => void;
}) {
  const image = item.mimeType.startsWith('image/');
  const fileName = `${item.name}.${item.ext}`;
  const details = [
    item.width && item.height ? `${item.width}×${item.height}` : null,
    item.pageCount ? t(locale, 'resultPages', { n: item.pageCount }) : null,
    formatBytes(item.size, locale),
  ].filter(Boolean);
  const kind = mediaKindOf(item.mimeType, item.ext);
  if (kind === 'video' || kind === 'audio') {
    return <MediaRow item={item} palette={palette} locale={locale} detail={details.join(' · ')} />;
  }
  return (
    <Pressable
      style={styles.item}
      testID={`result-open-${fileName}`}
      accessibilityRole="imagebutton"
      disabled={!onOpen}
      onPress={onOpen}>
      <View style={styles.item} testID={`result-item-${fileName}`}>
        {image ? (
          <Image
            source={{ uri: item.uri }}
            style={[styles.thumb, { borderRadius: 8 }]}
            contentFit="cover"
          />
        ) : (
          <View
            style={[
              styles.thumb,
              styles.icon,
              { backgroundColor: palette.primaryTint, borderRadius: 8 },
            ]}>
            <Icon name="document" size={24} color={palette.primaryText} />
          </View>
        )}
        <View style={styles.flex}>
          <Text numberOfLines={2} style={[palette.font('bodyMedium', 15), { color: palette.text }]}>
            {item.assetId && item.pageCount
              ? t(locale, 'runDone', { name: fileName, pages: item.pageCount })
              : item.assetId
                ? `${t(locale, 'resultSaved')} · ${fileName}`
                : fileName}
          </Text>
          <Text style={[palette.font('body', 13), { color: palette.muted }]}>
            {details.join(' · ')}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

export function ResultView({
  value,
  palette,
  locale,
  actions,
  inputSize = 0,
}: {
  value: RunValue;
  palette: Palette;
  locale: Locale;
  actions: ResultActions;
  /** Total size of input files; displays "was X, now Y" when the result becomes smaller (compressed, scaled down). */
  inputSize?: number;
}) {
  const [done, setDone] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState(() => actions.rememberedFolder());
  /** The card viewed in full screen (sequence number among all images in the results). */
  const [viewing, setViewing] = useState<number | null>(null);
  const act = (key: string, fn: () => Promise<void | boolean>) => async () => {
    setError(null);
    try {
      if ((await fn()) === false) return;
      setDone((d) => new Set(d).add(key));
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(
        code
          ? runErrorText(locale, code, (e as { detail?: Record<string, string> }).detail)
          : String(e),
      );
    }
  };
  const pill = (
    key: string,
    label: StringKey,
    doneLabel: StringKey | null,
    fn: () => Promise<void | boolean>,
  ) => (
    <Pill
      key={key}
      palette={palette}
      testID={`result-${key}`}
      label={t(locale, done.has(key) && doneLabel ? doneLabel : label)}
      onPress={() => void act(key, fn)()}
    />
  );

  // Save to the remembered folder, or switch to another (D-123); both buttons share the "saved" state.
  const folderPill = (key: 'folder' | 'folderChange', choose: boolean) => (
    <Pill
      key={key}
      palette={palette}
      testID={`result-${key}`}
      label={
        choose
          ? t(locale, 'resultFolderChange')
          : done.has('folder') && folder
            ? t(locale, 'resultFolderDone', { name: folderName(locale, folder) })
            : folder
              ? t(locale, 'resultFolderNamed', { name: folderName(locale, folder) })
              : t(locale, 'resultFolder')
      }
      onPress={() =>
        void act('folder', async () => {
          const name = await actions.saveToFolder(choose);
          if (name === null) {
            // Cancelled: the remembered folder may no longer exist (deleted, authorization revoked), so the button updates accordingly.
            setFolder(actions.rememberedFolder());
            return false;
          }
          setFolder(name);
        })()
      }
    />
  );

  if (value.type === 'text') {
    return (
      <Card palette={palette} testID="run-result">
        <ScrollView style={styles.text}>
          <Text
            selectable
            testID="result-text"
            style={[palette.font('body', 15), { color: palette.text }]}>
            {value.text}
          </Text>
        </ScrollView>
        <Text style={[palette.font('body', 13), { color: palette.caption }]}>
          {t(locale, 'resultTextNote')}
        </Text>
        <View style={styles.actions}>
          {pill('copy', 'resultCopy', 'resultCopied', actions.copy)}
        </View>
      </Card>
    );
  }

  if (value.type === 'records') {
    // Records are only used to generate PDFs; when the workflow stops here, only the count is displayed.
    return (
      <Card palette={palette} testID="run-result">
        <Text style={[palette.font('body', 15), { color: palette.text }]}>
          {t(locale, 'resultRecords', { n: value.records.length })}
        </Text>
      </Card>
    );
  }

  const items = value.items;
  const allSaved = items.every((i) => i.assetId);
  const images = items.every((i) => i.mimeType.startsWith('image/'));
  // Save to photo library: images and videos (D-140).
  const photos = items.every((i) => {
    const kind = mediaKindOf(i.mimeType, i.ext);
    return kind === 'image' || kind === 'video';
  });
  const printable = images || items.every((i) => i.mimeType === 'application/pdf');
  const outputSize = totalSize(value);
  // Full-screen image view: all images in the results, swipe left and right (D-277).
  const viewable = items
    .filter((i) => mediaKindOf(i.mimeType, i.ext) === 'image')
    .map((i) => ({ uri: i.uri, kind: 'image' as const }));
  return (
    <Card palette={palette} testID="run-result">
      {items.length > 1 ? (
        <Text style={[palette.font('bodyBold', 14), { color: palette.muted }]}>
          {t(locale, 'resultCount', { n: items.length })}
        </Text>
      ) : null}
      {items.slice(0, 30).map((item) => (
        <View key={item.uri} style={styles.itemBlock}>
          <ItemRow
            item={item}
            palette={palette}
            locale={locale}
            onOpen={
              mediaKindOf(item.mimeType, item.ext) === 'image'
                ? () => setViewing(viewable.findIndex((v) => v.uri === item.uri))
                : actions.preview
                  ? () => void act('preview', () => actions.preview!(item))()
                  : undefined
            }
          />
          {/* Excel conversion result (D-272): pages without lined tables were output as full content, notify the user; can be placed on the desk to edit. */}
          {canEditTable(item) && item.tableDoc!.pagesWithoutTables?.length ? (
            <Text
              testID="result-tables-missing"
              style={[palette.font('body', 13), { color: palette.caption }]}>
              {t(locale, 'resultTablesMissing', {
                n: item.tableDoc!.pagesWithoutTables.length,
                pages: item.tableDoc!.pagesWithoutTables.join(t(locale, 'separatorList')),
              })}
            </Text>
          ) : null}
          {(canEditTable(item) || canEditWord(item)) && actions.putOnDesk ? (
            <View style={styles.actions}>
              <Pill
                palette={palette}
                testID="result-desk"
                label={t(locale, 'deskPlace')}
                onPress={() => void act('desk', () => actions.putOnDesk!(item))()}
              />
            </View>
          ) : null}
        </View>
      ))}
      {viewing !== null ? (
        <FileViewer
          items={viewable}
          start={viewing}
          onClose={() => setViewing(null)}
          palette={palette}
          locale={locale}
        />
      ) : null}
      {inputSize > 0 && outputSize < inputSize ? (
        <Text
          testID="result-smaller"
          style={[palette.font('bodyMedium', 14), { color: palette.muted }]}>
          {t(locale, 'resultSmaller', {
            from: formatBytes(inputSize, locale),
            to: formatBytes(outputSize, locale),
          })}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {allSaved ? null : pill('save', 'resultSave', 'resultSaved', actions.save)}
        {items.length && actions.continueProcessing
          ? pill('continue', 'resultContinue', null, actions.continueProcessing)
          : null}
        {pill('share', 'resultShare', null, actions.share)}
        {folderPill('folder', false)}
        {folder ? folderPill('folderChange', true) : null}
        {photos ? pill('photos', 'resultPhotos', 'resultPhotosDone', actions.saveToPhotos) : null}
        {printable ? pill('print', 'resultPrint', null, actions.print) : null}
      </View>
      {error ? (
        <Text style={[palette.font('bodyMedium', 14), { color: palette.danger }]}>{error}</Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  itemBlock: { gap: 6 },
  thumb: { width: 52, height: 52 },
  icon: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, gap: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  text: { maxHeight: 360 },
});
