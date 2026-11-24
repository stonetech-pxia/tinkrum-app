import type { Page } from '@morph/core';
import { useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollViewProps } from 'react-native';

import { PageView, type RenderEnv } from '../renderer/components';
import { useWorkspace } from '../workspace/context';
import { useEditActions } from './actions';
import { ArrangeView } from './ArrangeView';
import { EditSheet } from './EditSheet';
import { directEditEntry } from './entry';
import { useSingleDrag } from './useSingleDrag';

// Pages that can be edited directly (D-052): used in place of PageView for the shell and standalone
// pages. Long press selects only a single component and allows continued dragging (D-235);
// full-page editing retains ArrangeView. The entire draft is synthesized into a single version upon
// "Done" (D-054). Previews and system pages do not use it.

/** The page remounts after saving a version; remember the scroll position so it stays in place after editing. */
const scrollOffsets = new Map<string, number>();

function rememberScroll(key: string): ScrollViewProps {
  return {
    contentOffset: { x: 0, y: scrollOffsets.get(key) ?? 0 },
    scrollEventThrottle: 32,
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) =>
      void scrollOffsets.set(key, e.nativeEvent.contentOffset.y),
  };
}

export function EditablePage({
  page,
  env,
  bottomInset,
  zoneInset,
}: {
  page: Page;
  env: RenderEnv;
  bottomInset?: number;
  /** How much clearance to leave for the fixed area at the bottom of the page (PageView). */
  zoneInset?: number;
}) {
  const editing = useWorkspace((s) => (s.editing?.pageId === page.id ? s.editing : null));
  const draft = editing?.config;
  const startEditing = useWorkspace((s) => s.startEditing);
  const shown = draft?.containers.pages.find((p) => p.id === page.id) ?? page;
  const { edit, finish, cancel } = useEditActions(shown);
  const [selected, setSelected] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);

  const select = (id: string) => {
    startEditing(page.id, 'single');
    setSelected(id);
  };
  const drag = useSingleDrag(shown, select, (op) => edit([op]));
  const savedScroll = rememberScroll(page.id);

  const sheet = (
    <EditSheet
      page={shown}
      componentId={editing?.mode === 'page' ? selected : sheetId}
      palette={env.palette}
      onClose={() => {
        setSheetId(null);
        if (editing?.mode === 'page') setSelected(null);
      }}
    />
  );

  if (draft && editing?.mode === 'page') {
    return (
      <>
        <ArrangeView
          page={shown}
          env={{ ...env, config: draft }}
          bottomInset={bottomInset}
          scroll={rememberScroll(`${page.id}:edit`)}
          onEdit={setSelected}
          onMove={(op) => edit([op])}
          onDone={() => void finish()}
          onCancel={cancel}
        />
        {sheet}
      </>
    );
  }
  return (
    <>
      <PageView
        page={shown}
        env={
          directEditEntry.longPress && env.interactive && !env.locked
            ? {
                ...env,
                config: draft ?? env.config,
                focus: {
                  selectedId: draft ? selected : null,
                  onEdit: setSheetId,
                  onDone: () => {
                    if (!drag.draggingId) void finish();
                  },
                  drag,
                },
                edit: select,
              }
            : env
        }
        bottomInset={bottomInset}
        zoneInset={zoneInset}
        scroll={{
          ...savedScroll,
          ...drag.scroll,
          onScroll: (e) => {
            savedScroll.onScroll?.(e);
            drag.scroll.onScroll?.(e);
          },
        }}
      />
      {sheet}
    </>
  );
}
