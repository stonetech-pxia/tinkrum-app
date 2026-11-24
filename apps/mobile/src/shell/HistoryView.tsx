import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text } from 'react-native';

import { formatWhen, t } from '../i18n';
import type { RenderEnv } from '../renderer/components';
import { Card, PageTitle } from '../renderer/ui';
import type { RevisionRecord } from '../storage/types';
import { useWorkspace } from '../workspace/context';

/** Number of versions displayed per page; scroll down until the first version (invariant 7: change history can always return to any earlier point). */
const PAGE = 50;

/** Change history (§3 journey D, D-112): every modification is an immutable version; reverting to a previous state generates a new version. */
export function HistoryView({ env, onRestored }: { env: RenderEnv; onRestored?: () => void }) {
  const { palette, locale } = env;
  const headId = useWorkspace((s) => s.head!.id);
  const listRevisions = useWorkspace((s) => s.listRevisions);
  const proposeRestore = useWorkspace((s) => s.proposeRestore);
  const confirm = useWorkspace((s) => s.confirm);
  const cancel = useWorkspace((s) => s.cancel);
  const [revisions, setRevisions] = useState<RevisionRecord[]>([]);
  // Latest page is full, earlier ones may still exist.
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Starts over from the latest page whenever a new version appears (modification, revert).
  useEffect(() => {
    let alive = true;
    void listRevisions(PAGE).then((r) => {
      if (!alive) return;
      setRevisions(r);
      setMore(r.length === PAGE);
    });
    return () => {
      alive = false;
    };
  }, [headId, listRevisions]);

  async function loadMore() {
    const last = revisions[revisions.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const older = await listRevisions(PAGE, last.id);
      setRevisions((now) => [...now, ...older]);
      setMore(older.length === PAGE);
    } finally {
      setLoadingMore(false);
    }
  }

  /** Revert to previous state: asks for confirmation first (explaining what reverts to past state, files remain unaffected), takes effect immediately upon confirmation, undoable (D-190). */
  async function restore(id: number) {
    if (env.locked) return env.locked();
    const result = await proposeRestore(id);
    if (result.kind !== 'preview') {
      Alert.alert(
        t(locale, 'invalidPlan'),
        result.kind === 'invalid' ? result.issues.join('\n') : result.message,
      );
      return;
    }
    Alert.alert(result.proposal.summary, result.proposal.lines.join('\n'), [
      { text: t(locale, 'cancel'), style: 'cancel', onPress: () => void cancel() },
      {
        text: t(locale, 'restoreThis'),
        onPress: () => void confirm().then((ok) => ok && onRestored?.()),
      },
    ]);
  }

  return (
    <ScrollView
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 160 }}>
      <PageTitle palette={palette}>{t(locale, 'historyTitle')}</PageTitle>
      {revisions.map((r) => (
        <Card
          key={r.id}
          testID={`revision-${r.id}`}
          palette={palette}
          background={r.id === headId ? palette.primaryTint : undefined}>
          <Text style={[palette.font('bodyBold', 12), { color: palette.caption }]}>
            {formatWhen(locale, new Date(r.createdAt), new Date())} ·{' '}
            {t(locale, `source_${r.source}`)}
            {r.id === headId ? ` · ${t(locale, 'current')}` : ''}
          </Text>
          <Text style={[palette.font('bodyMedium', 16), { color: palette.text }]}>{r.summary}</Text>
          {r.id !== headId ? (
            <Pressable testID={`restore-${r.id}`} onPress={() => restore(r.id)} hitSlop={6}>
              <Text style={[palette.font('bodyBold', 14), { color: palette.primaryText }]}>
                {t(locale, 'restoreThis')}
              </Text>
            </Pressable>
          ) : null}
        </Card>
      ))}
      {more ? (
        <Pressable testID="history-more" onPress={() => void loadMore()} hitSlop={6}>
          <Text style={[palette.font('bodyBold', 14), { color: palette.primaryText }]}>
            {t(locale, 'historyMore')}
          </Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
