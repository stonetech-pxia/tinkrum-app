import { appViewOf, builtinText, linkTitle, type DataRecord } from '@morph/core';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { tableVersion } from '@/data/records';
import { EditablePage } from '@/editing/EditablePage';
import { t } from '@/i18n';
import { ErrorBoundary } from '@/renderer/ErrorBoundary';
import { UiIcon } from '@/renderer/Icon';
import { openEditor } from '@/renderer/open-row';
import type { RenderEnv } from '@/renderer/components';
import { usePalette } from '@/renderer/theme';
import { DraftBar } from '@/draft/DraftBar';
import { SampleHint } from '@/guide/SampleHint';
import { directEditEntry } from '@/editing/entry';
import { AIEntry } from '@/shell/ai-entry';
import { stackScreenOptions } from '@/shell/header';
import { Banner, DraftNotice, useShellEnv } from '@/shell/Shell';
import { Toast } from '@/shell/Toast';
import { useWorkspace, useWorkspaceContext } from '@/workspace/context';
import { shownConfig } from '@/workspace/store';

/** Pages not in navigation bar (tool pages, user-created pages): same renderer, renders a specific page from the workspace config. */
export default function PageRoute() {
  const { pageId, record: recordId } = useLocalSearchParams<{
    pageId: string;
    /** Page for a single record (D-342): the record opened from a list. */
    record?: string;
  }>();
  const { registry, locale, repo } = useWorkspaceContext();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Show the draft in draft mode (D-190).
  const config = useWorkspace(shownConfig)!;
  const headId = useWorkspace((s) => s.head!.id);
  const reportRenderError = useWorkspace((s) => s.reportRenderError);
  const attempt = useWorkspace((s) => s.renderAttempt);
  const draftFailed = useWorkspace((s) => s.draftRenderFailed);
  const editing = useWorkspace((s) => s.editing?.pageId === pageId);
  const cancelEditing = useWorkspace((s) => s.cancelEditing);
  const startEditing = useWorkspace((s) => s.startEditing);
  const page = config.containers.pages.find((p) => p.id === pageId);
  // Pushed pages use their app's style (D-485); home screen pages use the home screen style.
  const palette = usePalette(appViewOf(config, page?.app ?? null).theme);
  const { navigate, locked, inDraft } = useShellEnv();
  const recordOf = page?.of;
  const collection = recordOf ? config.data.tables.find((c) => c.id === recordOf) : undefined;
  // This record: title shown at the top of the page; re-read after modification or deletion (undefined = still loading).
  const version = useWorkspace((s) => (recordOf ? tableVersion(s, recordOf) : ''));
  const [record, setRecord] = useState<DataRecord | null | undefined>(undefined);
  useEffect(() => {
    if (!recordOf || !recordId) return;
    void repo
      .getRecord(recordId)
      .then((r) => setRecord(r && r.deletedAt === null && r.collectionId === recordOf ? r : null));
  }, [repo, recordOf, recordId, version]);

  // Discard unsaved edits when the page is closed (e.g. deleted).
  useEffect(() => () => cancelEditing(), [cancelEditing]);

  const opened = recordOf && recordId ? record : null;
  if (recordOf && opened === undefined) return null;
  if (!page || (recordOf && (!opened || !collection))) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={[palette.font('body', 15), { color: palette.muted }]}>
          {t(locale, page ? 'recordPageMissing' : 'pageMissing')}
        </Text>
      </View>
    );
  }

  const env: RenderEnv = {
    config,
    palette,
    locale,
    registry,
    interactive: true,
    navigate,
    ...(locked ? { locked } : {}),
    ...(opened ? { recordId: opened.id } : {}),
  };
  return (
    <>
      <Stack.Screen
        options={{
          ...stackScreenOptions(palette),
          // Page for a single record uses that record as its title (assembled locally, invisible to AI).
          title:
            opened && collection
              ? linkTitle(opened, collection, locale)
              : builtinText(page.title, locale, registry),
          // Initiate edits directly on the current page, preview focuses on this page. Cannot go
          // back in edit mode: tap "Done" or "Cancel" at the top of the page first, draft will not
          // be lost (D-054).
          headerBackVisible: !editing,
          gestureEnabled: !editing,
          // AI modification is the sole entry point for UI changes (D-190); opens the chat box in draft mode.
          headerRight: () =>
            editing ? null : (
              <View style={styles.headerActions}>
                {opened ? (
                  <Pressable
                    testID="page-record-edit"
                    accessibilityLabel={t(locale, 'recordPageEdit')}
                    onPress={() => openEditor(router, opened.collectionId, opened.id)}
                    hitSlop={10}>
                    <UiIcon name="edit" size={20} color={palette.primaryText} />
                  </Pressable>
                ) : null}
                {/* "Edit" enters full-page edit mode (D-053), entry point remains closed; long-press single component editing is opened separately (D-235, editing/entry.ts). */}
                {directEditEntry.pageButton && !inDraft ? (
                  <Pressable testID="page-edit" onPress={() => startEditing(page.id)} hitSlop={10}>
                    <Text style={[palette.font('bodyBold', 16), { color: palette.primaryText }]}>
                      {t(locale, 'edit')}
                    </Text>
                  </Pressable>
                ) : null}
                <AIEntry about={{ kind: 'page', pageId: page.id }} palette={palette} />
              </View>
            ),
        }}
      />
      {/* Draft mode uses the draft background for the content area (D-190); top navigation bar still follows the saved version. */}
      <View style={[styles.fill, inDraft && palette.backdrop]}>
        {inDraft ? null : <Banner palette={palette} />}
        <DraftNotice palette={palette} />
        {inDraft || editing ? null : <SampleHint pageId={page.id} palette={palette} />}
        <ErrorBoundary
          key={inDraft ? `${headId}-draft` : `${headId}-${attempt}`}
          onError={inDraft ? draftFailed : reportRenderError}
          fallback={<View />}>
          <EditablePage page={page} env={env} bottomInset={insets.bottom + (inDraft ? 90 : 0)} />
        </ErrorBoundary>
        <DraftBar palette={palette} bottom={insets.bottom + 16} top={6} tinkRight={39} />
        <Toast palette={palette} bottom={insets.bottom + (inDraft ? 90 : 16)} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 18 },
});
