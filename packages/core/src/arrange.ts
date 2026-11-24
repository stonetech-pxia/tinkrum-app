import type { BlockChanges, Op } from './ops';
import {
  GROUP_MAX_CHILDREN,
  allComponents,
  childrenOf,
  isKnownComponent,
  parentOf,
  type Component,
  type Page,
} from './schema';

// Direct editing (D-052): "Move up" / "Move down" and drag-and-drop on pages are translated into
// moveContainer operations, going through validation, generating a new version, and supporting undo
// just like AI modifications. Groups support at most two levels (Q3): the inner level cannot
// contain further groups.

/** Drop slot: the index-th position in a list (either the page top level or inside a group), calculated based on the list before removal. */
export interface DropSlot {
  parentId?: string;
  index: number;
}

interface Location {
  parent: Component | null;
  list: Component[];
  index: number;
  component: Component;
}

function locate(page: Page, id: string): Location | null {
  const walk = (list: Component[], parent: Component | null): Location | null => {
    const index = list.findIndex((c) => c.id === id);
    if (index >= 0) return { parent, list, index, component: list[index]! };
    for (const c of list) {
      const found = walk(childrenOf(c), c);
      if (found) return found;
    }
    return null;
  };
  return walk(page.blocks, null);
}

const isGroup = (c: Component) => isKnownComponent(c) && c.look === 'group';

/** Whether this group can hold moving (without checking capacity): cannot be placed inside itself; groups can only be placed inside top-level groups, and they cannot contain groups themselves. */
function canHold(page: Page, group: Component, moving: Component): boolean {
  if (!isGroup(group) || group.id === moving.id) return false;
  if (allComponents({ ...page, blocks: childrenOf(moving) }).some((c) => c.id === group.id))
    return false;
  if (!isGroup(moving)) return true;
  return parentOf(page, group.id) === null && !childrenOf(moving).some(isGroup);
}

const hasRoom = (group: Component) => childrenOf(group).length < GROUP_MAX_CHILDREN;

function move(page: string, block: string, toIndex: number, parent?: string): Op {
  return parent === undefined
    ? { op: 'moveContainer', page, block, toIndex }
    : { op: 'moveContainer', page, block, toIndex, parent };
}

/**
 * Move up / down by one slot. When passing through groups, it first enters the group and then
 * exits from the other end, so blocks can be moved into and out of groups using only arrows
 * (groups passing through other groups are skipped directly and not placed inside). Returns null
 * if already at the very top or bottom.
 */
export function moveStepOp(page: Page, componentId: string, direction: 'up' | 'down'): Op | null {
  const at = locate(page, componentId);
  if (!at) return null;
  const up = direction === 'up';
  const atEdge = up ? at.index === 0 : at.index === at.list.length - 1;
  if (at.parent && atEdge) {
    const outer = locate(page, at.parent.id)!;
    return move(page.id, componentId, outer.index + (up ? 0 : 1), outer.parent?.id);
  }
  const neighbour = at.list[at.index + (up ? -1 : 1)];
  if (!neighbour) return null;
  if (!isGroup(at.component) && canHold(page, neighbour, at.component) && hasRoom(neighbour)) {
    return move(page.id, componentId, up ? childrenOf(neighbour).length : 0, neighbour.id);
  }
  return move(page.id, componentId, at.index + (up ? -1 : 1), at.parent?.id);
}

/** Available positions when dragging: every position at the page top level, and every position inside each group that can hold it and is not full. */
export function dropSlots(page: Page, componentId: string): DropSlot[] {
  const at = locate(page, componentId);
  if (!at) return [];
  const slots: DropSlot[] = [];
  for (let i = 0; i <= page.blocks.length; i++) slots.push({ index: i });
  for (const c of allComponents(page)) {
    if (!canHold(page, c, at.component) || (!hasRoom(c) && at.parent !== c)) continue;
    for (let i = 0; i <= childrenOf(c).length; i++) slots.push({ parentId: c.id, index: i });
  }
  return slots;
}

/** Place a block into a position; returns null if the position is unchanged or not allowed. */
export function dropOp(page: Page, componentId: string, slot: DropSlot): Op | null {
  const at = locate(page, componentId);
  if (!at) return null;
  if (
    !dropSlots(page, componentId).some(
      (s) => s.parentId === slot.parentId && s.index === slot.index,
    )
  )
    return null;
  const sameList = (at.parent?.id ?? undefined) === slot.parentId;
  if (!sameList) return move(page.id, componentId, slot.index, slot.parentId);
  // toIndex in moveContainer is the position after removal.
  const toIndex = slot.index > at.index ? slot.index - 1 : slot.index;
  if (toIndex === at.index) return null;
  return move(page.id, componentId, toIndex, slot.parentId);
}

/** Refers to the same block (updateContainer modifying a block, moveContainer). */
const sameBlock = (a: Op, b: Op) =>
  'block' in a &&
  'block' in b &&
  typeof a.block === 'string' &&
  a.block === b.block &&
  'page' in a &&
  'page' in b &&
  a.page === b.page;

/** Merge two block modifications into one: show and source are merged item by item, tools, opens, and hidden take the latter, and style is handled as below. Returns null if they cannot be merged. */
function mergeChanges(a: BlockChanges, b: BlockChanges): BlockChanges | null {
  const out: BlockChanges = { ...a, ...b };
  for (const key of ['show', 'source'] as const)
    if (a[key] && b[key]) out[key] = { ...a[key], ...b[key] };
  if (a.style && b.style) {
    // Image backgrounds (D-258) are merged item by item into existing ones: modifications from two sources are also merged item by item. Turning off and then turning back on cannot be merged: turning on does not carry the image from before it was turned off.
    const [x, y] = [a.style.backdrop, b.style.backdrop];
    if (x === null && y) return null;
    const backdrop = x && y ? { backdrop: { ...x, ...y } } : {};
    out.style = { ...a.style, ...b.style, ...backdrop };
  }
  return out;
}

/**
 * Before coalescing a series of operations into a new version when edit mode ends, first merge
 * adjacent operations of the same type (D-054): consecutive moves of the same block retain only
 * the final one (relative order of other blocks remains unchanged, yielding the same result), and
 * consecutive modifications of the same block are merged into one. The result is identical to
 * executing the original list in order.
 */
export function coalesceOps(ops: readonly Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    const last = out.at(-1);
    if (last && last.op === op.op && sameBlock(last, op)) {
      if (op.op === 'moveContainer') {
        out[out.length - 1] = op;
        continue;
      }
      if (op.op === 'updateContainer' && last.op === 'updateContainer') {
        const changes = mergeChanges(last.changes as BlockChanges, op.changes as BlockChanges);
        if (changes) {
          out[out.length - 1] = { ...op, changes };
          continue;
        }
      }
    }
    out.push(op);
  }
  return out;
}
