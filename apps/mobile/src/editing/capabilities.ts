import {
  COMPONENTS,
  entryEditableText,
  entryKind,
  type ComponentEdit,
  type KnownComponent,
  type ComponentType,
  type EditableText,
  type StyleKey,
} from '@morph/core';

// Direct editing (D-052): what each component type can modify in the long-press menu. Written in core component definitions (`components/<type>.ts` edit property).

export type TextField = EditableText;
export type { StyleKey };

export const CAPABILITIES = Object.fromEntries(COMPONENTS.map((d) => [d.look, d.edit])) as Record<
  ComponentType,
  ComponentEdit
>;

/**
 * What this block can modify. Entry points (v34 merged quick entry points, "Add Tool", tool
 * cards, file slots) are classified by `opens`: tool package entry points have no text, and only
 * file slots can select files (`entryEditableText`, `entryKind`).
 */
export function capabilitiesOf(c: KnownComponent): ComponentEdit {
  const edit = CAPABILITIES[c.look];
  if (c.look !== 'entry') return edit;
  const { asset: _asset, ...rest } = edit;
  return {
    ...rest,
    text: entryEditableText(c) as EditableText[],
    ...(entryKind(c) === 'file' ? { asset: 'file' as const } : {}),
  };
}
