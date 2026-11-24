import { t } from '../messages';
import { z } from 'zod';

import { ToolUseSchema } from '../record-ops-schema';
import { type LookDefinitionOf, defineLook } from './define';

const shape = {
  /** icon = white-background button with icon only (D-449); omitted means a button with text. */
  show: z.strictObject({ shape: z.enum(['icon']).optional() }).optional(),
  tools: z.array(ToolUseSchema).min(1).max(1),
};

/**
 * Open photo library / open files (formerly filePick): core fixed behavior, enters inbox after
 * selection, never runs automatically (AI does not provide executable content). $pick.open
 * (D-449): prompts whether to select from photo library or "Files" upon tapping.
 */
export const pickerComponent: LookDefinitionOf<'picker', typeof shape> = defineLook({
  look: 'picker',
  shape,
  kind: 'container',
  layer: 'file',
  reads: 'none',
  writes: false,
  tools: { as: ['self'], ref: ['pick'], max: 1 },
  describe: (c, _config, ctx) =>
    'tool' in c.tools[0]! && (c.tools[0].tool === '$pick.files' || c.tools[0].tool === '$pick.open')
      ? t(ctx.locale, 'describe_Open_files_3477c')
      : t(ctx.locale, 'describe_Open_photo_library_47a7e'),
  edit: { text: [], style: [] },
  ai: {
    doc: 'tools: [{tool: "$pick.media"}] or [{tool: "$pick.files"}]: kernel file picker entry, labeled "打开相册" / "Open photo library" for media (photos AND videos), "打开文件" / "Open files" for files. Selection opens the kernel inbox; never runs a quick action automatically. You may add, move, hide or remove it, but cannot customize its behavior. For "首页加上打开相册" / "Add a photo picker to home", add a picker block with "$pick.media" to home; do not create a quick action.',
    docAfter: 'button',
  },
  example: { tools: [{ tool: '$pick.media' }] },
});
