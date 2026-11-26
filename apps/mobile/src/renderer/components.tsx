import {
  bindRecord,
  buttonKind,
  isKnownComponent,
  pageBrowseHost,
  pageChoices,
  pageDial,
  pagePeriod,
  resolvePageChoice,
  pageZones,
  type BlockOf,
  type Component,
  type Locale,
  type OpenTarget,
  type Page,
  type PageChoice,
  type PageChoiceState,
  type Registry,
  type WorkspaceConfig,
} from '@morph/core';

import { useRef, useState, type ReactNode } from 'react';
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewProps,
} from 'react-native';

import { GestureDetector, type PanGesture } from 'react-native-gesture-handler';

import { FocusToolbar } from '../editing/FocusItem';
import type { SingleDrag } from '../editing/useSingleDrag';
import { BackdropFill, onPicture } from './Backdrop';
import { resolveChoice } from './PeriodBar';
import { ListBrowseBar, useBrowseSelection, type BrowseSelection, type RecordBlock } from './data';
import { DialHost, type DialSlots } from './Dial';
import { Item, WhenRecords } from './registry';
import type { Palette } from './theme';

// Page rendering: arranges components on a page in order; see registry.tsx (RENDERERS) for how each component is rendered.

export interface RenderEnv {
  config: WorkspaceConfig;
  palette: Palette;
  locale: Locale;
  registry: Registry;
  /** False during preview: components are display-only and do not respond to clicks. */
  interactive: boolean;
  /** Opens a page, system entry, or quick action (used by buttons, shortcuts, and tool cards; quick actions only open, D-256). */
  navigate: (target: OpenTarget) => void;
  /** Inside a horizontal row or grid cell: changes cards to display icons above and text below. */
  inCell?: boolean;
  /** Indicates the column index (starting from 0) and total column count in a grid: edge blocks align with page margins (D-454). */
  cellColumn?: { index: number; of: number };
  /** Rendered in the fixed bottom zone of the page: entries are drawn as buttons matching the floating action button style (D-437). */
  inBottomZone?: boolean;
  /** Time range selected on the page (D-440): present only when the page contains time tabs; charts and metric cards render according to this when source.period is "page". State is restricted to the page and is not persisted. */
  pageRange?: { choice: PageChoice; set: (choice: PageChoice) => void };
  /**
   * Row of options on the page (D-573): present only when the page contains tabs by a choice field;
   * blocks reading the same table with source.choice set to "page" display only records matching
   * the selected option (null = all). State is restricted to the page and is not persisted.
   */
  pageChoice?: PageChoiceState & { set: (option: string | null) => void };
  /** The page currently being rendered (used when a picture component changes its photo). */
  pageId?: string;
  /** Pages that can be edited directly: opens their action panel when long-pressing a component (D-052). Not present in preview and system pages. */
  edit?: (componentId: string) => void;
  /** Single-component editing preserves the normal page layout, adding a toolbar only to the selected item. */
  focus?: {
    selectedId: string | null;
    onEdit: (id: string) => void;
    onDone: () => void;
    drag?: SingleDrag;
  };
  parentDrag?: PanGesture;
  focusWithinSelected?: boolean;
  focusWithinDimmed?: boolean;
  /** Long-press action for the current component: tappable parts within components (cards, buttons, list rows) must also respond to long presses. */
  onLongPress?: () => void;
  /**
   * Draft mode (D-190): viewable but not usable. During setup, opening pages works normally, but
   * actions that perform real work (running, recording, picking images, opening files) call this
   * instead (with a prompt: "Available after applying").
   */
  locked?: () => void;
  /** Page dedicated to a single record (D-342): renders by replacing "$record" in components with this record's ID. */
  recordId?: string;
  /** Number of times the page was scrolled to the bottom: lists that can load more display one extra page each time (decided by the founder 2026-11-04). */
  pageEnd?: number;
  /** The list whose state is kept on the page (search rendered in a fixed area, or floating button needs to pick records from it). */
  pageBrowse?: BrowseSelection;
  /** Separate floating buttons (their state is on the page, DialHost). */
  dial?: DialSlots;
}

/** Proximity to the bottom of the page considered scrolled to the bottom. */
const PAGE_END_MARGIN = 240;

interface PageViewProps {
  page: Page;
  env: RenderEnv;
  bottomInset?: number;
  /** How much clearance the bottom fixed area needs (navigation bar, floating button); defaults to bottomInset when omitted. */
  zoneInset?: number;
  /** Additional scroll settings (restores scroll position when remounted after editing). */
  scroll?: ScrollViewProps;
}

/** Page switching (toggling on the navigation bar) starts from the top: temporary searches, sorting, and filters set by the user on the list are discarded upon leaving, per invariant 15. */
export function PageView(props: PageViewProps) {
  return <PageBody key={props.page.id} {...props} />;
}

/** List with state kept on the page (useBrowseSelection is a hook, so it is a separate component). */
function BrowseHost({
  block,
  env,
  children,
}: {
  block: RecordBlock;
  env: RenderEnv;
  children: (selection: BrowseSelection) => ReactNode;
}) {
  const selection = useBrowseSelection(block, env);
  return <>{children(selection)}</>;
}

function PageBody({ page, env, bottomInset = 0, zoneInset, scroll }: PageViewProps) {
  // Full-page background image (D-258): text on the image always uses the primary text color, with components floating above it.
  const picture = page.backdrop?.assetId ? page.backdrop : undefined;
  const palette = onPicture(env.palette, picture);
  const [pageEnd, setPageEnd] = useState(0);
  const [bottomHeight, setBottomHeight] = useState(0);
  // Time range selected on the page (D-440): when time tabs exists, the user's selection is stored here; reverts to default if the block's options are modified.
  const periodBlock = pagePeriod(page);
  const [pickedRange, setPickedRange] = useState<PageChoice | null>(null);
  const pageRange = periodBlock
    ? { choice: resolveChoice(periodBlock, pickedRange), set: setPickedRange }
    : undefined;
  // Row of options on the page (D-573): the user's choice is stored here (undefined = not yet clicked, null = all); reverts to default if the options are modified.
  const choicesBlock = pageChoices(page);
  const [pickedOption, setPickedOption] = useState<string | null | undefined>(undefined);
  const pageChoice = choicesBlock
    ? {
        table: choicesBlock.source.table,
        field: choicesBlock.source.field,
        option: resolvePageChoice(
          choicesBlock,
          env.config.data.tables.find((x) => x.id === choicesBlock.source.table),
          pickedOption,
        ),
        set: setPickedOption,
      }
    : undefined;
  const pageEnv: RenderEnv = {
    ...env,
    palette,
    pageId: page.id,
    pageEnd,
    ...(pageRange ? { pageRange } : {}),
    ...(pageChoice ? { pageChoice } : {}),
  };
  // During single-component editing, the fixed area is laid out normally within the content (dragging and toolbars are on the scrolling content), maintaining the same position and order as in the config.
  const editing = !!env.focus?.selectedId;
  const zones = pageZones(page);
  const hasZones = !editing && (zones.top.length > 0 || zones.bottom.length > 0);
  // D-352: The bottom-sheet add form is a bottom-right floating "+", which does not scroll with the content.
  const floats = (c: Component) => c.look === 'form' && c.show.mode === 'sheet';
  const floating = page.blocks.filter((c) => !c.hidden && floats(c));
  const inScroll = editing ? page.blocks.filter((c) => !c.hidden) : zones.middle;
  const host = pageBrowseHost(page);
  const dial = pageDial(page) as BlockOf<'dial'> | undefined;

  // Scrolled to bottom: height changes count at most once per content change; continues counting while the page fits but is not yet fully filled (content height increases while still at the bottom), until filled or no more content remains.
  const tracksEnd = page.blocks.some(
    (c) => (c as { show?: { browse?: unknown } }).show?.browse !== undefined,
  );
  const metrics = useRef({ y: 0, height: 0, content: 0, fired: -1 });
  const checkEnd = () => {
    const m = metrics.current;
    if (m.height <= 0 || m.content <= 0 || m.fired === m.content) return;
    if (m.y + m.height < m.content - PAGE_END_MARGIN) return;
    m.fired = m.content;
    setPageEnd((n) => n + 1);
  };
  const endTracking: ScrollViewProps = tracksEnd
    ? {
        scrollEventThrottle: scroll?.scrollEventThrottle ?? 100,
        onScroll: (e) => {
          scroll?.onScroll?.(e);
          const n = e.nativeEvent;
          Object.assign(metrics.current, {
            y: n.contentOffset.y,
            height: n.layoutMeasurement.height,
            content: n.contentSize.height,
          });
          checkEnd();
        },
        onLayout: (e) => {
          scroll?.onLayout?.(e);
          metrics.current.height = e.nativeEvent.layout.height;
          checkEnd();
        },
        onContentSizeChange: (w, h) => {
          scroll?.onContentSizeChange?.(w, h);
          metrics.current.content = h;
          checkEnd();
        },
      }
    : {};

  const layout = (
    selection: BrowseSelection | undefined,
    slots: DialSlots | undefined,
    overlay: ReactNode,
  ) => {
    const pinnedList = !editing && selection?.block.show.browse?.pin === true;
    const contentEnv: RenderEnv = selection
      ? { ...pageEnv, pageBrowse: { ...selection, pinned: pinnedList } }
      : pageEnv;
    const content = (
      <ScrollView
        testID={env.focus ? 'editable-scroll' : undefined}
        ref={(view) => env.focus?.drag?.attachScroll(view)}
        {...scroll}
        {...endTracking}
        // Gradient background drawn on the outer container (melding with the status bar area), with the page itself being transparent.
        style={palette.hasBackdrop || picture ? undefined : { backgroundColor: palette.background }}
        // Data form: allows directly tapping options and buttons when the keyboard pops up, and automatically scrolls the input box above the keyboard.
        keyboardShouldPersistTaps="handled"
        // Dismiss keyboard on drag; dismiss keyboard on tapping empty space (page-blank below).
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{
          flexGrow: 1,
          padding: palette.pad,
          gap: palette.gap,
          // Reserve extra height when a floating "+" is present so the bottom-most content is not obscured (D-352). The bottom fixed area is outside the scrolling region, and the navigation bar clears space for it.
          paddingBottom:
            24 +
            (hasZones && zones.bottom.length > 0 ? 0 : bottomInset) +
            (floating.length > 0 ? 80 : 0),
        }}>
        {env.focus?.selectedId ? (
          <Pressable
            testID="single-blank"
            accessible={false}
            style={StyleSheet.absoluteFill}
            onPress={env.focus.onDone}
          />
        ) : (
          <Pressable
            testID="page-blank"
            accessible={false}
            style={StyleSheet.absoluteFill}
            onPress={() => Keyboard.dismiss()}
          />
        )}
        {runnerGrid(inScroll.filter((c) => !floats(c))).map((block) =>
          Array.isArray(block) ? (
            <View
              key={block[0]!.id}
              style={[
                styles.row,
                {
                  gap: palette.gap - 4,
                  zIndex: block.some((c) => c.id === env.focus?.selectedId) ? 10 : 0,
                },
              ]}>
              {block.map((c) => (
                <Item
                  key={c.id}
                  component={c}
                  env={{ ...contentEnv, inCell: true }}
                  style={styles.cell}
                />
              ))}
              {block.length === 1 ? <View style={styles.cell} /> : null}
            </View>
          ) : (
            <Item key={block.id} component={block} env={contentEnv} />
          ),
        )}
        {env.focus?.selectedId ? <FocusToolbar env={pageEnv} page={page} /> : null}
      </ScrollView>
    );
    const drag = env.focus?.drag;
    // Background image is drawn behind the scrolling content and does not scroll with it.
    const fill = picture ? (
      <BackdropFill backdrop={picture} color={palette.background} palette={palette} />
    ) : null;
    const behind = picture ? { backgroundColor: palette.background } : undefined;
    const zoneBackground =
      palette.hasBackdrop || picture ? undefined : { backgroundColor: palette.background };
    const fab =
      floating.length > 0 ? (
        <View
          pointerEvents="box-none"
          style={[
            styles.fab,
            {
              right: palette.pad,
              bottom: 20 + (hasZones && zones.bottom.length > 0 ? bottomHeight : bottomInset),
            },
          ]}>
          {floating.map((c) => (
            <Item key={c.id} component={c} env={pageEnv} />
          ))}
        </View>
      ) : null;
    const topBlocks = hasZones ? zones.top.filter((c) => !floats(c)) : [];
    const showBar = pinnedList && selection && selection.sorted.length > 0;
    const bar = showBar ? <ListBrowseBar selection={selection} env={pageEnv} /> : null;
    const hostShowIf = selection?.block.showIf;
    const topZone =
      topBlocks.length > 0 || bar ? (
        <View
          testID="page-top-zone"
          style={[styles.topZone, { padding: palette.pad, gap: palette.gap - 4 }, zoneBackground]}>
          {topBlocks.map((c) => (
            <Item key={c.id} component={c} env={pageEnv} />
          ))}
          {bar && hostShowIf ? <WhenRecords showIf={hostShowIf}>{bar}</WhenRecords> : bar}
        </View>
      ) : null;
    const bottomBlocks = hasZones ? zones.bottom.filter((c) => !floats(c)) : [];
    const others = bottomBlocks.filter((c) => c.look !== 'dial');
    const bottomZone =
      bottomBlocks.length > 0 ? (
        <View
          testID="page-bottom-zone"
          onLayout={(e) => setBottomHeight(e.nativeEvent.layout.height)}
          style={[
            styles.bottomZone,
            {
              paddingHorizontal: palette.pad,
              paddingBottom: 10 + (zoneInset ?? bottomInset),
              gap: palette.gap - 4,
            },
            zoneBackground,
          ]}>
          <View style={[styles.cell, { gap: palette.gap - 4 }]}>
            {others.map((c) => (
              <Item key={c.id} component={c} env={{ ...pageEnv, inBottomZone: true }} />
            ))}
          </View>
          {dial && bottomBlocks.includes(dial) ? (
            <Item
              key={dial.id}
              component={dial}
              env={slots ? { ...pageEnv, dial: slots } : pageEnv}
            />
          ) : null}
        </View>
      ) : null;
    return drag ? (
      <View ref={(view) => drag.attachViewport(view)} style={{ flex: 1, ...behind }}>
        {fill}
        {topZone}
        <GestureDetector gesture={drag.scrollGesture}>{content}</GestureDetector>
        {bottomZone}
        {drag.target ? (
          <View
            testID="single-drop-line"
            pointerEvents="none"
            style={[
              { position: 'absolute', backgroundColor: palette.primary, zIndex: 100 },
              {
                left: drag.target.line.x,
                top: drag.target.line.y,
                width: drag.target.line.width,
                height: drag.target.line.height,
              },
            ]}
          />
        ) : null}
        {env.focus?.selectedId ? <FocusToolbar env={pageEnv} page={page} pinned /> : null}
        {fab}
        {overlay}
      </View>
    ) : picture || fab || topZone || bottomZone || overlay ? (
      <View style={{ flex: 1, ...behind }}>
        {fill}
        {topZone}
        {content}
        {bottomZone}
        {fab}
        {overlay}
      </View>
    ) : (
      content
    );
  };

  const withDial = (selection: BrowseSelection | undefined) =>
    dial ? (
      <DialHost block={dial} env={pageEnv} selection={selection} bottom={bottomHeight}>
        {(slots, overlay) => layout(selection, slots, overlay)}
      </DialHost>
    ) : (
      layout(selection, undefined, null)
    );
  if (!host) return withDial(undefined);
  // D-342: On a page dedicated to a record, "$record" in filters is replaced with this record.
  const block = (env.recordId ? bindRecord(host, env.recordId) : host) as RecordBlock;
  return (
    <BrowseHost block={block} env={pageEnv}>
      {withDial}
    </BrowseHost>
  );
}

/**
 * Two or more adjacent run cards are arranged in a two-column grid (D-108), such as dozens of
 * functions on the tools page; a single one remains a full card. Affects display only; still
 * individual components in the config, keeping the structure seen by the AI and edit mode
 * unchanged.
 */
/** A button that runs a quick action (the former action look). */
const runsQuickAction = (c: Component): c is BlockOf<'button'> =>
  isKnownComponent(c) && c.look === 'button' && buttonKind(c) === 'run';

function runnerGrid(components: readonly Component[]): (Component | Component[])[] {
  const blocks: (Component | Component[])[] = [];
  let run: Component[] = [];
  const flush = () => {
    const tiles =
      run.length >= 2 || run.some((c) => runsQuickAction(c) && c.show?.shape === 'tile');
    if (tiles) for (let i = 0; i < run.length; i += 2) blocks.push(run.slice(i, i + 2));
    else blocks.push(...run);
    run = [];
  };
  for (const c of components) {
    // Components specifying row or card do not enter the grid; a single component specifying tile is placed into the grid (D-230).
    if (runsQuickAction(c) && c.show?.shape !== 'row' && c.show?.shape !== 'card') run.push(c);
    else {
      flush();
      blocks.push(c);
    }
  }
  flush();
  return blocks;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'stretch' },
  cell: { flex: 1 },
  fab: { position: 'absolute', alignItems: 'flex-end' },
  topZone: { paddingBottom: 8 },
  bottomZone: { flexDirection: 'row', alignItems: 'center', paddingTop: 10 },
});
