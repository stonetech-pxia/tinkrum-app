import type { Locale } from '@morph/core';
import {
  canDeleteColumn,
  deleteBlock,
  deleteColumn,
  deleteRow,
  editDocTable,
  insertColumn,
  insertRow,
  leafBlocks,
  mergeEdited,
  originalArea,
  sameValue,
  swapToOriginal,
  tableDocOf,
  type Box,
  type DocDoc,
  type DocPage,
  type DocRef,
  type DocTable,
  type EditedPage,
  type TableCell,
  type TableDoc,
} from '@morph/tool-office';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { t, type StringKey } from '../i18n';
import type { Palette } from '../renderer/theme';
import { blockBase, jpegDataUrl, paperWidth, wordPageHtml } from './word-page';

// Directly edit whole Word documents on the desk (D-465): the page in the web view (word-page.ts)
// acts as the editor, allowing free cursor placement and cross-paragraph selection; a row of
// buttons above the keyboard: font size up, font size down, bold, italic, underline, alignment,
// collapse keyboard (same as CamScanner). When the cursor is inside a table, an extra row for
// inserting/deleting rows and columns appears. Each page edit returns the appearance of each block,
// and after pausing briefly (or triggering an action, finishing, or leaving), it merges back into
// the document and records an undo step. Pages are generated based on the document at the time of
// opening; top undo/redo re-generates when the document changes (cursor returns to the beginning).

/** Pause duration after which typed text is merged into a single undo step. */
const IDLE_MS = 800;

type Align = 'left' | 'center' | 'right';

interface PageState {
  focus: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: Align;
  cell?: { ref: string; i: number } | null;
  /** Paragraph or list where the cursor is located (D-467). */
  ref?: string | null;
  /** Paragraphs and lists touched by the selection (D-468). */
  refs?: string[];
}

const NEXT_ALIGN: Record<Align, Align> = { left: 'center', center: 'right', right: 'left' };
const ALIGN_ICON = {
  left: { ios: 'text.alignleft', android: 'format_align_left' },
  center: { ios: 'text.aligncenter', android: 'format_align_center' },
  right: { ios: 'text.alignright', android: 'format_align_right' },
} as const;

function refOf(ref: string): DocRef | null {
  const [page, block, cell, item] = ref.split('-').map(Number);
  if (page === undefined || block === undefined) return null;
  return { page, block, ...(cell !== undefined && item !== undefined ? { cell, item } : {}) };
}

export function WordEditor({
  doc,
  palette,
  locale,
  width,
  readImage,
  cropOriginal,
  onApply,
  onSelecting,
  onTyping,
}: {
  doc: DocDoc;
  palette: Palette;
  locale: Locale;
  /** Width of the editing page (points). */
  width: number;
  /** Read an image block file (to write into the page). */
  readImage: (uri: string) => Promise<Uint8Array>;
  /**
   * Crop the box area (original pixels) from the original image of this page, return the cropped
   * image (D-467, "Use original image"); returns null if it cannot be cropped. Not shown when
   * absent.
   */
  cropOriginal?: (page: DocPage, box: Box) => Promise<string | null>;
  onApply: (next: DocDoc) => void;
  /** Cursor is on the page (room collapses toolbar, switches to this row of format buttons). */
  onSelecting: (on: boolean) => void;
  /** Has text modified but not yet merged back into the document: supplies the merge function; null otherwise. */
  onTyping?: (flush: (() => void) | null) => void;
}) {
  // Pages are generated based on `shown`: refs returned by the page refer to blocks in it.
  // Documents merged by itself do not re-generate the page. Each time the document changes, check:
  // if it is the exact copy just merged back from the page, consume this marker; otherwise (undo,
  // redo, insert/delete row/column), re-generate the page. Undo might precisely return to a
  // previous copy merged from the page, so the marker is cleared after one use.
  const [shown, setShown] = useState(doc);
  const [seen, setSeen] = useState(doc);
  const [fromPage, setFromPage] = useState<DocDoc | null>(null);
  if (doc !== seen) {
    setSeen(doc);
    setFromPage(null);
    if (doc !== fromPage) setShown(doc);
  }
  // Appearance returned by the page (generated from which document version). After the page is re-generated, unmerged text on the old page does not match the new document and is discarded.
  const pending = useRef<{ base: DocDoc; pages: EditedPage[] } | null>(null);
  const [hasPending, setHasPending] = useState(false);
  if (doc !== seen && doc !== fromPage && hasPending) setHasPending(false);
  const [state, setState] = useState<PageState>({ focus: false });
  // WebView type is a function component (without ref), the actual ref has injectJavaScript.
  const web = useRef<{ injectJavaScript?: (js: string) => void } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Generate pages only after image block bytes are read. Each re-generation checks: "Use original
  // image" (D-467) may introduce newly cropped images. Unreadable ones are marked as null (drawn as
  // gray blocks) and not read again.
  const [images, setImages] = useState<Record<string, string | null>>({});
  const srcs = useMemo(() => imageSrcs(shown), [shown]);
  // The file reading function is new on every render: use the latest one without re-reading due to it.
  const read = useRef(readImage);
  useEffect(() => {
    read.current = readImage;
  });
  useEffect(() => {
    const missing = srcs.filter((src) => !(src in images));
    if (!missing.length) return;
    let alive = true;
    Promise.all(
      missing.map((src) =>
        read.current(src).then(
          (bytes) => [src, jpegDataUrl(bytes)] as const,
          () => [src, null] as const,
        ),
      ),
    ).then((pairs) => {
      if (alive) setImages((had) => ({ ...had, ...Object.fromEntries(pairs) }));
    });
    return () => {
      alive = false;
    };
  }, [srcs, images]);
  const ready = srcs.every((src) => src in images);
  const hasCrop = !!cropOriginal;

  const html = useMemo(() => {
    if (!ready) return null;
    const loaded = Object.fromEntries(
      Object.entries(images).filter((e): e is [string, string] => e[1] !== null),
    );
    return wordPageHtml(
      shown,
      width,
      loaded,
      false,
      hasCrop
        ? {
            one: t(locale, 'wordSwapOriginal'),
            lines: t(locale, 'wordSwapOriginalLines', { n: '{n}' }),
            primary: palette.primary,
            tint: palette.primaryTint,
            text: palette.primaryText,
            border: palette.border,
          }
        : null,
    );
  }, [ready, shown, width, images, hasCrop, locale, palette]);

  // Latest document and callbacks (used when merging back; page messages and timers receive old closures).
  const latest = useRef({ doc, shown, onApply });
  useEffect(() => {
    latest.current = { doc, shown, onApply };
  });

  /** Merge modified text back into the document, record an undo step; return the merged document. */
  function commit(): DocDoc {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { doc: current, shown: base, onApply: apply } = latest.current;
    const edited = pending.current;
    pending.current = null;
    setHasPending(false);
    if (!edited || edited.base !== base) return current;
    const pw = paperWidth(width);
    const next = mergeEdited(base, edited.pages, (block, p) =>
      blockBase(block, base.pages[p]!, pw),
    );
    // Merged result is identical to the current one (reverted): do not record a step.
    if (sameValue(next, current)) return current;
    setFromPage(next);
    apply(next);
    return next;
  }
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => {
    onTyping?.(hasPending ? () => commitRef.current() : null);
  }, [hasPending, onTyping]);
  useEffect(() => {
    onSelecting(state.focus);
  }, [state.focus, onSelecting]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      onSelecting(false);
    },
    [onSelecting],
  );

  function onMessage(e: WebViewMessageEvent) {
    let msg: { type?: string } & Record<string, unknown>;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === 'doc' && Array.isArray(msg.pages)) {
      pending.current = { base: latest.current.shown, pages: msg.pages as EditedPage[] };
      setHasPending(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => commitRef.current(), IDLE_MS);
    } else if (msg.type === 'swap') {
      // "Replace with original" on the original image floating window (D-469).
      void swapInOriginal();
    } else if (msg.type === 'state') {
      setState(msg as unknown as PageState);
      // Leaving the page (collapsing keyboard): modified text is merged back immediately.
      if (!msg.focus) commitRef.current();
    }
  }

  function command(name: string) {
    web.current?.injectJavaScript?.(`window.__wordCommand(${JSON.stringify(name)});true;`);
  }

  // ---- Cursor inside a table: insert/delete rows and columns (re-generate page after editing) ----
  const table = tableUnderCursor(shown, state.cell ?? null);
  const actions = table ? tableActionsOf(table) : [];

  function runTable(id: TableActionId) {
    if (!table) return;
    // First merge modified text back; after merging, block indices may have changed (preceding paragraphs deleted or split), locate the table by its identity before editing.
    const merged = commit();
    const at = findTable(merged, table.block.table);
    if (!at) return;
    const next =
      id === 'desk-table-delete'
        ? deleteBlock(merged, at)
        : editDocTable(merged, at, (t) => tableEdit(id, table.cell, t));
    if (next !== merged) latest.current.onApply(next);
  }

  // ---- "Use original image" (D-467): signatures and stamps recognized as text, swap back to the cropped block from the original image ----
  // Swap together when multiple rows are selected (D-468); all must be on the same page.
  const targets = cropOriginal
    ? swapTargets(shown, state.refs ?? (state.ref ? [state.ref] : []))
    : null;

  async function swapInOriginal() {
    if (!cropOriginal || !targets) return;
    command('blur');
    // First merge modified text back (cropping takes time: swap on the merged copy, at which point
    // `latest` may not yet be updated). After merging, block indices may change, locate by original
    // bounding box; images encountered (previously swapped or cropped stamps) are replaced with a
    // single image.
    const current = commit();
    const area = originalArea(current, targets.page, targets.boxes);
    if (!area) return;
    const src = await cropOriginal(current.pages[targets.page]!, area);
    if (!src) return;
    latest.current.onApply(
      swapToOriginal(current, targets.page, targets.boxes, { src, box: area }),
    );
  }

  const align = state.align ?? 'left';
  const button = (id: string, label: StringKey, content: ReactNode, name: string, on = false) => (
    <FormatButton
      key={id}
      id={id}
      label={t(locale, label)}
      on={on}
      palette={palette}
      onPress={() => command(name)}>
      {content}
    </FormatButton>
  );
  const glyph = (text: string, style: object = {}) => (
    <Text style={[palette.font('bodyBold', 20), { color: palette.text }, style]}>{text}</Text>
  );

  if (!html) {
    return (
      <View style={styles.flex} testID="desk-editor">
        <ActivityIndicator style={styles.flex} color={palette.primary} />
      </View>
    );
  }
  return (
    <View style={styles.flex} testID="desk-editor">
      <WebView
        ref={web as never}
        testID="word-editor-page"
        style={styles.flex}
        source={{ html, baseUrl: 'about:blank' }}
        originWhitelist={['*']}
        // Display only pages generated by us, do not open any links.
        onShouldStartLoadWithRequest={(r) => r.url === 'about:blank' || r.url.startsWith('data:')}
        onMessage={onMessage}
        javaScriptEnabled
        allowFileAccess={false}
        setSupportMultipleWindows={false}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        automaticallyAdjustContentInsets={false}
        textZoom={100}
      />
      {state.focus ? (
        <View
          testID="word-format-bar"
          style={[styles.bar, { borderColor: palette.border, backgroundColor: palette.surface }]}>
          {actions.length ? (
            <ScrollView
              horizontal
              keyboardShouldPersistTaps="always"
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.actions}>
              {actions.map((a) => (
                <Pressable
                  key={a.id}
                  testID={a.id}
                  accessibilityRole="button"
                  onPress={() => runTable(a.id)}
                  style={[
                    styles.action,
                    { borderColor: a.danger ? palette.danger : palette.border },
                  ]}>
                  <Text
                    style={[
                      palette.font('body', 13),
                      { color: a.danger ? palette.danger : palette.primaryText },
                    ]}>
                    {t(locale, a.label)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
          <View style={styles.tools}>
            {button('word-bigger', 'wordBigger', glyph('A⁺'), 'bigger')}
            {button('word-smaller', 'wordSmaller', glyph('A⁻'), 'smaller')}
            {button(
              'word-bold',
              'wordBold',
              glyph('B', state.bold ? { color: palette.primary } : {}),
              'bold',
              !!state.bold,
            )}
            {button(
              'word-italic',
              'wordItalic',
              glyph('I', {
                fontStyle: 'italic',
                ...(state.italic ? { color: palette.primary } : {}),
              }),
              'italic',
              !!state.italic,
            )}
            {button(
              'word-underline',
              'wordUnderline',
              glyph('U', {
                textDecorationLine: 'underline',
                ...(state.underline ? { color: palette.primary } : {}),
              }),
              'underline',
              !!state.underline,
            )}
            {button(
              'word-align',
              'wordAlign',
              <SymbolView name={ALIGN_ICON[align]} size={22} tintColor={palette.text} />,
              NEXT_ALIGN[align],
            )}
            {button(
              'word-hide-keyboard',
              'wordHideKeyboard',
              <SymbolView
                name={{ ios: 'keyboard.chevron.compact.down', android: 'keyboard_hide' }}
                size={22}
                tintColor={palette.text}
              />,
              'blur',
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function FormatButton({
  id,
  label,
  on,
  palette,
  onPress,
  children,
}: {
  id: string;
  label: string;
  on: boolean;
  palette: Palette;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tool,
        on ? { backgroundColor: palette.primaryTint } : null,
        { opacity: pressed ? 0.6 : 1 },
      ]}>
      {children}
    </Pressable>
  );
}

type TableActionId =
  | 'desk-row-above'
  | 'desk-row-below'
  | 'desk-col-left'
  | 'desk-col-right'
  | 'desk-row-delete'
  | 'desk-col-delete'
  | 'desk-table-delete';

interface TableUnderCursor {
  at: DocRef;
  block: DocTable;
  cell: TableCell;
}

/** Table and cell where the cursor is located (based on the document at page generation time). */
function tableUnderCursor(
  doc: DocDoc,
  cursor: { ref: string; i: number } | null,
): TableUnderCursor | null {
  const at = cursor ? refOf(cursor.ref) : null;
  const block = at ? leafAt(doc, at) : undefined;
  const cell = block?.kind === 'table' ? block.table.cells[cursor!.i] : undefined;
  return at && block?.kind === 'table' && cell ? { at, block, cell } : null;
}

function tableActionsOf({
  block,
  cell,
}: TableUnderCursor): { id: TableActionId; label: StringKey; danger?: boolean }[] {
  return [
    { id: 'desk-row-above', label: 'tableInsertRowAbove' },
    { id: 'desk-row-below', label: 'tableInsertRowBelow' },
    { id: 'desk-col-left', label: 'tableInsertColumnLeft' },
    { id: 'desk-col-right', label: 'tableInsertColumnRight' },
    ...(block.table.rows > 1
      ? [{ id: 'desk-row-delete' as const, label: 'tableDeleteRow' as const, danger: true }]
      : []),
    ...(canDeleteColumn(oneTablePage(block), cell.col)
      ? [{ id: 'desk-col-delete' as const, label: 'tableDeleteColumn' as const, danger: true }]
      : []),
    { id: 'desk-table-delete', label: 'wordDeleteTable', danger: true },
  ];
}

/** A single page containing only this table (used by Excel-to-Word conversion editing functions). */
function oneTablePage(block: DocTable) {
  const page = { source: '', width: 1, height: 1, bodySize: 11, blocks: [block] };
  return tableDocOf({ version: 1, pages: [page] }, { page: 0, block: 0 }, '')!.pages[0]!;
}

function tableEdit(id: TableActionId, cell: TableCell, t: TableDoc): TableDoc {
  const one = { page: 0, block: 0 };
  switch (id) {
    case 'desk-row-above':
      return insertRow(t, one, cell.row);
    case 'desk-row-below':
      return insertRow(t, one, cell.row + cell.rowSpan);
    case 'desk-col-left':
      return insertColumn(t, 0, cell.col);
    case 'desk-col-right':
      return insertColumn(t, 0, cell.col + cell.colSpan);
    case 'desk-row-delete':
      return deleteRow(t, one, cell.row);
    case 'desk-col-delete':
      return deleteColumn(t, 0, cell.col);
    default:
      return t;
  }
}

/** src of all image blocks in the document (deduplicated). */
function imageSrcs(doc: DocDoc): string[] {
  return [
    ...new Set(
      doc.pages.flatMap((p) => [
        ...leafBlocks(p).flatMap((b) => (b.kind === 'image' && b.src ? [b.src] : [])),
        // Original image for each page: used by the small floating window above the cursor (D-468).
        ...(p.source ? [p.source] : []),
      ]),
    ),
  ];
}

function leafAt(doc: DocDoc, at: DocRef) {
  const block = doc.pages[at.page]?.blocks[at.block];
  if (at.cell === undefined) return block?.kind === 'row' ? undefined : block;
  return block?.kind === 'row' ? block.cells[at.cell]?.blocks[at.item ?? -1] : undefined;
}

/** Where this table is located after merging back (locate by table itself: preceding paragraphs deleted or split, indices will change). */
function findTable(doc: DocDoc, table: object): DocRef | null {
  for (const [p, page] of doc.pages.entries()) {
    for (const [b, block] of page.blocks.entries()) {
      if (block.kind === 'table' && sameTable(block.table, table)) return { page: p, block: b };
      if (block.kind !== 'row') continue;
      for (const [c, cell] of block.cells.entries()) {
        for (const [i, leaf] of cell.blocks.entries()) {
          if (leaf.kind === 'table' && sameTable(leaf.table, table)) {
            return { page: p, block: b, cell: c, item: i };
          }
        }
      }
    }
  }
  return null;
}

/** Blocks to swap for "Use original image": paragraphs and lists within these refs (only those on the same page as the first block); null if none. */
function swapTargets(doc: DocDoc, refs: readonly string[]): { page: number; boxes: Box[] } | null {
  const leaves = refs
    .map((r) => refOf(r))
    .filter((at): at is DocRef => at !== null)
    .map((at) => ({ at, leaf: leafAt(doc, at) }))
    .filter(({ leaf }) => leaf?.kind === 'paragraph' || leaf?.kind === 'list');
  const page = leaves[0]?.at.page;
  if (page === undefined) return null;
  return {
    page,
    boxes: leaves.filter(({ at }) => at.page === page).map(({ leaf }) => leaf!.box),
  };
}

/** Same table: cell text may have been modified (replaced with new objects upon merge), recognize by position and size. */
function sameTable(a: { box: object; rows: number }, b: object) {
  const t = b as { box: object; rows: number };
  return JSON.stringify(a.box) === JSON.stringify(t.box) && a.rows === t.rows;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 4 },
  tools: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' },
  tool: {
    minWidth: 40,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: { flexDirection: 'row', gap: 8, paddingHorizontal: 8, paddingBottom: 4 },
  action: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    minHeight: 32,
    justifyContent: 'center',
  },
});
