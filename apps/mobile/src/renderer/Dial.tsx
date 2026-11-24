import {
  findWorkflowTarget,
  isOpenUse,
  isRecordToolUse,
  isToolRefUse,
  pageTarget,
  quickActionsOf,
  recordsValue,
  type BlockOf,
  type IconValue,
  type ToolUse,
  type Workflow,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useRecordActionRunner } from '../data/record-actions';
import { t } from '../i18n';
import { useHandedRun } from '../run/useHandedRun';
import type { RenderEnv } from './components';
import type { BrowseSelection } from './data';
import { Icon, UiIcon } from './Icon';
import { onSurface } from './theme';

// Separate floating buttons (decided by founder 2026-11-04): the left primary button executes on
// tap, the right arrow expands the rest, and tapping outside collapses them. Expanding and
// collapsing are purely page display states and write nothing (invariant 15); each item runs only
// when tapped by the user (invariants 9, 10, 16).

interface DialItem {
  use: ToolUse;
  label: string;
  icon: IconValue | undefined;
  workflow?: Workflow;
}

/** Currently runnable items. Disappeared quick actions are not shown; for those providing list records, they are hidden when the list has no records (D-428). */
function dialItems(
  block: BlockOf<'dial'>,
  env: RenderEnv,
  selection: BrowseSelection | undefined,
): DialItem[] {
  const { config, locale } = env;
  const quickActions = quickActionsOf(config);
  return block.tools.flatMap((use): DialItem[] => {
    if (isToolRefUse(use)) {
      const workflow = findWorkflowTarget(quickActions, use.tool, locale);
      if (!workflow) return [];
      if (use.as === 'list' && !selection?.found.length) return [];
      return [{ use, workflow, label: use.label ?? workflow.name, icon: workflow.icon }];
    }
    if (isOpenUse(use)) {
      const page = config.containers.pages.find((p) => p.id === use.opens);
      return page ? [{ use, label: use.label ?? page.title, icon: page.icon }] : [];
    }
    return isRecordToolUse(use) ? [{ use, label: use.label ?? '', icon: 'plus' }] : [];
  });
}

export interface DialSlots {
  items: DialItem[];
  open: boolean;
  toggle: () => void;
  press: (item: DialItem) => void;
}

/**
 * Persistently mounted on the page (cannot be removed when the share panel still uses files,
 * useHandedRun). Buttons are rendered in the bottom fixed area (DialButton), and the expanded
 * layer covers the entire page (overlay, with the page placed at the very back).
 */
export function DialHost({
  block,
  env,
  selection,
  bottom,
  children,
}: {
  block: BlockOf<'dial'>;
  env: RenderEnv;
  selection: BrowseSelection | undefined;
  /** Height of the bottom fixed area: expanded items are arranged above it. */
  bottom: number;
  children: (slots: DialSlots, overlay: ReactNode) => ReactNode;
}) {
  const { palette, locale } = env;
  const card = onSurface(palette);
  const router = useRouter();
  const runner = useRecordActionRunner();
  const { run, elements } = useHandedRun(palette);
  const [open, setOpen] = useState(false);
  const items = dialItems(block, env, selection);
  const press = (item: DialItem) => {
    setOpen(false);
    if (!env.interactive) return;
    if (env.locked) return env.locked();
    const { use, workflow } = item;
    if (isToolRefUse(use) && workflow) {
      if (use.as === 'list' && selection?.collection)
        void run(workflow, recordsValue(selection.collection, [...selection.found]));
      else router.push({ pathname: '/run/[workflowId]', params: { workflowId: workflow.id } });
    } else if (isOpenUse(use)) env.navigate(pageTarget(use.opens));
    else if (isRecordToolUse(use)) void runner.runButton(use, item.label, env.recordId);
  };
  const toggle = () => {
    if (!env.interactive) return;
    if (env.locked) return env.locked();
    setOpen((now) => !now);
  };
  const overlay = (
    <>
      {open ? (
        <Pressable
          testID="dial-backdrop"
          accessibilityRole="button"
          accessibilityLabel={t(locale, 'dialClose')}
          onPress={() => setOpen(false)}
          style={[StyleSheet.absoluteFill, styles.dim, { backgroundColor: palette.scrimStrong }]}>
          <View style={[styles.items, { bottom: bottom + 8, right: palette.pad }]}>
            {items.slice(1).map((item, i) => (
              <Pressable
                key={i}
                testID={`dial-item-${i}`}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                onPress={() => press(item)}
                style={styles.item}>
                <View
                  style={[
                    styles.itemLabel,
                    { backgroundColor: card.surface, borderRadius: card.controlRadius },
                  ]}>
                  <Text
                    numberOfLines={1}
                    style={[palette.font('bodyBold', 14), { color: card.text }]}>
                    {item.label}
                  </Text>
                  {/* Clearly specify how many entries are passed (invariant 17): all entries after filtering and searching, without capping at a single page. */}
                  {item.use.as === 'list' && selection ? (
                    <Text
                      testID="dial-item-count"
                      numberOfLines={1}
                      style={[palette.font('body', 12), { color: card.caption }]}>
                      {t(locale, selection.narrowed ? 'listToolFound' : 'listToolAll', {
                        n: selection.found.length,
                      })}
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.round, { backgroundColor: palette.primary }]}>
                  {item.icon ? <Icon name={item.icon} size={22} color={palette.onPrimary} /> : null}
                </View>
              </Pressable>
            ))}
          </View>
        </Pressable>
      ) : null}
      {elements}
    </>
  );
  return <>{children({ items, open, toggle, press }, overlay)}</>;
}

/** Buttons in the bottom fixed area. When slots are absent (edit page, preview), renders only appearance with no tap response. */
export function DialButton({ block, env }: { block: BlockOf<'dial'>; env: RenderEnv }) {
  const { palette, locale } = env;
  const slots = env.dial;
  const items = slots?.items ?? dialItems(block, env, undefined);
  const main = items[0];
  if (!main) return null;
  const color = palette.onPrimary;
  return (
    <View testID="dial-split" style={[styles.split, { backgroundColor: palette.primary }]}>
      <Pressable
        testID="dial-main"
        accessibilityRole="button"
        accessibilityLabel={main.label}
        onPress={slots ? () => slots.press(main) : undefined}
        onLongPress={env.onLongPress}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}>
        {main.icon ? <Icon name={main.icon} size={20} color={color} /> : null}
        <Text numberOfLines={1} style={[palette.font('bodyBold', 15), { color }]}>
          {main.label}
        </Text>
      </Pressable>
      {items.length > 1 ? (
        <Pressable
          testID="dial-toggle"
          accessibilityRole="button"
          accessibilityLabel={t(locale, slots?.open ? 'dialClose' : 'dialMore')}
          accessibilityState={{ expanded: slots?.open === true }}
          onPress={slots?.toggle}
          onLongPress={env.onLongPress}
          style={({ pressed }) => [
            styles.arrow,
            { borderColor: color },
            pressed && styles.pressed,
          ]}>
          <UiIcon name={slots?.open ? 'chevronDown' : 'chevronUp'} size={18} color={color} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Entry in the bottom fixed area (e.g., "Expenses"): same height as the floating button, also a
 * pill, with the same primary color (D-437). Previously, entries were a white-background row
 * while floating buttons were red pills, resulting in mismatched heights and appearances when
 * placed side by side.
 */
export function BottomPill({
  env,
  icon,
  title,
  onPress,
}: {
  env: RenderEnv;
  icon: IconValue;
  title: string;
  onPress: () => void;
}) {
  const { palette } = env;
  return (
    <Pressable
      testID="bottom-pill"
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={!env.interactive}
      onPress={env.locked ?? onPress}
      onLongPress={env.onLongPress}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: palette.primary },
        pressed && styles.pressed,
      ]}>
      <Icon name={icon} size={20} color={palette.onPrimary} />
      <Text numberOfLines={1} style={[palette.font('bodyBold', 15), { color: palette.onPrimary }]}>
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 18,
    borderRadius: 999,
    minHeight: 52,
  },
  dim: { zIndex: 20 },
  items: { position: 'absolute', gap: 12, alignItems: 'flex-end' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  itemLabel: { paddingHorizontal: 12, paddingVertical: 8, maxWidth: 240 },
  round: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  split: { flexDirection: 'row', alignItems: 'stretch', borderRadius: 999, minHeight: 52 },
  main: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 18,
    paddingRight: 14,
    maxWidth: 180,
  },
  arrow: {
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.7 },
});
