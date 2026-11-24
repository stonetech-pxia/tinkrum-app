import {
  type IconName,
  localize,
  type MediaKind,
  mediaKindOf,
  quickActionsOf,
  sharedSizeProblem,
  type ShareFit,
  type Workflow,
} from '@morph/core';

import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ScrollViewInstance,
} from 'react-native';

import { useFileBundleOffer } from '../packs/FileBundleOffer';
import { AIEntryButton } from '../shell/ai-entry';
import { runErrorText, t } from '../i18n';
import { formatSize } from '../renderer/FileList';
import { Icon } from '../renderer/Icon';
import { usePalette } from '../renderer/theme';
import { Button, Card, Pill, SectionLabel } from '../renderer/ui';
import { mimeOf } from '../runtime/actions/helpers';
import { formatTime } from '../run/local/TrimScreen';
import { stepChain } from '../shell/WorkflowsScreen';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '../workspace/context';
import { releaseShare, useIncoming } from './incoming';
import { RecordChooser, useSaveAsRecord } from './RecordChooser';
import { shareRecommendations } from './recommendations';
import type { SucceededRuns } from '../storage/types';

/**
 * Inbox (TOOLS_DESIGN §11, D-117): "Received N files", lists workflows that can accept these
 * files, and runs only when tapped (does not run automatically). File names and sizes are
 * displayed locally only and are not sent to the AI. Provided by core; AI cannot modify it.
 */
const ICONS: Partial<Record<MediaKind, IconName>> = {
  image: 'photo',
  video: 'video',
  audio: 'audio',
};

export function ShareScreen() {
  const { repo, files, registry, locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const palette = usePalette(useAppTheme(config));
  const share = useIncoming((s) => s.share);
  const router = useRouter();
  // After sharing or opening files, prompt for the file processing bundle once (D-456); once asked, do not ask again.
  const bundle = useFileBundleOffer(palette, locale);
  const fromOutside = !!share && share.files.length > 0 && share.source !== 'result';
  useEffect(() => {
    if (fromOutside) bundle.offer();
    // View each batch of files only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share?.id]);

  // Do not sort recommendations until usage counts are read: otherwise, sorting first by "none used" causes cards to jump positions when counts load, leading to misclicks when tapping quickly.
  const [usage, setUsage] = useState<SucceededRuns | null>(null);
  const [showAll, setShowAll] = useState(false);
  // The table list for "Save as record" is expanded (D-392).
  const [choosing, setChoosing] = useState(false);
  const record = useSaveAsRecord(share?.files ?? [], () => setChoosing(false));
  const placing = record.placing;
  useEffect(() => {
    let alive = true;
    void repo
      .countSucceededRuns()
      .then((counts) => {
        if (alive) setUsage(counts);
      })
      .catch(() => {
        /* Quick actions can still be selected manually when statistics are temporarily unavailable. */
        if (alive) setUsage(new Map());
      });
    return () => {
      alive = false;
    };
  }, [repo, share?.id]);
  // True when handed over to the execution page or AI: do not delete files when leaving the page (deleted when the execution page closes).
  const handed = useRef(false);
  // After returning from AI cancellation, the inbox resumes responsibility for cleanup on close.
  useFocusEffect(
    useCallback(() => {
      handed.current = false;
    }, []),
  );
  // Quick actions existing before opening the AI: upon return, the newly created one is marked
  // "Just created" and sorted first (D-129). AI modifications are applied in the draft (D-190);
  // after applying, reopen this page carrying the newly created one (made).
  const { made } = useLocalSearchParams<{ made?: string }>();
  const [knownIds, setKnownIds] = useState<Set<string> | null>(() =>
    made
      ? new Set(
          quickActionsOf(config)
            .filter((w) => w.id !== made)
            .map((w) => w.id),
        )
      : null,
  );
  const scroll = useRef<ScrollViewInstance>(null);
  // When returning here after AI completion, the new ones are sorted first: scroll to the top so the user sees them (otherwise it stays stuck at "Let AI build one").
  const newest = knownIds
    ? quickActionsOf(config).find((w) => !w.package && !knownIds.has(w.id))?.id
    : undefined;
  useEffect(() => {
    if (newest) scroll.current?.scrollTo({ y: 0, animated: true });
  }, [newest]);
  // Video and audio durations (displayed locally only); hidden when native modules are unavailable.
  const [durations, setDurations] = useState<Record<string, number>>({});
  useEffect(() => {
    const media = files.media;
    if (!share || !media) return;
    let alive = true;
    void (async () => {
      for (const f of share.files) {
        const kind = mediaKindOf(mimeOf(f.name, f.mimeType), f.name);
        if (kind !== 'video' && kind !== 'audio') continue;
        try {
          const info = await media.probe(f.uri);
          if (alive) setDurations((d) => ({ ...d, [f.uri]: info.durationMs }));
        } catch {
          // Files that fail to open will throw at runtime; here we simply omit the duration.
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [files, share]);

  useEffect(() => {
    const id = share?.id;
    handed.current = false;
    return () => {
      if (!handed.current && id !== undefined) void releaseShare(files, id);
    };
  }, [files, share?.id]);

  const caption = [palette.font('body', 13), { color: palette.muted }];
  const title = share
    ? share.source === 'result'
      ? t(locale, 'resultContinue')
      : t(locale, 'sharedFilesReceived', { n: share.files.length })
    : t(locale, 'ShareScreen_Shared_with_Morph_bb8fe');

  if (!share || share.files.length === 0) {
    return (
      <View style={[styles.empty, { padding: palette.pad }]} testID="share-screen">
        <Stack.Screen options={{ title }} />
        <Text testID="share-none" style={[palette.font('body', 15), { color: palette.muted }]}>
          {t(locale, 'ShareScreen_Morph_only_takes_files_photos_PDFs_and_91f45')}
        </Text>
        <Button
          palette={palette}
          label={t(locale, 'ShareScreen_Close_59a26')}
          onPress={() => router.back()}
        />
      </View>
    );
  }

  const infos = share.files.map((f) => ({
    name: f.name,
    mimeType: mimeOf(f.name, f.mimeType),
    size: f.size,
  }));
  const sizeProblem = sharedSizeProblem(infos);
  // Tap a file to enter its preview page (D-457, replacing the full-screen image viewer and system preview of D-238); displayed locally only.
  const open = (i: number) =>
    router.push({
      pathname: '/file-preview',
      params: { shared: String(share.id), index: String(i) },
    });
  const counts = usage ?? new Map();
  const { all, recommended, anyUsed } = shareRecommendations(
    quickActionsOf(config),
    infos,
    counts,
    locale,
    newest,
  );
  // "View all N" expands those N on this page (jumping to the category page would miss quick actions that also accept these files but belong to other categories).
  const candidates = usage === null ? [] : showAll ? all : recommended;

  function isNew(wf: Workflow) {
    return knownIds !== null && !wf.package && !knownIds.has(wf.id);
  }

  // One quick action per row (D-237): name (long French names can wrap to two lines) and a
  // description line, with "Run" on the right; 5 items plus "I want to describe it myself" fit
  // without scrolling.
  const workflowRow = ({ wf, fit }: (typeof candidates)[number], i: number) => (
    <View
      key={wf.id}
      testID={`share-workflow-${wf.id}`}
      style={[
        styles.row,
        i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
      ]}>
      <View style={styles.flex}>
        <Text numberOfLines={2} style={[palette.font('title', 15), { color: palette.text }]}>
          {wf.name}
          {isNew(wf) ? t(locale, 'ShareScreen_just_made_ed6c1') : ''}
        </Text>
        <Text
          numberOfLines={1}
          style={fit.ok ? caption : [palette.font('bodyMedium', 13), { color: palette.danger }]}>
          {fit.ok
            ? [
                counts.has(wf.id) ? t(locale, 'shareUsed', { n: counts.get(wf.id)!.count }) : null,
                wf.package ? localize(registry.tools.get(wf.package)?.name, locale) : null,
                stepChain(wf, registry, locale),
              ]
                .filter(Boolean)
                .join(' · ')
            : reason(fit)}
        </Text>
      </View>
      {fit.ok ? (
        <Pill
          palette={palette}
          testID={`share-run-${wf.id}`}
          label={t(locale, 'ShareScreen_Run_5cab2')}
          onPress={() => run(wf)}
        />
      ) : null}
    </View>
  );

  const reason = (fit: ShareFit) =>
    fit.ok
      ? ''
      : fit.reason === 'tooFew'
        ? t(locale, 'ShareScreen_Needs_at_least_files_0ed9b', { v0: fit.min })
        : fit.reason === 'tooMany'
          ? t(locale, 'ShareScreen_Takes_at_most_files_0fe59', { v0: fit.max })
          : '';

  function run(wf: Workflow) {
    handed.current = true;
    router.replace({
      pathname: '/run/[workflowId]',
      params: { workflowId: wf.id, shared: String(share!.id) },
    });
  }

  /** Let AI build one: AI only knows the file types and count (D-124). Returns here upon completion, with new ones sorted first. */
  function askAI() {
    setKnownIds(new Set(quickActionsOf(config).map((w) => w.id)));
    // AI modifications go into the draft first, and this page will close (D-190): shared files are kept, and can still be used here after returning upon application.
    handed.current = true;
    router.push({ pathname: '/change', params: { shared: String(share!.id) } });
  }

  return (
    <ScrollView
      ref={scroll}
      testID="share-screen"
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 48 }}>
      <Stack.Screen
        options={{
          title,
          headerRight: () => <AIEntryButton palette={palette} locale={locale} onPress={askAI} />,
        }}
      />
      {/* Files are listed here continuously (without expand/collapse), tap one to enter its preview page (D-457); list height is at most half a screen, with excess scrolling internally. */}
      <Card palette={palette}>
        <Text testID="share-files-summary" style={caption}>
          {`${t(locale, infos.every((f) => f.mimeType.startsWith('image/')) ? 'sharePhotoSummary' : 'shareSummary', { n: share.files.length })}${
            infos.every((f) => f.size !== null)
              ? ` · ${formatSize(
                  infos.reduce((n, f) => n + (f.size ?? 0), 0),
                  locale,
                )}`
              : ''
          }`}
        </Text>
        <ScrollView nestedScrollEnabled style={styles.fileList} testID="share-files">
          {share.files.map((f, i) => (
            <Pressable
              key={`${i}-${f.uri}`}
              testID={`share-file-${i}`}
              onPress={() => open(i)}
              style={({ pressed }) => [
                styles.file,
                i > 0 && {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderColor: palette.border,
                },
                pressed && { opacity: 0.6 },
              ]}>
              <Icon
                name={ICONS[mediaKindOf(infos[i]!.mimeType, f.name)] ?? 'document'}
                size={18}
                color={palette.secondary}
              />
              <Text
                numberOfLines={1}
                style={[styles.flex, palette.font('bodyMedium', 15), { color: palette.text }]}>
                {f.name}
              </Text>
              {f.size !== null || durations[f.uri] ? (
                <Text style={[palette.font('body', 13), { color: palette.caption }]}>
                  {[
                    durations[f.uri] ? formatTime(durations[f.uri]!, false, locale) : null,
                    f.size !== null ? formatSize(f.size, locale) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              ) : null}
              <Text style={[palette.font('title', 18), { color: palette.caption }]}>›</Text>
            </Pressable>
          ))}
        </ScrollView>
        {record.error ? (
          <Text
            testID="share-preview-error"
            style={[palette.font('bodyMedium', 14), { color: palette.danger }]}>
            {record.error}
          </Text>
        ) : null}
      </Card>

      {sizeProblem ? (
        <Card palette={palette}>
          <Text
            testID="share-too-large"
            style={[palette.font('bodyMedium', 15), { color: palette.danger }]}>
            {runErrorText(locale, sizeProblem.code, sizeProblem.detail)}
          </Text>
        </Card>
      ) : (
        <>
          <Card palette={palette} style={styles.list}>
            {/* Save as record (D-392): placed below files and above quick action recommendations; expands the table list only when tapped, does not perform actions automatically. */}
            <View testID="share-record" style={styles.row}>
              <View style={styles.flex}>
                <Text
                  numberOfLines={2}
                  style={[palette.font('title', 15), { color: palette.text }]}>
                  {t(locale, 'shareRecord')}
                </Text>
                <Text numberOfLines={2} style={caption}>
                  {t(locale, 'shareRecordAbout')}
                </Text>
              </View>
              <Pill
                palette={palette}
                testID="share-record-choose"
                label={t(locale, choosing ? 'shareRecordHide' : 'shareRecordChoose')}
                onPress={() => setChoosing(!choosing)}
              />
            </View>
            {choosing ? (
              <RecordChooser
                count={share.files.length}
                files={share.files}
                placing={placing}
                palette={palette}
                locale={locale}
                onChoose={(choice) => void record.saveAsRecord(choice)}
              />
            ) : null}
          </Card>
          {candidates.length > 0 ? (
            <SectionLabel palette={palette}>
              {t(locale, anyUsed ? 'shareRecent' : 'shareSuggested')}
            </SectionLabel>
          ) : null}
          {candidates.length > 0 ? (
            <Card palette={palette} style={styles.list}>
              {candidates.map(workflowRow)}
            </Card>
          ) : null}
          {usage !== null && !showAll && all.length > recommended.length ? (
            <Button
              palette={palette}
              variant="text"
              testID="share-see-all"
              label={t(locale, 'shareSeeAll', { n: all.length })}
              onPress={() => setShowAll(true)}
            />
          ) : null}
          {/* "I want to describe it myself" is placed below quick actions (D-237; previously above, in D-233). */}
          <Button
            palette={palette}
            testID="share-ask-ai"
            variant="outline"
            label={t(locale, 'shareDescribe')}
            onPress={askAI}
          />
        </>
      )}
      <Text style={caption}>
        {t(locale, 'ShareScreen_Files_are_handled_on_this_device_only__c8099')}
      </Text>
      {bundle.element}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, gap: 16, justifyContent: 'center' },
  file: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36 },
  flex: { flex: 1 },
  fileList: { maxHeight: 200 },
  list: { paddingVertical: 2, gap: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 6 },
});
