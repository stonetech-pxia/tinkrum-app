import type { Registry } from '../registry';
import type { IconName } from '../schema';
import type { ActionDefinition } from '../workflow/contract';

// Icons for desk toolbars (D-364): a tool (such as "Image Processing") has many actions, and using
// the tool icon makes the entire row identical. Icons are assigned by action here: first check the
// full action ID, then the action verb (the part after the dot, such as rotate or compress, which
// are shared across tools); fall back to the tool icon if neither matches. These icons are only
// used on the desk and are not part of ICON_NAMES (the whitelist writable by config and AI), so the
// AI cannot change or see them.

export const TOOL_ICON_NAMES = [
  'rotate',
  'crop',
  'pencil',
  'redact',
  'tune',
  'wand',
  'convert',
  'resize',
  'compress',
  'privacy',
  'stitch',
  'gif',
  'grid',
  'watermark',
  'enhance',
  'pdf',
  'table',
  'pages',
  'form',
  'select',
  'split',
  'number',
  'stamp',
  'lock',
  'camera',
  'trim',
  'speed',
  'music',
  'mute',
  'denoise',
  'volume',
  'captions',
  'share',
  'save',
  'preview',
  'textbox',
  'sticky',
  'brush',
  'highlight',
  'shapes',
  'erase',
  'mosaic',
] as const;
export type ToolIconName = (typeof TOOL_ICON_NAMES)[number];
export type DeskIcon = IconName | ToolIconName;

/** Full action ID (action names may have different meanings across tools). */
const BY_ID: Readonly<Record<string, DeskIcon>> = {
  'image.idPhoto': 'person',
  'image.printSheet': 'printer',
  'image.removeBackground': 'wand',
  'scan.detect': 'scan',
  'scan.enhance': 'enhance',
  'pdf.fromImages': 'pdf',
  'pdf.fromDocument': 'pdf',
  'pdf.toImages': 'photo',
  'pdf.extractText': 'text',
  'pdf.selectPages': 'select',
  'ocr.recognize': 'text',
  'ocr.toExcel': 'table',
  'ocr.toWord': 'document',
  'qr.read': 'qrcode',
  'video.frame': 'camera',
  'video.audio': 'music',
  'audio.fromVideo': 'audio',
  'audio.transcribe': 'note',
};

/** Action verb (the part after the dot): the same operation uses the same icon across images, PDFs, videos, and audio. */
const BY_VERB: Readonly<Record<string, DeskIcon>> = {
  rotate: 'rotate',
  crop: 'crop',
  annotate: 'pencil',
  redact: 'redact',
  adjust: 'tune',
  convert: 'convert',
  resize: 'resize',
  compress: 'compress',
  stripMetadata: 'privacy',
  stitch: 'stitch',
  toGif: 'gif',
  grid: 'grid',
  watermark: 'watermark',
  pages: 'pages',
  sign: 'signature',
  fillForm: 'form',
  split: 'split',
  pageNumbers: 'number',
  stamp: 'stamp',
  protect: 'lock',
  trim: 'trim',
  speed: 'speed',
  mute: 'mute',
  merge: 'merge',
  denoise: 'denoise',
  volume: 'volume',
  subtitles: 'captions',
};

/** Different starting tools for the same action (e.g., PDF annotation tools for inserting text, comments, brushes) each use their own respective icon. */
const BY_PRESET: Readonly<Record<string, DeskIcon>> = {
  'pdf.annotate:text': 'textbox',
  'pdf.annotate:note': 'sticky',
  'pdf.annotate:pen': 'brush',
  'pdf.annotate:highlight': 'highlight',
  'pdf.annotate:box': 'shapes',
  'pdf.annotate:erase': 'erase',
  'pdf.annotate:mosaic': 'mosaic',
};

/** Icon for an action on the toolbar (checks starting tools first when applicable). */
export function deskToolIcon(
  action: ActionDefinition,
  registry: Registry,
  preset?: string,
): DeskIcon {
  const verb = action.id.slice(action.id.indexOf('.') + 1);
  return (
    (preset ? BY_PRESET[`${action.id}:${preset}`] : undefined) ??
    BY_ID[action.id] ??
    BY_VERB[verb] ??
    registry.tools.get(registry.actionOwner.get(action.id) ?? '')?.icon ??
    'bolt'
  );
}
