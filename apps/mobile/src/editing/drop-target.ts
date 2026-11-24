import { dropSlots, type Component, type DropSlot, type Page } from '@morph/core';

export interface ItemBox {
  x: number;
  y: number;
  width: number;
  height: number;
  inCell?: boolean;
}
export interface DropTarget {
  slot: DropSlot;
  line: ItemBox;
}

/** Find drop targets based on the component's actual rectangle: grids use left/right halves, vertical lists use top/bottom halves; hidden items occupy no drop target. */
export function findDropTarget(
  page: Page,
  id: string,
  boxes: ReadonlyMap<string, ItemBox>,
  point: { x: number; y: number },
): DropTarget | null {
  const allowed = dropSlots(page, id);
  let best: { target: DropTarget; distance: number } | null = null;
  const consider = (slot: DropSlot, line: ItemBox, box: ItemBox, depth: number) => {
    if (!allowed.some((s) => s.parentId === slot.parentId && s.index === slot.index)) return;
    const dx = Math.max(box.x - point.x, 0, point.x - box.x - box.width);
    const dy = Math.max(box.y - point.y, 0, point.y - box.y - box.height);
    // Prefer child items over overlapping groups and child items.
    const distance = dx * dx + dy * dy - depth * 0.01;
    if (!best || distance < best.distance) best = { target: { slot, line }, distance };
  };
  const visit = (list: Component[], parentId?: string) => {
    list.forEach((c, index) => {
      if (c.hidden) return;
      const box = boxes.get(c.id);
      if (!box || box.width <= 0 || box.height <= 0) return;
      const horizontal = box.inCell === true;
      const after = horizontal
        ? point.x >= box.x + box.width / 2
        : point.y >= box.y + box.height / 2;
      const slot = { ...(parentId ? { parentId } : {}), index: index + (after ? 1 : 0) };
      const line = horizontal
        ? { x: box.x + (after ? box.width : 0) - 1.5, y: box.y, width: 3, height: box.height }
        : { x: box.x, y: box.y + (after ? box.height : 0) - 1.5, width: box.width, height: 3 };
      consider(slot, line, box, parentId ? 1 : 0);
      if (c.look === 'group') {
        if (!c.children.some((child) => !child.hidden)) {
          // Items can still be dropped into empty groups; preserve drop targets before and after the group at the top and bottom edges.
          const inset = Math.min(12, box.height / 4);
          const inner = { ...box, y: box.y + inset, height: box.height - inset * 2 };
          consider(
            { parentId: c.id, index: 0 },
            { ...inner, y: inner.y + inner.height / 2, height: 3 },
            inner,
            1,
          );
        }
        visit(c.children, c.id);
      }
    });
  };
  visit(page.blocks);
  return (best as { target: DropTarget } | null)?.target ?? null;
}
