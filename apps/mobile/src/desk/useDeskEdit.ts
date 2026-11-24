import type { Desk, DeskFile } from '@morph/core';
import {
  pushHistory,
  redo as redoHistory,
  startHistory,
  undo as undoHistory,
  type DocDoc,
  type History,
  type TableDoc,
} from '@morph/tool-office';
import { useEffect, useRef, useState } from 'react';

import type { FilePlatform } from '../runtime/platform';
import {
  commitEdit,
  dropEditDraft,
  loadDeskSource,
  writeEditDraft,
  type DeskSourceDoc,
} from './store';

// Editing tables or documents in the room (file-room §11.2, D-366, confirmed by founder on
// 2026-10-30, §10 question 4 chose A): changes are first recorded step by step in memory (History,
// up to 100 steps), and top-level undo steps revert these first. A continuous editing session is
// closed and becomes a version on the desk ("Edited table", reverting undoes the whole session
// together) upon: using another tool, opening "Done" (saving, sharing), leaving the room, switching
// to another file, or the app going to the background. Unclosed edits are written to the desk
// (editing.json) on every change so they are not lost if the app is killed.

export interface EditSession {
  /** The file currently being edited (ID on the desk). */
  fileId: string;
  kind: DeskSourceDoc['kind'];
  /** The state of this editing session at its start: being identical to it means no changes were made. */
  base: TableDoc | DocDoc;
  history: History<TableDoc | DocDoc>;
}

export interface DeskEdit {
  /** undefined: still loading; null: this file cannot be edited (no intermediate format, cannot be read). */
  session: EditSession | null | undefined;
  apply(next: TableDoc | DocDoc): void;
  undo(): void;
  redo(): void;
  /** Modified and not yet closed (includes text currently being edited on the page). */
  dirty: boolean;
  /**
   * Text is being edited on the page (D-464; Word whole-page direct editing see D-465): flush
   * puts the modified text in. Call this before closing (tapping "Done", leaving without input
   * necessarily losing focus first); pass null if editing has stopped.
   */
  typing(flush: (() => void) | null): void;
  /** Close session (does nothing if unmodified), returning the current desk. */
  seal(): Promise<Desk | null>;
}

export function useDeskEdit({
  files,
  desk,
  file,
  onSealed,
}: {
  files: FilePlatform;
  /** Current desk (ref: must be the latest when closing). */
  desk: { readonly current: Desk | null };
  /** The file currently being viewed. */
  file: DeskFile | null;
  /** Closed: the desk is replaced with the new one, and the currently viewed file is updated to the new ID. */
  onSealed: (desk: Desk, fileId: string) => void;
}): DeskEdit {
  // The successfully loaded version (by file ID): when the viewed file changes and has not finished loading yet, treat it as "still loading".
  const [loaded, setLoaded] = useState<{ fileId: string; session: EditSession | null } | null>(
    null,
  );
  const ref = useRef<EditSession | null>(null);
  const setSession = (fileId: string, next: EditSession | null) => {
    ref.current = next;
    setLoaded({ fileId, session: next });
  };
  // Queue writes to the "editing" file (later writes overwrite earlier ones); wait for writing to finish before closing.
  const writing = useRef<Promise<unknown>>(Promise.resolve());
  const sealing = useRef<Promise<Desk | null> | null>(null);
  const flush = useRef<(() => void) | null>(null);
  const [typing, setTyping] = useState(false);

  const fileId = file?.id ?? null;
  const editable = !!file?.source;
  const session =
    !file || !editable ? null : loaded?.fileId === file.id ? loaded.session : undefined;
  useEffect(() => {
    // Already switched to the new file segment right after closing (no need to reload).
    if (!file || !editable || ref.current?.fileId === file.id) return;
    ref.current = null;
    let alive = true;
    const current = desk.current;
    if (!current) return;
    loadDeskSource(files, current, file).then(
      (source) => {
        if (!alive) return;
        setSession(
          file.id,
          source
            ? {
                fileId: file.id,
                kind: source.kind,
                base: source.doc,
                history: startHistory<TableDoc | DocDoc>(source.doc),
              }
            : null,
        );
      },
      () => alive && setSession(file.id, null),
    );
    return () => {
      alive = false;
    };
    // // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, fileId, editable]);

  /** Follow only the currently viewed file changes. */
  function update(history: History<TableDoc | DocDoc>) {
    const s = ref.current;
    const current = desk.current;
    if (!s || !current) return;
    setSession(s.fileId, { ...s, history });
    const doc = history.present;
    writing.current = writing.current
      .catch(() => undefined)
      .then(() =>
        doc === s.base
          ? dropEditDraft(files, current)
          : writeEditDraft(files, current, s.fileId, { kind: s.kind, doc } as DeskSourceDoc),
      );
  }

  async function sealNow(): Promise<Desk | null> {
    await writing.current.catch(() => undefined);
    const s = ref.current;
    const current = desk.current;
    if (!s || !current || s.history.present === s.base) return current;
    const doc = s.history.present;
    const done = await commitEdit(
      files,
      current,
      s.fileId,
      { kind: s.kind, doc } as DeskSourceDoc,
      Date.now(),
    );
    const sealed = done.doc ?? doc;
    setSession(done.fileId, {
      fileId: done.fileId,
      kind: s.kind,
      base: sealed,
      history: startHistory(sealed),
    });
    onSealed(done.desk, done.fileId);
    return done.desk;
  }

  function flushTyping() {
    const pending = flush.current;
    flush.current = null;
    pending?.();
  }

  return {
    session,
    dirty: typing || (!!session && session.history.present !== session.base),
    typing(next) {
      flush.current = next;
      setTyping(next !== null);
    },
    apply: (next) => ref.current && update(pushHistory(ref.current.history, next)),
    // After completing a step: record it, write to the "editing" file; delete it when reverting to the initial state.
    undo: () => {
      flushTyping();
      if (ref.current) update(undoHistory(ref.current.history));
    },
    redo: () => {
      flushTyping();
      if (ref.current) update(redoHistory(ref.current.history));
    },
    seal() {
      // Put in any text that was edited on the page but not yet submitted (D-465): undo reverts precisely this just-edited segment.
      flushTyping();
      // Put in the text currently being edited on the page first (apply synchronously updates the ref so it can be read below).
      sealing.current ??= sealNow().finally(() => {
        sealing.current = null;
      });
      return sealing.current;
    },
  };
}
