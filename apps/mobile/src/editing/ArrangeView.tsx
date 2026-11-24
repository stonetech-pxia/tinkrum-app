import {
  dropOp,
  dropSlots,
  moveStepOp,
  type Component,
  type Op,
  type Page,
  type DropSlot,
} from '@morph/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type HostInstance,
  type ScrollViewInstance,
  type ScrollViewProps,
} from 'react-native';

import { t } from '../i18n';
import type { RenderEnv } from '../renderer/components';
import { ComponentView } from '../renderer/registry';
import { Pill } from '../renderer/ui';
import { edgeSpeed } from './edge-speed';

// Editing mode (D-052–D-054): each component comes with a drag handle and ↑ ↓ buttons; hidden
// components are also displayed, and tapping a component opens the action sheet. Dragging only
// moves it on the interface; upon release, it is translated into a `moveComponent` operation added
// to the editing draft, and upon "Done", the entire draft is synthesized into a single version.
// Automatically scrolls when dragged to the top or bottom edge of the page (D-059).

interface Line {
  slot: DropSlot;
  y: number;
}

interface Drag {
  id: string;
  slot: DropSlot | null;
}

const sameSlot = (a: DropSlot | null, b: DropSlot) =>
  a !== null && a.parentId === b.parentId && a.index === b.index;

function measure(view: HostInstance | undefined): Promise<{ y: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!view) return resolve(null);
    view.measureInWindow((_x, y, _w, height) => resolve({ y, height }));
  });
}

/** Editing row for a component: content (tap to open action sheet) + handle + ↑ ↓. */
function Row({
  component,
  env,
  dragging,
  translateY,
  lineBefore,
  lineAfter,
  onEdit,
  onStep,
  onDragStart,
  onDragMove,
  onDragEnd,
  register,
  page,
  children,
}: {
  component: Component;
  env: RenderEnv;
  dragging: boolean;
  translateY: Animated.Value;
  lineBefore: boolean;
  lineAfter: boolean;
  onEdit: (id: string) => void;
  onStep: (op: Op, id: string) => void;
  onDragStart: (id: string, pageY: number) => void;
  onDragMove: (dy: number, pageY: number) => void;
  onDragEnd: (commit: boolean) => void;
  register: (id: string, view: HostInstance | null) => void;
  page: Page;
  children?: ReactNode;
}) {
  const { palette, locale } = env;
  const id = component.id;
  // PanResponder is created only once. Drag callbacks depend only on ref and the configuration of this page; whenever the configuration changes (new version), the entire page is remounted.
  const [responder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (_e, g) => onDragStart(id, g.y0),
      onPanResponderMove: (_e, g) => onDragMove(g.dy, g.moveY),
      onPanResponderRelease: () => onDragEnd(true),
      onPanResponderTerminate: () => onDragEnd(false),
    }),
  );
  const up = moveStepOp(page, id, 'up');
  const down = moveStepOp(page, id, 'down');
  const arrow = (op: Op | null, glyph: string, name: string, label: string) => (
    <Pressable
      testID={`arrange-${name}-${id}`}
      accessibilityLabel={label}
      disabled={!op}
      hitSlop={4}
      onPress={() => op && onStep(op, id)}
      style={({ pressed }) => [
        styles.control,
        { backgroundColor: palette.primaryTint, opacity: !op ? 0.3 : pressed ? 0.6 : 1 },
      ]}>
      <Text style={[palette.font('bodyBold', 16), { color: palette.primaryText }]}>{glyph}</Text>
    </Pressable>
  );
  const line = (where: 'top' | 'bottom') => (
    <View
      pointerEvents="none"
      style={[
        styles.line,
        { backgroundColor: palette.primary },
        where === 'top' ? { top: -palette.gap / 2 - 2 } : { bottom: -palette.gap / 2 - 2 },
      ]}
    />
  );
  return (
    <Animated.View
      ref={(v: HostInstance | null) => register(id, v)}
      testID={`arrange-${id}`}
      style={[
        styles.row,
        {
          borderColor: dragging ? palette.primary : palette.border,
          borderRadius: palette.radius,
          backgroundColor: dragging ? palette.surface : 'transparent',
          gap: palette.gap - 4,
        },
        dragging && styles.dragging,
        dragging && { transform: [{ translateY }] },
      ]}>
      {lineBefore ? line('top') : null}
      <View style={styles.head}>
        <Pressable
          testID={`arrange-edit-${id}`}
          onPress={() => onEdit(id)}
          style={[styles.content, component.hidden && styles.hidden]}>
          <View pointerEvents="none">
            {component.look === 'group' ? (
              <Text style={[palette.font('bodyBold', 12), { color: palette.caption }]}>
                {(component.show.title ?? t(locale, 'groupLabel')).toUpperCase()}
              </Text>
            ) : (
              <ComponentView component={component} env={env} />
            )}
          </View>
        </Pressable>
        <View style={styles.controls}>
          {arrow(up, '↑', 'up', t(locale, 'moveUp'))}
          <View
            {...responder.panHandlers}
            testID={`arrange-drag-${id}`}
            accessibilityLabel={t(locale, 'arrange')}
            style={[styles.control, { backgroundColor: palette.primary }]}>
            <Text style={[palette.font('bodyBold', 16), { color: palette.onPrimary }]}>≡</Text>
          </View>
          {arrow(down, '↓', 'down', t(locale, 'moveDown'))}
        </View>
      </View>
      {component.hidden ? (
        <Text style={[palette.font('bodyBold', 12), { color: palette.caption }]}>
          {t(locale, 'hiddenTag')}
        </Text>
      ) : null}
      {children}
      {lineAfter ? line('bottom') : null}
    </Animated.View>
  );
}

export function ArrangeView({
  page,
  env,
  bottomInset = 0,
  scroll,
  onEdit,
  onMove,
  onDone,
  onCancel,
}: {
  page: Page;
  env: RenderEnv;
  bottomInset?: number;
  scroll?: ScrollViewProps;
  onEdit: (componentId: string) => void;
  onMove: (op: Op) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { palette, locale } = env;
  // Components within editing rows are for display only and do not respond to taps.
  const viewEnv: RenderEnv = { ...env, pageId: page.id, interactive: false };
  const views = useRef(new Map<string, HostInstance>());
  const lines = useRef<Line[]>([]);
  const [translateY] = useState(() => new Animated.Value(0));
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  // When the editing draft changes, the page is not remounted; drag callbacks must use the latest page.
  const latest = useRef({ page, onMove });
  useEffect(() => {
    latest.current = { page, onMove };
  });
  // Auto-scroll: visible area, content height, current scroll position, and scroll positions at drag start and measurement.
  const scrollRef = useRef<ScrollViewInstance>(null);
  const viewport = useRef<HostInstance>(null);
  const bounds = useRef({ top: 0, bottom: 0, content: 0, height: 0 });
  const scrollY = useRef(scroll?.contentOffset?.y ?? 0);
  const scrolledAt = useRef({ grant: 0, lines: 0 });
  const finger = useRef({ dy: 0, pageY: 0 });
  const frame = useRef<number | null>(null);

  const register = (id: string, view: HostInstance | null) => {
    if (view) views.current.set(id, view);
    else views.current.delete(id);
  };

  function update(next: Drag | null) {
    dragRef.current = next;
    setDrag(next);
  }

  async function startDrag(id: string, pageY: number) {
    const { page } = latest.current;
    translateY.setValue(0);
    lines.current = [];
    finger.current = { dy: 0, pageY };
    scrolledAt.current.grant = scrollY.current;
    update({ id, slot: null });
    const area = await measure(viewport.current ?? undefined);
    if (area) {
      bounds.current.top = area.y;
      bounds.current.bottom = area.y + area.height;
    }
    // Record the screen height of each drop target location; subsequently, translate them by the page scroll amount.
    const boxes = new Map<string, { y: number; height: number } | null>();
    await Promise.all(
      [...views.current].map(async ([key, view]) => boxes.set(key, await measure(view))),
    );
    scrolledAt.current.lines = scrollY.current;
    const edge = (list: Component[], i: number, fallbackId: string): number | null => {
      const before = list[i] && boxes.get(list[i]!.id);
      if (before) return before.y;
      const last = list.at(-1);
      const after = last && boxes.get(last.id);
      if (after) return after.y + after.height;
      const parent = boxes.get(fallbackId);
      return parent ? parent.y + parent.height / 2 : null;
    };
    const result: Line[] = [];
    for (const slot of dropSlots(page, id)) {
      const group =
        slot.parentId === undefined
          ? null
          : page.blocks.find((c) => c.id === slot.parentId && c.look === 'group');
      const list = group && group.look === 'group' ? group.children : page.blocks;
      const y = edge(list, slot.index, slot.parentId ?? id);
      if (y !== null) result.push({ slot, y });
    }
    if (dragRef.current?.id === id) lines.current = result;
  }

  /** Update the position of the dragged component and the insertion position based on finger position and page scroll distance. */
  function follow() {
    const current = dragRef.current;
    if (!current) return;
    const { dy, pageY } = finger.current;
    translateY.setValue(dy + scrollY.current - scrolledAt.current.grant);
    const shift = scrollY.current - scrolledAt.current.lines;
    let best: Line | null = null;
    for (const line of lines.current) {
      if (!best || Math.abs(line.y - shift - pageY) < Math.abs(best.y - shift - pageY)) best = line;
    }
    if (best && !sameSlot(current.slot, best.slot)) update({ ...current, slot: best.slot });
  }

  /** Scroll once per frame when the finger stays in the edge region; stops when leaving the edge, reaching the scroll limit, or releasing the finger. */
  function autoScroll() {
    frame.current = null;
    if (!dragRef.current) return;
    const { top, bottom, content, height } = bounds.current;
    const speed = bottom > top ? edgeSpeed(finger.current.pageY, top, bottom) : 0;
    const next = Math.max(0, Math.min(content - height, scrollY.current + speed));
    if (next === scrollY.current) return;
    scrollY.current = next;
    scrollRef.current?.scrollTo({ y: next, animated: false });
    follow();
    frame.current = requestAnimationFrame(autoScroll);
  }

  function moveDrag(dy: number, pageY: number) {
    finger.current = { dy, pageY };
    follow();
    if (frame.current === null) autoScroll();
  }

  function endDrag(commit: boolean) {
    const current = dragRef.current;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    update(null);
    translateY.setValue(0);
    if (!commit || !current?.slot) return;
    const op = dropOp(latest.current.page, current.id, current.slot);
    if (op) latest.current.onMove(op);
  }

  const rows = (list: Component[], parentId?: string) =>
    list.map((c, i) => (
      <Row
        key={c.id}
        page={page}
        component={c}
        env={viewEnv}
        dragging={drag?.id === c.id}
        translateY={translateY}
        lineBefore={drag !== null && sameSlot(drag.slot, { parentId, index: i })}
        lineAfter={
          drag !== null && i === list.length - 1 && sameSlot(drag.slot, { parentId, index: i + 1 })
        }
        onEdit={onEdit}
        onStep={onMove}
        onDragStart={(id, y) => void startDrag(id, y)}
        onDragMove={moveDrag}
        onDragEnd={endDrag}
        register={register}>
        {c.look === 'group' ? (
          <View style={[styles.children, { gap: palette.gap }]}>
            {c.children.length === 0 ? (
              <View
                style={[
                  styles.empty,
                  { borderColor: palette.border, borderRadius: palette.controlRadius },
                  drag !== null &&
                    sameSlot(drag.slot, { parentId: c.id, index: 0 }) && {
                      borderColor: palette.primary,
                    },
                ]}
              />
            ) : (
              rows(c.children, c.id)
            )}
          </View>
        ) : null}
      </Row>
    ));

  return (
    <View style={styles.root}>
      <View
        testID="arrange-bar"
        style={[styles.bar, { backgroundColor: palette.surface, borderColor: palette.border }]}>
        <View style={styles.barText}>
          <Text style={[palette.font('title', 16), { color: palette.text }]}>
            {t(locale, 'editPage')}
          </Text>
          <Text style={[palette.font('body', 13), { color: palette.muted }]}>
            {t(locale, 'editHint')}
          </Text>
        </View>
        <View style={styles.barActions}>
          <Pill
            palette={palette}
            testID="arrange-cancel"
            label={t(locale, 'cancel')}
            onPress={onCancel}
          />
          <Pill
            palette={palette}
            testID="arrange-done"
            label={t(locale, 'done')}
            onPress={onDone}
          />
        </View>
      </View>
      <View ref={viewport} style={styles.root}>
        <ScrollView
          {...scroll}
          ref={scrollRef}
          scrollEnabled={drag === null}
          onScroll={(e) => {
            if (!dragRef.current) scrollY.current = e.nativeEvent.contentOffset.y;
            scroll?.onScroll?.(e);
          }}
          onLayout={(e) => void (bounds.current.height = e.nativeEvent.layout.height)}
          onContentSizeChange={(_w, h) => void (bounds.current.content = h)}
          style={{ backgroundColor: palette.background }}
          contentContainerStyle={{
            padding: palette.pad,
            gap: palette.gap,
            paddingBottom: 24 + bottomInset,
          }}>
          {rows(page.blocks)}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  barText: { flex: 1, gap: 2 },
  barActions: { gap: 8 },
  row: { borderWidth: 1.5, borderStyle: 'dashed', padding: 10 },
  dragging: {
    borderStyle: 'solid',
    shadowColor: '#000000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  content: { flex: 1 },
  hidden: { opacity: 0.4 },
  controls: { gap: 6, alignItems: 'center' },
  control: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  children: { paddingLeft: 4 },
  empty: { height: 44, borderWidth: 1.5, borderStyle: 'dashed' },
  line: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2 },
});
