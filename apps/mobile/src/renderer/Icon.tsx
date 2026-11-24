import {
  isDrawnIconRef,
  type CustomIconName,
  type IconName,
  type IconValue,
  type ToolIconName,
} from '@morph/core';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Image, Text } from 'react-native';

import { DrawnIconView } from './DrawnIcon';

// Icon whitelist (core's ICON_NAMES) -> System icons: SF Symbols on iOS, Material Symbols on Android.

type SymbolName = Extract<SymbolViewProps['name'], { ios?: unknown }>;

const SYMBOLS: Record<Exclude<IconName, CustomIconName>, SymbolName> = {
  home: { ios: 'house.fill', android: 'home' },
  apps: { ios: 'square.grid.2x2.fill', android: 'apps' },
  sparkles: { ios: 'sparkles', android: 'auto_awesome' },
  history: { ios: 'clock.arrow.circlepath', android: 'history' },
  settings: { ios: 'gearshape.fill', android: 'settings' },
  document: { ios: 'doc.fill', android: 'description' },
  folder: { ios: 'folder.fill', android: 'folder' },
  star: { ios: 'star.fill', android: 'star' },
  heart: { ios: 'heart.fill', android: 'favorite' },
  bolt: { ios: 'bolt.fill', android: 'bolt' },
  calendar: { ios: 'calendar', android: 'calendar_month' },
  bookmark: { ios: 'bookmark.fill', android: 'bookmark' },
  inbox: { ios: 'tray.fill', android: 'inbox' },
  chart: { ios: 'chart.bar.fill', android: 'bar_chart' },
  check: { ios: 'checkmark.circle.fill', android: 'check_circle' },
  info: { ios: 'info.circle.fill', android: 'info' },
  lightbulb: { ios: 'lightbulb.fill', android: 'lightbulb' },
  merge: { ios: 'arrow.triangle.merge', android: 'merge' },
  link: { ios: 'link', android: 'link' },
  person: { ios: 'person.fill', android: 'person' },
  plus: { ios: 'plus', android: 'add' },
  search: { ios: 'magnifyingglass', android: 'search' },
  photo: { ios: 'photo.fill', android: 'image' },
  scan: { ios: 'doc.viewfinder', android: 'document_scanner' },
  text: { ios: 'text.viewfinder', android: 'text_fields' },
  qrcode: { ios: 'qrcode', android: 'qr_code' },
  archive: { ios: 'archivebox.fill', android: 'archive' },
  printer: { ios: 'printer.fill', android: 'print' },
  signature: { ios: 'signature', android: 'draw' },
  workflow: { ios: 'arrow.triangle.branch', android: 'account_tree' },
  video: { ios: 'video.fill', android: 'videocam' },
  audio: { ios: 'waveform', android: 'graphic_eq' },
  translate: { ios: 'translate', android: 'translate' },
  note: { ios: 'note.text', android: 'notes' },
  phone: { ios: 'phone.fill', android: 'call' },
  message: { ios: 'message.fill', android: 'sms' },
  mail: { ios: 'envelope.fill', android: 'mail' },
  globe: { ios: 'globe', android: 'language' },
  share: { ios: 'square.and.arrow.up', android: 'share' },
  table: { ios: 'tablecells', android: 'table_chart' },
};

/**
 * Built-in graphic icons (D-485, drawn from presets, source files in assets/preset-icons/*.svg):
 * monochrome PNGs tinted by theme, just like Tink's hammer. Since there are no corresponding
 * icons in the system icon library, they have no icon in the long-press menu (iosSymbolName
 * returns undefined).
 */
const CUSTOM_IMAGES: Record<CustomIconName, number> = {
  wallet: require('../../assets/images/preset-icons/wallet.png'),
  rings: require('../../assets/images/preset-icons/rings.png'),
  moon: require('../../assets/images/preset-icons/moon.png'),
  timer: require('../../assets/images/preset-icons/timer.png'),
  book: require('../../assets/images/preset-icons/book.png'),
  board: require('../../assets/images/preset-icons/board.png'),
  suitcase: require('../../assets/images/preset-icons/suitcase.png'),
  vinyl: require('../../assets/images/preset-icons/vinyl.png'),
  paper: require('../../assets/images/preset-icons/paper.png'),
};

/** Action icons for room toolbar (core's TOOL_ICON_NAMES, D-364): not in whitelist, config and AI cannot use them. */
const TOOL_SYMBOLS: Record<ToolIconName, SymbolName> = {
  rotate: { ios: 'rotate.right', android: 'rotate_right' },
  crop: { ios: 'crop', android: 'crop' },
  pencil: { ios: 'pencil.tip', android: 'edit' },
  redact: { ios: 'eye.slash.fill', android: 'visibility_off' },
  tune: { ios: 'slider.horizontal.3', android: 'tune' },
  wand: { ios: 'wand.and.stars', android: 'auto_fix_high' },
  convert: { ios: 'arrow.triangle.2.circlepath', android: 'sync_alt' },
  resize: { ios: 'arrow.up.left.and.arrow.down.right', android: 'open_in_full' },
  compress: { ios: 'arrow.down.right.and.arrow.up.left', android: 'compress' },
  privacy: { ios: 'location.slash.fill', android: 'location_off' },
  stitch: { ios: 'rectangle.split.1x2.fill', android: 'view_agenda' },
  gif: { ios: 'photo.stack.fill', android: 'gif_box' },
  grid: { ios: 'square.grid.3x3.fill', android: 'grid_on' },
  watermark: { ios: 'drop.fill', android: 'water_drop' },
  enhance: { ios: 'camera.filters', android: 'filter' },
  pdf: { ios: 'doc.richtext.fill', android: 'picture_as_pdf' },
  table: { ios: 'tablecells', android: 'table_chart' },
  pages: { ios: 'doc.on.doc.fill', android: 'auto_stories' },
  form: { ios: 'list.bullet.rectangle.fill', android: 'edit_note' },
  select: { ios: 'checklist', android: 'checklist' },
  split: { ios: 'square.split.2x1.fill', android: 'call_split' },
  number: { ios: 'number', android: 'format_list_numbered' },
  stamp: { ios: 'seal.fill', android: 'approval' },
  lock: { ios: 'lock.fill', android: 'lock' },
  camera: { ios: 'camera.viewfinder', android: 'photo_camera' },
  trim: { ios: 'scissors', android: 'content_cut' },
  speed: { ios: 'hare.fill', android: 'speed' },
  music: { ios: 'music.note', android: 'music_note' },
  mute: { ios: 'speaker.slash.fill', android: 'volume_off' },
  denoise: { ios: 'ear', android: 'hearing' },
  volume: { ios: 'speaker.wave.2.fill', android: 'volume_up' },
  captions: { ios: 'captions.bubble.fill', android: 'closed_caption' },
  share: { ios: 'square.and.arrow.up', android: 'share' },
  save: { ios: 'square.and.arrow.down', android: 'download' },
  preview: { ios: 'eye.fill', android: 'visibility' },
  // textformat and text.cursor render text based on the system language (showing "format" and "character" on Chinese systems); replace with text-free symbols.
  textbox: { ios: 'text.insert', android: 'text_fields' },
  sticky: { ios: 'text.bubble.fill', android: 'sticky_note_2' },
  brush: { ios: 'scribble', android: 'brush' },
  highlight: { ios: 'highlighter', android: 'ink_highlighter' },
  shapes: { ios: 'square.on.circle', android: 'category' },
  erase: { ios: 'eraser.fill', android: 'ink_eraser' },
  mosaic: { ios: 'square.grid.2x2.fill', android: 'blur_on' },
};

/** SF Symbol name used in system menus (menu on long-pressing the Morph icon, D-271); emojis have none. */
export function iosSymbolName(name: IconValue): string | undefined {
  return name in SYMBOLS ? SYMBOLS[name as keyof typeof SYMBOLS].ios : undefined;
}

/**
 * Used when rendering icons as images (Android desktop icon, D-606): system icons take Material
 * Symbol names, built-in graphics take the monochrome PNG, and emojis take neither (rendered as
 * text).
 */
export function iconSource(name: IconValue): { symbol?: string; image?: number } {
  if (name in CUSTOM_IMAGES) return { image: CUSTOM_IMAGES[name as CustomIconName] };
  return name in SYMBOLS ? { symbol: SYMBOLS[name as keyof typeof SYMBOLS].android } : {};
}

export function Icon({
  name,
  size = 22,
  color,
}: {
  name: IconValue | ToolIconName | 'tink';
  size?: number;
  color: string;
}) {
  // Tink's hammer (D-436): not in the system icon library, rendered as a monochrome PNG tinted by theme.
  if (name === 'tink') {
    return (
      <Image
        testID="tink-hammer"
        source={require('../../assets/images/tink-hammer.png')}
        style={{ width: size, height: size, tintColor: color }}
      />
    );
  }
  // Icons generated in config (D-625): fetch path from icon library, render using Skia.
  if (isDrawnIconRef(name)) return <DrawnIconView name={name} size={size} color={color} />;
  if (name in CUSTOM_IMAGES) {
    return (
      <Image
        testID={`icon-${name}`}
        source={CUSTOM_IMAGES[name as CustomIconName]}
        style={{ width: size, height: size, tintColor: color }}
      />
    );
  }
  const symbol =
    name in SYMBOLS
      ? SYMBOLS[name as keyof typeof SYMBOLS]
      : name in TOOL_SYMBOLS
        ? TOOL_SYMBOLS[name as ToolIconName]
        : null;
  // Anything not a built-in icon name is an emoji (validated by schema), displayed as-is.
  if (!symbol) {
    return (
      <Text
        allowFontScaling={false}
        style={{
          fontSize: Math.round(size * 0.92),
          lineHeight: Math.round(size * 1.15),
          textAlign: 'center',
          minWidth: size,
        }}>
        {name}
      </Text>
    );
  }
  return (
    <SymbolView
      name={symbol}
      size={size}
      tintColor={color}
      // When the platform does not support system icons (e.g., Web), use a placeholder dot to ensure layout stability.
      fallback={<Text style={{ width: size, height: size, color, fontSize: size * 0.6 }}>●</Text>}
    />
  );
}

/**
 * Icons used by core UI itself (draft mode buttons, send, swipe-through tutorial diagrams, etc.,
 * D-190). Not in core whitelist: AI and config cannot use them.
 */
const UI_SYMBOLS = {
  chat: { ios: 'bubble.left.fill', android: 'chat' },
  undo: { ios: 'arrow.uturn.backward', android: 'undo' },
  done: { ios: 'checkmark', android: 'check' },
  close: { ios: 'xmark', android: 'close' },
  send: { ios: 'arrow.up', android: 'arrow_upward' },
  palette: { ios: 'paintpalette.fill', android: 'palette' },
  arrowRight: { ios: 'arrow.right', android: 'arrow_forward' },
  arrowDown: { ios: 'arrow.down', android: 'arrow_downward' },
  chevronRight: { ios: 'chevron.right', android: 'chevron_right' },
  chevronDown: { ios: 'chevron.down', android: 'expand_more' },
  chevronUp: { ios: 'chevron.up', android: 'expand_less' },
  chevronLeft: { ios: 'chevron.left', android: 'chevron_left' },
  play: { ios: 'play.fill', android: 'play_arrow' },
  edit: { ios: 'pencil', android: 'edit' },
  add: { ios: 'plus', android: 'add' },
  phone: { ios: 'phone.fill', android: 'call' },
  message: { ios: 'message.fill', android: 'sms' },
  mail: { ios: 'envelope.fill', android: 'mail' },
  globe: { ios: 'globe', android: 'language' },
  share: { ios: 'square.and.arrow.up', android: 'share' },
  trash: { ios: 'trash', android: 'delete' },
} satisfies Record<string, SymbolName>;

export type UiIconName = keyof typeof UI_SYMBOLS;

export function UiIcon({
  name,
  size = 22,
  color,
}: {
  name: UiIconName;
  size?: number;
  color: string;
}) {
  return (
    <SymbolView
      name={UI_SYMBOLS[name]}
      size={size}
      tintColor={color}
      fallback={<Text style={{ width: size, height: size, color, fontSize: size * 0.6 }}>●</Text>}
    />
  );
}
