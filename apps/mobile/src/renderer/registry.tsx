import {
  aggregateRecords,
  bindRecord,
  builtinText,
  buttonKind,
  buttonShape,
  calendarOf,
  fillCallout,
  filterRecords,
  isKnownComponent,
  isRecordToolUse,
  isToolRefUse,
  appTargetId,
  packageTargetId,
  toolTargetId,
  type ChoiceTabs,
  type Collection,
  type Component,
  type ComponentOf,
  type ComponentType,
  type DataRecord,
  type KnownComponent,
  type OpenTarget,
  type ShowIf,
  type TimeTabs,
} from '@morph/core';

import { useState, type ReactNode } from 'react';
import {
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { useComputedRecords, useRecords } from '../data/records';
import { LONG_PRESS_MS } from '../editing/entry';
import { t } from '../i18n';
import { FocusItem } from '../editing/FocusItem';
import { AppGrid } from './AppGrid';
import { Chart } from './Chart';
import { ChoiceBar } from './ChoiceBar';
import type { RenderEnv } from './components';
import { RecordForm, RecordList, Stat, amountText, type RecordBlock } from './data';
import { BottomPill, DialButton } from './Dial';
import { ListTools } from './ListTools';
import { MonthCalendar } from './MonthCalendar';
import { PeriodBar } from './PeriodBar';
import { Board } from './Board';
import { Grid } from './Grid';
import { Tiles } from './Tiles';
import { FileList } from './FileList';
import { FilePick } from './FilePick';
import { FileSlot } from './FileSlot';
import { ImageView } from './ImageView';
import { onPicture } from './Backdrop';
import { UiIcon } from './Icon';
import { QuickActionList } from './QuickActionList';
import { ActionButton } from './RecordActions';
import { RichText } from './RichText';
import { SingleRecord } from './SingleRecord';
import { SIZES, textColor } from './style';
import { cardColors, iconColors, onSurface } from './theme';
import { Tile, ToolCard } from './Tile';
import { ToolGrid } from './ToolGrid';
import { Button, Card, IconTile } from './ui';
import { WorkflowRunner } from './WorkflowRunner';

// Whitelist renderer (§5.2, §7A): Each component type in the config corresponds to a real component
// here. The config only provides data and contains no executable content. Component structures are
// defined in core's components/; for adding new components, see docs/COMPONENTS.md.

/** Render a component. Called as a function (not a React component), so hooks cannot be used; put logic needing hooks into your own component. */
export type Renderer<T extends ComponentType> = (
  component: ComponentOf<T>,
  env: RenderEnv,
) => ReactNode;

/** Target for open buttons and quick action entries. Quick actions cannot be executed inside a draft (D-190): they can be run after opening, whereas a draft can be viewed but not used. */
const open = (env: RenderEnv, target: OpenTarget) =>
  env.locked && toolTargetId(target) !== null ? env.locked() : env.navigate(target);

const scaleOf = (c: KnownComponent) => SIZES[c.style?.size ?? 'medium'];
const alignOf = (c: KnownComponent): TextStyle | undefined =>
  c.style?.align === 'center' ? styles.textCenter : undefined;

export const RENDERERS: { [T in ComponentType]: Renderer<T> } = {
  header: (c, { palette }) => (
    <View style={styles.header}>
      <Text
        style={[
          palette.font('display', 28 * scaleOf(c)),
          { color: textColor(palette, c.style?.tone, palette.text), letterSpacing: -0.5 },
          alignOf(c),
        ]}>
        {c.show.title}
      </Text>
      {c.show.subtitle ? (
        <Text style={[palette.font('body', 15 * scaleOf(c)), { color: palette.muted }, alignOf(c)]}>
          {c.show.subtitle}
        </Text>
      ) : null}
    </View>
  ),
  text: (c, env) => (
    <RichText
      source={c.show.text}
      env={env}
      color={textColor(env.palette, c.style?.tone, env.palette.muted)}
      size={15 * scaleOf(c)}
      align={alignOf(c)}
    />
  ),
  // Anything tapped that opens something or does one thing (the former entry, action and picker
  // looks were merged into button): drawn by what it does and its shape.
  button: (c, env) => {
    const use = c.tools?.[0];
    const shape = buttonShape(c);
    switch (buttonKind(c)) {
      case 'run':
        return use && isToolRefUse(use) ? (
          <WorkflowRunner
            workflowId={use.tool}
            look={
              shape === 'card' || shape === 'row' || shape === 'tile' || shape === 'icon'
                ? shape
                : undefined
            }
            backdrop={c.style?.backdrop}
            env={env}
          />
        ) : null;
      case 'pick': {
        const tool = use && isToolRefUse(use) ? use.tool : undefined;
        return (
          <FilePick
            source={tool === '$pick.files' ? 'files' : tool === '$pick.open' ? 'open' : 'media'}
            iconOnly={shape === 'icon'}
            env={env}
          />
        );
      }
      case 'record':
        return use && isRecordToolUse(use) ? (
          <ActionButton
            action={use}
            label={c.show?.label ?? ''}
            variant={shape === 'outline' || shape === 'text' || shape === 'icon' ? shape : 'filled'}
            icon={c.show?.icon}
            env={env}
            style={c.style?.align === 'center' ? styles.centerSelf : undefined}
          />
        ) : null;
      case 'file':
        return <FileSlot component={c} env={env} />;
      case 'package':
        return (
          <ToolCard
            toolId={packageTargetId(c.opens!)!}
            look={shape === 'row' ? 'row' : 'tile'}
            style={c.style}
            env={env}
          />
        );
      default:
        return <OpenButton c={c} env={env} />;
    }
  },
  notice: (c, env) =>
    c.source ? (
      <SourcedNotice c={c} env={env} />
    ) : (
      <NoticeCard c={c} env={env} text={c.show.text} />
    ),
  image: (c, env) => (
    <ImageView props={c.show} env={env} componentId={c.id} center={c.style?.align === 'center'} />
  ),
  // A thin line through the space (the former divider look) or just the space.
  spacer: (c, { palette }) =>
    c.show.line ? (
      <View
        style={[
          styles.divider,
          { backgroundColor: palette.border, marginVertical: LINE_MARGIN[c.show.size] },
        ]}
      />
    ) : (
      <View style={{ height: { small: 4, medium: 16, large: 32 }[c.show.size] }} />
    ),
  group: (c, env) => <Group component={c} env={env} />,
  // Calendar (D-305) reads records for only one month; large blocks (D-311) and boards (D-313) have different rendering logic and are separate components.
  list: (c, env) => <ToolList block={c} env={env} />,
  cards: (c, env) => <ToolList block={c} env={env} />,
  checklist: (c, env) => <ToolList block={c} env={env} />,
  table: (c, env) => <ToolList block={c} env={env} />,
  gallery: (c, env) => <ToolList block={c} env={env} />,
  calendar: (c, env) => (
    <MonthCalendar block={c} env={env} tone={c.style?.tone} componentId={c.id} />
  ),
  tiles: (c, env) => <Tiles block={c} env={env} tone={c.style?.tone} />,
  // Check-in grid (D-610): rows × time columns, tap a cell to add a record or delete the unique existing record.
  grid: (c, env) => <Grid block={c} env={env} tone={c.style?.tone} />,
  board: (c, env) => <Board block={c} env={env} tone={c.style?.tone} />,
  form: (c, env) => <RecordForm block={c} env={env} tone={c.style?.tone} />,
  number: (c, env) => (
    <Stat
      block={c}
      env={env}
      tone={c.style?.tone}
      backdrop={c.style?.backdrop}
      size={c.style?.size}
    />
  ),
  chart: (c, env) => <Chart block={c} env={env} tone={c.style?.tone} />,
  files: (c, env) => <FileList block={c} env={env} />,
  catalog: (c, env) =>
    c.source.catalog === 'quickActions' ? (
      <QuickActionList block={c} source={c.source} env={env} />
    ) : c.source.catalog === 'packages' ? (
      <ToolGrid
        grid={c}
        ids={c.source.ids}
        page={env.config.containers.pages.find((p) => p.id === env.pageId)}
        env={env}
      />
    ) : (
      <AppGrid grid={c} env={env} />
    ),
  single: (c, env) => <SingleRecord block={c} env={env} tone={c.style?.tone} />,
  dial: (c, env) => <DialButton block={c} env={env} />,
  tabs: (c, env) =>
    c.source ? (
      <ChoiceBar block={c as ChoiceTabs} env={env} />
    ) : (
      <PeriodBar block={c as TimeTabs} env={env} />
    ),
};

/** Space above and below the line of a spacer with line (small = the former divider). */
const LINE_MARGIN = { small: 4, medium: 8, large: 16 } as const;

/**
 * Blocks placed directly on the page background (D-409); all other block contents reside inside
 * cards, rendered with card color schemes. For blocks that also have page-overlay titles (list
 * sections, calendar current day, tool grid titles), use onPage to switch back. The quick-action
 * library is the content of the system page (WorkflowsScreen) and shares the same color scheme as
 * system pages. Buttons drawn as cards (row, tile, a quick action or a tool's page, a file slot)
 * sit in cards; the others sit on the page.
 */
const PAGE_LOOKS: ReadonlySet<ComponentType> = new Set<ComponentType>([
  'header',
  'text',
  'group',
  'spacer',
  'image',
  'dial',
]);

function onPage(c: KnownComponent): boolean {
  if (PAGE_LOOKS.has(c.look)) return true;
  if (c.look === 'catalog') return c.source.catalog !== 'packages';
  if (c.look !== 'button') return false;
  const kind = buttonKind(c);
  if (kind === 'pick' || kind === 'record') return true;
  if (kind === 'run' || kind === 'file' || kind === 'package') return false;
  const shape = buttonShape(c);
  return shape !== 'row' && shape !== 'tile';
}

/** List, card, checklist: tools above the list (D-428) are in ListTools so data.tsx does not depend on runtime (record forms also use data.tsx). */
function ToolList({ block, env }: { block: RecordBlock; env: RenderEnv }) {
  const tools = block.tools?.filter((u) => u.as === 'list') ?? [];
  return (
    <RecordList
      block={block}
      env={env}
      tone={block.style?.tone}
      {...(tools.length > 0
        ? {
            tools: (collection: Collection, records: readonly DataRecord[], searching: boolean) => (
              <ListTools
                tools={tools}
                collection={collection}
                records={records}
                searching={searching}
                env={env}
              />
            ),
          }
        : {})}
    />
  );
}

export function ComponentView({ component, env }: { component: Component; env: RenderEnv }) {
  if (!isKnownComponent(component)) return <UnknownComponentView env={env} />;
  const card = onPage(component) ? env.palette : onSurface(env.palette);
  return (RENDERERS[component.look] as Renderer<ComponentType>)(
    withBuiltinTexts(component, env),
    card === env.palette ? env : { ...env, palette: card },
  );
}

/** When texts on components (titles, button text, etc.) are built-in texts, they follow the interface language; user-written texts are not replaced. Translation happens only at display time and is not written to the config. */
function withBuiltinTexts<C extends Component>(component: C, env: RenderEnv): C {
  const show = (component as { show?: Record<string, unknown> }).show;
  if (!show) return component;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(show)) {
    const shown = typeof value === 'string' ? builtinText(value, env.locale, env.registry) : value;
    if (shown !== value) changed = true;
    next[key] = shown;
  }
  return changed ? { ...component, show: next } : component;
}

/** Components added in newer app versions (D-254): preserved as-is in the config, with a note here indicating that the app must be updated to display them. */
/** Text of a notice about entries (D-580): {count} and {sum:field} worked out from local records (never stored); drawn once they are known, avoiding flashes. */
function SourcedNotice({ c, env }: { c: ComponentOf<'notice'>; env: RenderEnv }) {
  const source = c.source!;
  const table = env.config.data.tables.find((x) => x.id === source.table);
  const cal = calendarOf(env.config);
  const { view, records } = useComputedRecords(env.config.data.tables, table, cal);
  if (!view || records === null) return null;
  const matching = filterRecords(records, view, source.filter, new Date(), cal);
  const text = fillCallout(c.show.text, {
    count: String(matching.length),
    sum: (id) =>
      amountText(
        aggregateRecords(matching, view, 'sum', id) ?? 0,
        view.fields.find((f) => f.id === id),
        env.locale,
      ),
  });
  return <NoticeCard c={c} env={env} text={text} />;
}

/**
 * Notice: a tinted card with an optional icon, title and rich text; a notice about entries (the
 * former callout, D-580) also holds at most two buttons: one for a one-tap record tool, one that
 * opens a page.
 */
function NoticeCard({ c, env, text }: { c: ComponentOf<'notice'>; env: RenderEnv; text: string }) {
  const palette = onPicture(env.palette, c.style?.backdrop);
  const tone = c.style?.tone;
  const colors = cardColors(palette, tone ?? 'secondary');
  const fg =
    (tone ?? 'secondary') === 'secondary'
      ? palette.onSecondaryTint
      : tone === 'tertiary'
        ? palette.onTertiaryTint
        : palette.text;
  const use = c.tools?.[0];
  return (
    <Card
      palette={palette}
      background={colors.background}
      backdrop={c.style?.backdrop}
      style={styles.noticeCard}>
      <View style={styles.tileRow}>
        {c.show.icon ? (
          <IconTile
            palette={palette}
            icon={c.show.icon}
            size={36}
            {...iconColors(palette, 'solid', tone ?? 'secondary')}
          />
        ) : null}
        <View style={styles.flexText}>
          {c.show.title ? (
            <Text style={[palette.font('title', 15 * scaleOf(c)), { color: fg }, alignOf(c)]}>
              {c.show.title}
            </Text>
          ) : null}
          <RichText
            source={text}
            env={{ ...env, palette }}
            color={fg}
            size={14 * scaleOf(c)}
            align={alignOf(c)}
          />
        </View>
      </View>
      {use || c.opens ? (
        <View style={styles.calloutButtons}>
          {use && isRecordToolUse(use) && c.show.actionLabel ? (
            <ActionButton
              action={use}
              label={c.show.actionLabel}
              variant="filled"
              env={env}
              style={styles.flexButton}
            />
          ) : null}
          {c.opens && c.show.openLabel ? (
            <Button
              palette={env.palette}
              label={c.show.openLabel}
              variant="outline"
              onPress={env.interactive ? () => open(env, c.opens!) : undefined}
              onLongPress={env.onLongPress}
              style={styles.flexButton}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

/**
 * A button that opens a page, a system entry, a quick action (tool:<id>) or an app. Row and tile
 * are cards with an icon (in the bottom zone a pill); the other shapes are plain buttons. An app's
 * label and icon default to the app's own (D-485).
 */
function OpenButton({ c, env }: { c: ComponentOf<'button'>; env: RenderEnv }) {
  const shape = buttonShape(c);
  const appId = c.opens !== undefined ? appTargetId(c.opens) : null;
  const app = appId !== null ? env.config.nav.apps?.find((a) => a.id === appId) : undefined;
  const label = c.show?.label ?? app?.name ?? '';
  const icon = c.show?.icon ?? app?.icon ?? (appId !== null ? 'apps' : undefined);
  const onPress = env.interactive && c.opens ? () => open(env, c.opens!) : undefined;
  if (shape === 'row' || shape === 'tile') {
    if (env.inBottomZone)
      return (
        <BottomPill
          env={env}
          icon={icon ?? 'apps'}
          title={label}
          onPress={() => open(env, c.opens!)}
        />
      );
    return (
      <Tile
        env={env}
        style={c.style}
        icon={icon}
        title={label}
        subtitle={c.show?.subtitle}
        titleColor={c.show?.accent ? env.palette.primaryText : undefined}
        onPress={() => open(env, c.opens!)}
        look={shape}
      />
    );
  }
  return (
    <Button
      palette={env.palette}
      label={label}
      variant={shape === 'outline' || shape === 'text' || shape === 'icon' ? shape : 'filled'}
      icon={icon}
      onPress={onPress}
      onLongPress={env.onLongPress}
      style={c.style?.align === 'center' ? styles.centerSelf : undefined}
    />
  );
}

function UnknownComponentView({ env }: { env: RenderEnv }) {
  const palette = onSurface(env.palette);
  return (
    <Card palette={palette}>
      <Text style={[palette.font('body', 15), { color: palette.muted }]}>
        {t(env.locale, 'unknownComponent')}
      </Text>
    </Card>
  );
}

function Group({ component, env }: { component: ComponentOf<'group'>; env: RenderEnv }) {
  const { palette } = env;
  const children = component.children.filter((c) => !c.hidden);
  const { layout, title, fold } = component.show;
  // Collapsible (D-578): whether it starts collapsed or expanded is determined by the config, and subsequently toggled by tapping the title; state exists only while rendered and is not persisted (invariant 15).
  const [open, setOpen] = useState(fold !== 'closed');
  const item = (c: Component, column?: { index: number; of: number }) => (
    <Item
      key={c.id}
      component={c}
      env={
        layout === 'stack'
          ? env
          : { ...env, inCell: true, ...(column ? { cellColumn: column } : {}) }
      }
      style={layout === 'stack' ? undefined : styles.cell}
    />
  );
  let body: ReactNode;
  if (layout === 'stack') {
    body = <View style={{ gap: palette.gap }}>{children.map((c) => item(c))}</View>;
  } else if (layout === 'row') {
    body = (
      <View style={[styles.row, { gap: palette.gap - 4 }]}>{children.map((c) => item(c))}</View>
    );
  } else {
    const columns = component.show.columns ?? 2;
    const rows: Component[][] = [];
    for (let i = 0; i < children.length; i += columns) rows.push(children.slice(i, i + columns));
    body = (
      <View style={{ gap: palette.gap - 4 }}>
        {rows.map((row, r) => (
          <View
            key={r}
            style={[
              styles.row,
              {
                gap: palette.gap - 4,
                zIndex: row.some((c) => c.id === env.focus?.selectedId) ? 10 : 0,
              },
            ]}>
            {row.map((c, i) => item(c, { index: i, of: columns }))}
            {Array.from({ length: columns - row.length }, (_, i) => (
              <View key={`empty-${i}`} style={styles.cell} />
            ))}
          </View>
        ))}
      </View>
    );
  }
  const titleStyle = [
    palette.font('bodyBold', 12),
    {
      color: textColor(palette, component.style?.tone, palette.caption),
      letterSpacing: 0.5,
    },
    component.style?.align === 'center' && styles.textCenter,
  ];
  return (
    <View style={{ gap: 10 }}>
      {title && fold ? (
        <Pressable
          testID={`group-fold-${component.id}`}
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((v) => !v)}
          style={styles.foldHeader}>
          <Text style={titleStyle}>{title.toUpperCase()}</Text>
          <UiIcon
            name={open ? 'chevronUp' : 'chevronDown'}
            size={16}
            color={textColor(palette, component.style?.tone, palette.caption)}
          />
        </Pressable>
      ) : title ? (
        <Text style={titleStyle}>{title.toUpperCase()}</Text>
      ) : null}
      {fold && !open ? null : children.length === 0 && env.focus ? (
        <View style={{ height: 44 }} />
      ) : (
        body
      )}
    </View>
  );
}

/**
 * A component on the page. In editable pages, long-pressing opens its action panel (D-052); inner
 * tappable parts of components also respond to long-press via env.onLongPress, preventing tap
 * events from triggering on release.
 */
export function Item({
  component,
  env,
  style,
}: {
  component: Component;
  env: RenderEnv;
  style?: StyleProp<ViewStyle>;
}) {
  const showIf = isKnownComponent(component) ? component.showIf : undefined;
  const item = <ShownItem component={component} env={env} style={style} />;
  if (!showIf) return item;
  return showIf.filter?.length ? (
    <WhenMatching showIf={showIf} env={env}>
      {item}
    </WhenMatching>
  ) : (
    <WhenRecords showIf={showIf}>{item}</WhenRecords>
  );
}

/** Determine whether to render based on whether a table has records (D-424). Read-only; not rendered while loading, avoiding flashes. */
export function WhenRecords({ showIf, children }: { showIf: ShowIf; children: ReactNode }) {
  const records = useRecords(showIf.table);
  if (records === null) return null;
  return (showIf.has === 'some') === records.length > 0 ? children : null;
}

/**
 * Display condition with filters (D-579): counts only records matching the filters using
 * pre-calculated values (aggregations, lookups), sharing the data source with number blocks and
 * lists. Read-only; not rendered while calculating, avoiding flashes.
 */
function WhenMatching({
  showIf,
  env,
  children,
}: {
  showIf: ShowIf;
  env: RenderEnv;
  children: ReactNode;
}) {
  const table = env.config.data.tables.find((c) => c.id === showIf.table);
  const cal = calendarOf(env.config);
  const { view, records } = useComputedRecords(env.config.data.tables, table, cal);
  if (!view || records === null) return null;
  const matching = filterRecords(records, view, showIf.filter, new Date(), cal);
  return (showIf.has === 'some') === matching.length > 0 ? children : null;
}

function ShownItem({
  component,
  env,
  style,
}: {
  component: Component;
  env: RenderEnv;
  style?: StyleProp<ViewStyle> | undefined;
}) {
  // D-342: Substitute "$record" only during rendering; editing and long-press panels continue to use the original component from the config.
  const shown = env.recordId ? bindRecord(component, env.recordId) : component;
  if (env.focus) {
    return (
      <FocusItem component={component} env={env} style={style}>
        {(itemEnv) => <ComponentView component={shown} env={itemEnv} />}
      </FocusItem>
    );
  }
  const edit = env.interactive ? env.edit : undefined;
  if (!edit) {
    return (
      <View testID={`component-${component.id}`} style={style}>
        <ComponentView component={shown} env={env} />
      </View>
    );
  }
  const open = () => edit(component.id);
  return (
    <Pressable
      testID={`component-${component.id}`}
      style={style}
      accessible={false}
      onLongPress={open}
      // This layer is for long press only; tapping empty space on the card is equivalent to tapping empty space on the page, dismissing the keyboard (buttons inside the card respond first).
      onPress={() => Keyboard.dismiss()}
      delayLongPress={LONG_PRESS_MS}>
      <ComponentView component={shown} env={{ ...env, onLongPress: open }} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { paddingVertical: 8, gap: 6 },
  tileRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  flexText: { flex: 1, gap: 3 },
  calloutButtons: { flexDirection: 'row', gap: 10, marginTop: 14 },
  flexButton: { flex: 1 },
  textCenter: { textAlign: 'center' },
  foldHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  centerSelf: { alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  cell: { flex: 1 },
  noticeCard: { shadowOpacity: 0, elevation: 0 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
});
