import { z } from 'zod';

import { localize } from '../localization';
import { t } from '../messages';
import { PICK_TOOLS, ToolUseSchema, type ToolUse } from '../record-ops-schema';
// Type-only import: importing values from '../schema' would cause a circular dependency (schema → components → button → schema).
import type { Locale, QuickAction, WorkspaceConfig } from '../schema';
import {
  boundedText,
  IconValueSchema,
  isFileTarget,
  openTargetSchema,
  appTargetId,
  packageTargetId,
  type OpenTarget,
} from '../schema-base';
import { findWorkflowTarget } from '../workflows/presets';
import {
  ALL_STYLES,
  type CheckProblem,
  type ComponentEdit,
  type EditableText,
  type LookDefinitionOf,
  defineLook,
} from './define';

/**
 * How a button is drawn. filled / outline / text = a button with a label; icon = only an icon;
 * row = a settings-style row (icon on a light block, label, arrow); tile = a card with a big icon
 * block; card = a quick action's steps and a Run button.
 */
export const BUTTON_SHAPES = ['filled', 'outline', 'text', 'icon', 'row', 'tile', 'card'] as const;
export type ButtonShape = (typeof BUTTON_SHAPES)[number];

const shape = {
  show: z
    .strictObject({
      /** Left out where Tinkrum supplies it: a quick action's name, an added tool's page, a file picker, an app's name. */
      label: boundedText(1, 60).optional(),
      /** Second line under the label (row and tile). */
      subtitle: boundedText(1, 80).optional(),
      icon: IconValueSchema.optional(),
      /** Shown in a file slot while no file is chosen. */
      hint: boundedText(1, 80).optional(),
      /** Omitted: chosen by what the button does (buttonShape). */
      shape: z.enum(BUTTON_SHAPES).optional(),
      /** Label in the accent colour (the former "Add tool" link, M7). */
      accent: z.literal(true).optional(),
    })
    .optional(),
  /** One tool: a one-tap record tool (D-300; asks first where it changes several entries), a quick action to run (D-236), or the kernel's file picker. Mutually exclusive with opens. */
  tools: z.array(ToolUseSchema).min(1).max(1).optional(),
  opens: openTargetSchema(
    'opens must be a page, a system entry, tool:<id>, package:<id>, app:<id> or {file}',
  ).optional(),
};

/**
 * What a button does, read from tools / opens (D-new-kernel-available-resources-3ffb5b-1 merged
 * the looks entry, action and picker into button):
 * - run: runs a quick action (tools [{tool: <quick action id>}], the former action look)
 * - pick: the kernel's file picker (tools [{tool: "$pick.…"}], the former picker look)
 * - record: a one-tap record tool
 * - file: a slot for one user file (opens {file}, D-257)
 * - package: an added tool's page (opens package:<id>; label and icon come from the tool)
 * - app: one of the user's apps (opens app:<id>; label and icon may come from the app)
 * - link: an accent-coloured link (the former catalog link)
 * - open: opens a page, a system entry or shows a quick action (tool:<id>)
 */
export type ButtonKind = 'run' | 'pick' | 'record' | 'file' | 'package' | 'app' | 'link' | 'open';

export function buttonKind(c: {
  show?: { accent?: true | undefined } | undefined;
  tools?: readonly ToolUse[] | undefined;
  opens?: unknown;
}): ButtonKind {
  const use = c.tools?.[0];
  if (use) {
    if ('do' in use) return 'record';
    if ('tool' in use) return (PICK_TOOLS as readonly string[]).includes(use.tool) ? 'pick' : 'run';
  }
  const opens = c.opens as OpenTarget | undefined;
  if (opens !== undefined) {
    if (isFileTarget(opens)) return 'file';
    if (packageTargetId(opens) !== null) return 'package';
    if (appTargetId(opens) !== null) return 'app';
  }
  return c.show?.accent ? 'link' : 'open';
}

/** Shapes each kind can take; the first is used when show.shape is left out (run: auto, D-230). */
const SHAPES: Record<ButtonKind, readonly ButtonShape[]> = {
  run: ['card', 'row', 'tile', 'icon'],
  pick: ['text', 'icon'],
  record: ['filled', 'outline', 'text', 'icon'],
  file: ['row', 'tile'],
  package: ['tile', 'row'],
  app: ['row', 'tile', 'filled', 'outline', 'text', 'icon'],
  link: ['row', 'tile', 'filled', 'outline', 'text', 'icon'],
  open: ['row', 'tile', 'filled', 'outline', 'text', 'icon'],
};

/** The shape it is drawn with; undefined for a quick action without shape (placed by position, D-230). */
export function buttonShape(c: {
  show?: { shape?: ButtonShape | undefined; accent?: true | undefined } | undefined;
  tools?: readonly ToolUse[] | undefined;
  opens?: unknown;
}): ButtonShape | undefined {
  if (c.show?.shape) return c.show.shape;
  const kind = buttonKind(c);
  return kind === 'run' ? undefined : SHAPES[kind][0];
}

/** Whether it is drawn as a card with an icon (row, tile), which has a subtitle, every style and a picture background. */
const isCardShape = (s: ButtonShape | undefined) => s === 'row' || s === 'tile';

/** What long-press edit offers on this button (D-052). */
export function buttonEdit(
  c: Parameters<typeof buttonKind>[0] & Parameters<typeof buttonShape>[0],
): ComponentEdit {
  const kind = buttonKind(c);
  const s = buttonShape(c);
  if (kind === 'run') return { text: [], style: [], backdrop: true };
  if (kind === 'pick') return { text: [], style: [] };
  if (kind === 'package') return { text: [], style: ALL_STYLES, backdrop: true };
  const label: EditableText = { prop: 'label', max: kind === 'link' ? 60 : 40 };
  if (!isCardShape(s)) return { text: [label], style: ['align'] };
  return {
    text: [
      label,
      kind === 'file'
        ? { prop: 'hint', max: 80, optional: true }
        : { prop: 'subtitle', max: 80, optional: true },
    ],
    style: ALL_STYLES,
    backdrop: true,
    ...(kind === 'file' ? { asset: 'file' as const } : {}),
  };
}

function quickActionName(config: WorkspaceConfig, id: string, locale: Locale): string {
  const wf = findWorkflowTarget(
    config.tools.filter((x): x is QuickAction => x.kind === 'quickAction'),
    id,
    locale,
  );
  return wf?.name ?? id;
}

export const buttonComponent: LookDefinitionOf<'button', typeof shape> = defineLook({
  look: 'button',
  shape,
  kind: 'container',
  layer: 'record',
  reads: 'none',
  writes: true,
  tools: {
    as: ['self'],
    do: ['create', 'setAll', 'createAll'],
    ref: ['quickAction', 'pick'],
    max: 1,
  },
  refs: { opens: { to: 'target' } },
  check: (c, ctx) => {
    const problems: CheckProblem[] = [];
    const where = `button ${c.id} on page ${ctx.page.id}`;
    if (c.tools && c.opens !== undefined)
      problems.push(`${where} either opens something or has a tool, not both`);
    const kind = buttonKind(c);
    const show = c.show ?? {};
    if (show.shape && !SHAPES[kind].includes(show.shape))
      problems.push(
        `${where}: shape "${show.shape}" doesn't fit what it does (allowed: ${SHAPES[kind].join(', ')})`,
      );
    const s = buttonShape(c);
    if (kind === 'run' || kind === 'pick' || kind === 'package') {
      if (show.label || show.icon || show.subtitle)
        problems.push(
          `${where}: its label and icon come from ${kind === 'run' ? 'the quick action' : kind === 'pick' ? 'Tinkrum' : 'the tool'}: leave show.label, show.icon and show.subtitle out${kind === 'run' ? ' (and add a button that runs a quick action only where the user asked for one: for a quick action you create, the app asks the user whether to put it on the home page, rule 20)' : ''}`,
        );
    } else if (kind !== 'app' && !show.label) problems.push(`${where} needs show.label`);
    if (s === 'icon' && kind !== 'run' && kind !== 'pick' && !show.icon && kind !== 'app')
      problems.push({
        code: 'schema',
        message: `icon button ${c.id} on page ${ctx.page.id} needs an icon`,
      });
    if (s === 'tile' && (kind === 'open' || kind === 'link') && !show.icon)
      problems.push(`${where}: shape "tile" needs show.icon`);
    if (kind !== 'file' && show.hint)
      problems.push(`${where}: show.hint only applies to a file slot`);
    if (show.subtitle && !isCardShape(s))
      problems.push(`${where}: show.subtitle only shows on shape "row" or "tile"`);
    if (show.accent && kind !== 'link' && kind !== 'open')
      problems.push(
        `${where}: show.accent only applies to a button that opens a page or a system entry`,
      );
    if (kind !== 'link' && (show.label?.length ?? 0) > 40)
      problems.push(`${where}: show.label can be at most 40 characters`);
    return problems;
  },
  describe: (c, config, ctx) => {
    const kind = buttonKind(c);
    const use = c.tools?.[0];
    switch (kind) {
      case 'run':
        return t(ctx.locale, 'describe_quick_action_1fb38', {
          v0: quickActionName(config, use && 'tool' in use ? use.tool : '', ctx.locale),
        });
      case 'pick':
        return use && 'tool' in use && use.tool !== '$pick.media'
          ? t(ctx.locale, 'describe_Open_files_3477c')
          : t(ctx.locale, 'describe_Open_photo_library_47a7e');
      case 'file':
        return t(ctx.locale, 'describeFileSlot', { v0: c.show?.label ?? '' });
      case 'link':
        return t(ctx.locale, 'describe_link_941e3', { v0: c.show?.label ?? '' });
      case 'package': {
        const id = packageTargetId(c.opens as OpenTarget)!;
        const name = localize(ctx.registry.tools.get(id)?.name, ctx.locale) ?? id;
        return t(ctx.locale, 'describe_tool_card_80198', { v0: name });
      }
      case 'app': {
        const appId = appTargetId(c.opens as OpenTarget)!;
        const name = c.show?.label ?? config.nav.apps?.find((a) => a.id === appId)?.name ?? appId;
        return t(ctx.locale, 'describe_shortcut_b2616', { v0: name });
      }
      default:
        return isCardShape(buttonShape(c))
          ? t(ctx.locale, 'describe_shortcut_b2616', { v0: c.show?.label ?? '' })
          : t(ctx.locale, 'describe_button_d79ee', { v0: c.show?.label ?? '' });
    }
  },
  edit: {
    text: [
      { prop: 'label', max: 60 },
      { prop: 'subtitle', max: 80, optional: true },
      { prop: 'hint', max: 80, optional: true },
    ],
    style: ALL_STYLES,
    asset: 'file',
    backdrop: true,
  },
  editOf: buttonEdit,
  ai: {
    doc: 'show? {label?, subtitle?, icon?, shape?: "filled"|"outline"|"text"|"icon"|"row"|"tile"|"card", hint?}, and either opens or tools [one tool]: anything tapped that opens something or does one thing. opens: a page, a system entry, "tool:<id>" (shows that quick action, one in tools[] or a built-in preset id; the user taps Start, it never runs by itself), "package:<id>" (an added tool\'s page) or "app:<id>" (one of the user\'s apps; label and icon may be left out, they come from the app). tools [{tool: <quick action id or preset id>}] runs that quick action (a preset needs nothing added; once the user changes it, their copy runs); add one only where the user asks for it (rule 20). tools [{tool: "$pick.media"}] / [{tool: "$pick.files"}]: the kernel file picker ("Open photo library" for photos AND videos / "Open files"); what is picked goes to the kernel inbox and never runs a quick action by itself; for "Add a photo picker to home" add this button, not a quick action. For package, a quick action to run and a file picker leave label and icon out: they come from Tinkrum. tools [{do: "create", table, values?, ask?: "all"}] or [{do: "setAll", table, filter?, field, value}] changes entries when tapped (rule 44); [{do: "createAll", table, from, filter?, values}] creates one entry in table for each matching entry of from (rule 63). A slot for one file the user wants at hand (a contract, a ticket, a manual) is a button with opens {file: null}: set only label, hint and shape (row or tile); never choose a file: the user taps the empty slot to pick one, Tinkrum keeps a copy, and later a tap opens it. You never see which file it is. shape: filled, outline, text = a button with the label (icon before it); icon = only the icon (needs icon; screen readers read the label); row = a settings-style row (light icon block, label, subtitle, an arrow, or a play icon for a quick action to run); tile = a card with a big icon block (a small square, two per row, for a quick action to run); card = a quick action\'s steps and a Run button. Without shape: row for opens (tile for a tool\'s page), filled for a record tool, a plain button for a file picker, and for a quick action to run tile next to other such buttons or in a grid/row group, card otherwise. Row and tile are stacked in a grid or row group or when centered. label ≤40 characters.',
  },
  example: { show: { label: 'Settings', shape: 'filled' }, opens: 'settings' },
});
