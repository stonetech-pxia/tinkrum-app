import {
  blockEdit,
  type ComponentEdit,
  type EditableText,
  type KnownComponent,
  type StyleKey,
} from '@morph/core';

// Direct editing (D-052): what each component type can modify in the long-press menu. Written in core component definitions (`components/<type>.ts` edit property).

export type TextField = EditableText;
export type { StyleKey };

/**
 * What this block can modify: its look's edit, narrowed by what the block does where that matters
 * (a button that opens a tool's page has no text of its own, only a file slot picks a file; the
 * look's editOf in core).
 */
export function capabilitiesOf(c: KnownComponent): ComponentEdit {
  return blockEdit(c);
}
