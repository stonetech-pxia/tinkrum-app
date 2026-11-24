import { MAX_PICK, sharedSizeProblem } from '@morph/core';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text } from 'react-native';

import { runErrorText, t } from '../i18n';
import { mimeOf } from '../runtime/actions/helpers';
import { releaseShare, useIncoming } from '../share/incoming';
import { useGuide } from '../guide/store';
import { keepIncomingFiles } from '../storage/keep-files';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import type { RenderEnv } from './components';
import { Dialog } from './Overlays';
import { IconButton } from './IconButton';
import { Button } from './ui';

/**
 * Selects files exclusively via the core; drafts, previews, and cancellations do not produce an
 * inbox entry. open (D-449): prompts whether to select from the photo library or "Files";
 * iconOnly: white-background button with icon only.
 */
export function FilePick({
  source,
  iconOnly,
  env,
}: {
  source: 'media' | 'files' | 'open';
  iconOnly?: boolean;
  env: RenderEnv;
}) {
  const { files, repo } = useWorkspaceContext();
  const bumpAssets = useWorkspace((s) => s.bumpAssets);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // Progress of saving to the document library (opening many photos at once takes several seconds; 2026-11-06 test: screen grayed out with no indication).
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);
  const label = t(env.locale, source === 'media' ? 'openMedia' : 'openFiles');
  function choose() {
    if (env.locked) return env.locked();
    if (!env.interactive || busy) return;
    Alert.alert(label, undefined, [
      { text: t(env.locale, 'pickFromPhotos'), onPress: () => void pick('media') },
      { text: t(env.locale, 'pickFromFiles'), onPress: () => void pick('files') },
      { text: t(env.locale, 'cancel'), style: 'cancel' },
    ]);
  }
  async function pick(from: 'media' | 'files') {
    if (env.locked) return env.locked();
    if (!env.interactive || busy) return;
    setBusy(true);
    try {
      const selected =
        from === 'media'
          ? await files.pickMedia(MAX_PICK)
          : await files.pickDocuments(['*/*'], true);
      if (!selected?.length) return;
      const problem = sharedSizeProblem(
        selected.map((f) => ({ ...f, mimeType: mimeOf(f.name, f.mimeType) })),
      );
      if (problem?.code === 'tooMany') {
        // Avoid keeping excess selections: deletes picker cache copies (which can be large videos).
        await files.removePickedCopies(selected.map((f) => f.uri)).catch(() => undefined);
        Alert.alert(
          label,
          runErrorText(env.locale, 'tooMany', {
            max: problem.detail.max,
          }),
        );
        return;
      }
      const previous = useIncoming.getState().share;
      if (previous) await releaseShare(files, previous.id);
      // Saves opened files to the document library (D-455) before entering the inbox page.
      if (selected.length > 1) setSaving({ done: 0, total: selected.length });
      const kept = await keepIncomingFiles(selected, files, repo, (done, total) =>
        setSaving(total > 1 ? { done, total } : null),
      );
      setSaving(null);
      bumpAssets();
      useIncoming.getState().receive(kept, [], 'picker');
      // Opened an image or file during tutorial step 2: ends the tutorial (step 3 sample app was cancelled, D-447).
      if (useGuide.getState().stage === 'goal') void useGuide.getState().setStage('done');
      router.push('/share');
    } catch {
      Alert.alert(label, t(env.locale, 'filePickFailed'));
    } finally {
      setSaving(null);
      setBusy(false);
    }
  }
  const progress = saving ? (
    <Dialog
      palette={env.palette}
      locale={env.locale}
      visible
      animationType="fade"
      testID="file-pick-progress"
      style={[styles.card, { backgroundColor: env.palette.surface }]}>
      <ActivityIndicator color={env.palette.primary} />
      <Text style={[env.palette.font('body', 15), { color: env.palette.text }]}>
        {t(env.locale, 'importSaving', { done: saving.done, total: saving.total })}
      </Text>
    </Dialog>
  ) : null;
  const onPress = env.interactive
    ? () => (source === 'open' ? choose() : void pick(source))
    : undefined;
  if (iconOnly) {
    return (
      <>
        {progress}
        <IconButton
          palette={env.palette}
          icon={source === 'media' ? 'photo' : 'folder'}
          {...(source === 'media' ? {} : { glyph: 'folderOpen' as const })}
          label={label}
          testID={`file-pick-${source}`}
          disabled={busy}
          onPress={onPress}
          onLongPress={env.onLongPress}
          column={env.cellColumn}
        />
      </>
    );
  }
  return (
    <>
      {progress}
      <Button
        palette={env.palette}
        label={label}
        testID={`file-pick-${source}`}
        disabled={busy}
        loading={busy}
        onPress={onPress}
        onLongPress={env.onLongPress}
        style={{ minHeight: 76 }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
});
