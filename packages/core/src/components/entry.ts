import { z } from 'zod';

import { localize } from '../localization';
import { t } from '../messages';
import {
  boundedText,
  IconValueSchema,
  isFileTarget,
  openTargetSchema,
  appTargetId,
  packageTargetId,
} from '../schema-base';
import { ALL_STYLES, EntryLookSchema, type LookDefinitionOf, defineLook } from './define';

const shape = {
  show: z
    .strictObject({
      /** Original shortcut ≤ 40, catalogLink ≤ 60: take the maximum; omitted for tool pack entry points (fetched dynamically from the tool pack, localized). */
      title: boundedText(1, 60).optional(),
      subtitle: boundedText(1, 80).optional(),
      icon: IconValueSchema.optional(),
      /** Prompt displayed when no file has been selected in a file slot. */
      hint: boundedText(1, 80).optional(),
      /** Defaults to row when omitted (D-230). */
      shape: EntryLookSchema.optional(),
      /** Render title in accent color (original catalogLink "Add tool" style, M7). */
      accent: z.literal(true).optional(),
    })
    .optional(),
  opens: openTargetSchema(
    'opens must be a page, a system entry, tool:<id>, package:<id>, app:<id> or {file}',
  ),
};

type EntryKind = 'shortcut' | 'link' | 'package' | 'app' | 'file';

/** Type of entry point (differentiates description text and editable items): file slots, tool pack entry points, accent entry points like "Add tool", and regular shortcut entry points. */
export function entryKind(c: {
  show?: { accent?: true | undefined } | undefined;
  opens: unknown;
}): EntryKind {
  const opens = c.opens as Parameters<typeof isFileTarget>[0];
  if (isFileTarget(opens)) return 'file';
  if (packageTargetId(opens) !== null) return 'package';
  if (appTargetId(opens) !== null) return 'app';
  return c.show?.accent ? 'link' : 'shortcut';
}

/**
 * Entry card (v34 merged shortcut, catalogLink, toolCard, fileSlot): icon + title, opens on tap.
 * When opens is package:<id>, title, icon, and description are fetched dynamically from the tool
 * pack; when {file}, it represents a file slot: the AI only writes the title and hint, the user
 * taps the empty slot to select a file (a photo or any file from "Files", copied into a user file
 * while the original remains untouched), and subsequent taps open it using the system previewer.
 */
export const entryComponent: LookDefinitionOf<'entry', typeof shape> = defineLook({
  look: 'entry',
  shape,
  kind: 'container',
  reads: 'none',
  writes: false,
  refs: { opens: { to: 'target' } },
  check: (c) => {
    const kind = entryKind(c);
    const problems: string[] = [];
    if (kind === 'package' && (c.show?.title || c.show?.icon || c.show?.subtitle))
      problems.push('an entry that opens package:<id> takes its title and icon from the tool');
    if (kind !== 'package' && kind !== 'app' && !c.show?.title)
      problems.push('an entry needs show.title');
    if (kind === 'shortcut' && !c.show?.icon) problems.push('an entry needs show.icon');
    if (kind !== 'file' && c.show?.hint) problems.push('show.hint only applies to a file slot');
    if (kind !== 'link' && (c.show?.title?.length ?? 0) > 40)
      problems.push('show.title can be at most 40 characters');
    return problems;
  },
  describe: (c, config, ctx) => {
    // App opening entry point: name and icon default to app values if omitted.
    const appId = appTargetId(c.opens as Parameters<typeof appTargetId>[0]);
    const title =
      c.show?.title ??
      (appId !== null ? (config.nav.apps?.find((a) => a.id === appId)?.name ?? appId) : '');
    switch (entryKind(c)) {
      case 'file':
        return t(ctx.locale, 'describeFileSlot', { v0: title });
      case 'link':
        return t(ctx.locale, 'describe_link_941e3', { v0: title });
      case 'package': {
        const id = packageTargetId(c.opens)!;
        const name = localize(ctx.registry.tools.get(id)?.name, ctx.locale) ?? id;
        return t(ctx.locale, 'describe_tool_card_80198', { v0: name });
      }
      default:
        return t(ctx.locale, 'describe_shortcut_b2616', { v0: title });
    }
  },
  edit: {
    text: [
      { prop: 'title', max: 60 },
      { prop: 'subtitle', max: 80, optional: true },
      { prop: 'hint', max: 80, optional: true },
    ],
    style: ALL_STYLES,
    asset: 'file',
    backdrop: true,
  },
  ai: {
    doc: 'show? {title, subtitle?, icon, shape?: "row"|"tile", hint?}, opens: a card with an icon that opens a page, a system entry, "tool:<id>" (like button) or "package:<id>" (an added tool\'s page; then leave show.title and icon out, they come from the tool) or "app:<id>" (opens one of the user\'s apps; show.title and icon may be left out, they come from the app). row (default) = a settings-style row with a light icon background and an arrow on the right; tile = a big card with a solid icon block, no arrow. In a grid or row group, or centered, it is always stacked. A slot for one file the user wants at hand (a contract, a ticket, a manual, a scan) is an entry with opens {file: null}: you set only the title, hint and shape; never choose a file — the user taps the empty slot to pick a photo or a file, Tinkrum keeps a copy, and later a tap opens it in the system viewer. You never see which file it is.',
  },
  example: { show: { title: 'Tools', icon: 'apps' }, opens: 'tools' },
});

/** Text editable for this entry point in long-press edit (absent for tool pack entry points; file slots have an extra hint). */
export function entryEditableText(c: {
  show?: { accent?: true | undefined } | undefined;
  opens: unknown;
}) {
  const kind = entryKind(c);
  if (kind === 'package') return [];
  const max = kind === 'link' ? 60 : 40;
  return [
    { prop: 'title', max },
    ...(kind === 'file'
      ? [{ prop: 'hint', max: 80, optional: true }]
      : kind === 'shortcut' || kind === 'app'
        ? [{ prop: 'subtitle', max: 80, optional: true }]
        : []),
  ];
}
