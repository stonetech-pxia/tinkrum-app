import { z } from 'zod';

import { t } from '../messages';
import { AssetIdSchema, boundedText } from '../schema-base';
import { type LookDefinitionOf, defineLook } from './define';

const shape = {
  show: z.strictObject({
    /** User-selected photo (original props.assetId): one of four places in config pointing to user files, neither written nor visible to the AI (D-045). */
    asset: AssetIdSchema.nullable().optional(),
    aspect: z.enum(['wide', 'landscape', 'square', 'portrait']),
    fit: z.enum(['cover', 'contain']),
    caption: boundedText(1, 120).optional(),
    /** Prompt displayed when no photo has been selected yet. */
    placeholder: boundedText(1, 60).optional(),
  }),
};

/**
 * Image: AI can only place an image slot and set its layout; the specific photo is chosen by the
 * user on the page (D-045). show.asset points to a user file; the AI cannot see image content or
 * file names.
 */
export const imageComponent: LookDefinitionOf<'image', typeof shape> = defineLook({
  look: 'image',
  shape,
  kind: 'container',
  layer: 'file',
  reads: 'none',
  writes: false,
  describe: (c, _config, ctx) =>
    c.show.caption
      ? t(ctx.locale, 'describe_image_d5072', { v0: c.show.caption })
      : t(ctx.locale, 'describe_image_df755'),
  edit: {
    text: [
      { prop: 'caption', max: 120, optional: true },
      { prop: 'placeholder', max: 60, optional: true },
    ],
    style: ['align'],
  },
  ai: {
    doc: 'show {asset?, aspect: "wide"|"landscape"|"square"|"portrait", fit: "cover"|"contain", caption?, placeholder?}: a picture the user chooses. You can add an image slot and set its layout, caption and placeholder hint, but never choose or invent a picture: leave asset out (the user taps the slot to pick a photo). You never see the pictures. Whenever the user asks for a photo, picture, image, banner image, cover, 图片, 照片, 头图, 封面, 横幅图片 or 配图, add an image block as an empty slot (the user fills it by tapping it) — do this even though you can\'t choose the picture yourself, and never substitute a notice or text for it.',
  },
  example: { show: { aspect: 'wide', fit: 'cover', placeholder: 'Pick a photo' } },
});
