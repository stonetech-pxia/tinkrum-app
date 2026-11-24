import { dropOp, type Op, type Page } from '@morph/core';
import { useEffect, useRef, useState } from 'react';
import { type HostInstance, type ScrollViewInstance, type ScrollViewProps } from 'react-native';
import { useNativeGesture } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';

import { edgeSpeed } from './edge-speed';
import { findDropTarget, type DropTarget, type ItemBox } from './drop-target';

function measure(view: HostInstance | null | undefined): Promise<ItemBox | null> {
  return new Promise((resolve) => {
    if (!view) return resolve(null);
    view.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });
}

/**
 * When the component's own internal long-press functionality is active (board dragging cards
 * D-314, long-pressing large circular block to open records D-311), the outer long-press
 * selection does not take effect, prioritizing internal functionality: two long-press gestures
 * cannot block each other on iOS (RNGH's block does not intercept the outer one), so it is
 * blocked here on the JS side.
 */
let innerGesture = false;
export function setInnerGesture(active: boolean) {
  innerGesture = active;
}

interface Session {
  id: string;
  x: number;
  y: number;
  startX: number;
  startY: number;
  scrollAtStart: number;
  scrollAtMeasure: number;
  boxes: Map<string, ItemBox>;
  target: DropTarget | null;
  moved: boolean;
  ready: Promise<void>;
  released: boolean;
}

/** Measures the outer box without transform; following-finger displacement on the UI thread does not pollute drop target coordinates. */
export function useSingleDrag(
  page: Page,
  onSelect: (id: string) => void,
  onMove: (op: Op) => void,
) {
  const latest = useRef({ page, onSelect, onMove });
  useEffect(() => {
    latest.current = { page, onSelect, onMove };
  });
  const views = useRef(new Map<string, { view: HostInstance; inCell: boolean }>());
  const scrollRef = useRef<ScrollViewInstance>(null);
  const viewportRef = useRef<HostInstance>(null);
  const metrics = useRef({ y: 0, height: 0, content: 0, top: 0, left: 0 });
  const session = useRef<Session | null>(null);
  const frame = useRef<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const scrollShift = useSharedValue(0);
  const scrollGesture = useNativeGesture();

  function stopFrame() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }
  useEffect(
    () => () => {
      stopFrame();
      session.current = null;
    },
    [],
  );

  function follow() {
    const current = session.current;
    if (!current) return;
    scrollShift.value = metrics.current.y - current.scrollAtStart;
    const shift = metrics.current.y - current.scrollAtMeasure;
    current.target = findDropTarget(latest.current.page, current.id, current.boxes, {
      x: current.x,
      y: current.y + shift,
    });
    const found = current.target;
    setTarget(
      found
        ? {
            ...found,
            line: {
              ...found.line,
              x: found.line.x - metrics.current.left,
              y: found.line.y - shift - metrics.current.top,
            },
          }
        : null,
    );
  }
  function autoScroll() {
    frame.current = null;
    const current = session.current;
    if (!current) return;
    const m = metrics.current;
    const speed = current.moved && m.height > 0 ? edgeSpeed(current.y, m.top, m.top + m.height) : 0;
    // Scroll only when the finger is dragged to the edge. If the page itself becomes non-scrollable
    // (top and bottom bars collapse upon entering edit mode, D-613), it is not a drag and must not
    // be clamped back here and counted as a movement: otherwise, holding down without moving would
    // also place the component elsewhere.
    const next =
      speed === 0 ? m.y : Math.max(0, Math.min(Math.max(0, m.content - m.height), m.y + speed));
    if (next !== m.y) {
      m.y = next;
      scrollRef.current?.scrollTo({ y: next, animated: false });
      current.moved = true;
      follow();
    }
    // Continue checking even if temporarily non-scrollable; content dimensions may have just changed.
    frame.current = requestAnimationFrame(autoScroll);
  }
  function begin(id: string, x: number, y: number) {
    if (session.current || innerGesture) return;
    latest.current.onSelect(id);
    const current = {
      id,
      x,
      y,
      startX: x,
      startY: y,
      scrollAtStart: metrics.current.y,
      scrollAtMeasure: metrics.current.y,
      boxes: new Map<string, ItemBox>(),
      target: null as DropTarget | null,
      moved: false,
      released: false,
      ready: Promise.resolve(),
    };
    session.current = current;
    setDraggingId(id);
    scrollShift.value = 0;
    measureSession(current);
  }
  /** Measure the visible area and the window positions of each component; find drop targets and start auto-scrolling only after measurement finishes. */
  function measureSession(current: Session) {
    const boxes = new Map<string, ItemBox>();
    current.ready = Promise.all([
      measure(viewportRef.current),
      ...[...views.current].map(async ([key, entry]) => {
        const box = await measure(entry.view);
        if (box) boxes.set(key, { ...box, inCell: entry.inCell });
      }),
    ]).then(([area]) => {
      if (session.current !== current) return;
      current.boxes = boxes;
      if (area) {
        metrics.current.left = area.x;
        metrics.current.top = area.y;
        metrics.current.height = area.height;
      }
      current.scrollAtMeasure = metrics.current.y;
      follow();
      if (!current.released && frame.current === null)
        frame.current = requestAnimationFrame(autoScroll);
    });
  }
  function move(id: string, x: number, y: number) {
    const current = session.current;
    if (!current || current.id !== id) return;
    current.x = x;
    current.y = y;
    if (Math.hypot(x - current.startX, y - current.startY) > 4) current.moved = true;
    follow();
  }
  async function end(id: string, commit: boolean) {
    const current = session.current;
    if (!current || current.id !== id) return;
    current.released = true;
    stopFrame();
    // If release happens earlier than the `measureInWindow` callback, wait for the measurement
    // session to finish before determining the drop target. Cancel immediately cleans up; late
    // arrivals are discarded using session identity checks.
    if (commit) {
      await current.ready;
      if (session.current !== current) return;
      follow();
    }
    session.current = null;
    setDraggingId(null);
    setTarget(null);
    scrollShift.value = 0;
    if (!commit || !current.moved || !current.target) return;
    const op = dropOp(latest.current.page, id, current.target.slot);
    if (op) latest.current.onMove(op);
  }
  /**
   * Page layout changed while holding down (top and bottom bars collapse upon entering edit mode,
   * page height increases, D-613): native scroll position gets clamped to the new maximum, and
   * components also change positions. Keep up with the scroll position, re-measure, and calculate
   * drop targets based on current positions.
   */
  function layoutChanged() {
    const current = session.current;
    if (!current || current.released) return;
    const m = metrics.current;
    m.y = Math.min(m.y, Math.max(0, m.content - m.height));
    measureSession(current);
  }
  const scroll: ScrollViewProps = {
    scrollEnabled: draggingId === null,
    removeClippedSubviews: false,
    onScroll: (e) => {
      if (!session.current) metrics.current.y = e.nativeEvent.contentOffset.y;
    },
    onLayout: (e) => {
      metrics.current.height = e.nativeEvent.layout.height;
      layoutChanged();
    },
    onContentSizeChange: (_w, height) => {
      metrics.current.content = height;
      layoutChanged();
    },
  };
  return {
    attachScroll: (view: ScrollViewInstance | null) => {
      scrollRef.current = view;
    },
    attachViewport: (view: HostInstance | null) => {
      viewportRef.current = view;
    },
    scroll,
    draggingId,
    target,
    scrollShift,
    scrollGesture,
    /** Component position relative to scroll content (toolbar is rendered inside scroll content); immediately returns null if measurement is impossible. */
    measureInContent: (id: string, done: (box: ItemBox | null) => void) => {
      const view = views.current.get(id)?.view;
      // Fall back to the scroll view itself if the test double has no inner view reference.
      const inner = scrollRef.current?.getInnerViewRef() ?? scrollRef.current;
      if (!view || !inner) return done(null);
      view.measureLayout(
        inner,
        (x, y, width, height) => done({ x, y, width, height }),
        () => done(null),
      );
    },
    register: (id: string, view: HostInstance | null, inCell: boolean) => {
      if (view) views.current.set(id, { view, inCell });
      else views.current.delete(id);
    },
    begin: (id: string, x: number, y: number) => {
      void begin(id, x, y);
    },
    move,
    end: (id: string, commit: boolean) => {
      void end(id, commit);
    },
  };
}
export type SingleDrag = ReturnType<typeof useSingleDrag>;
