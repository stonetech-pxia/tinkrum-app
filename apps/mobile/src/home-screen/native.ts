import MorphShortcuts, { type ShortcutItem } from '../../modules/morph-shortcuts';
import { drawHomeScreenIcon } from './icon-image';
import type { HomeScreenEntry, HomeScreenPlatform } from './platform';

/**
 * Items passed to the native module. Android: App's own icon is first drawn as an image (D-606);
 * if it cannot be drawn, no icon is supplied, and native uses Tinkrum's icon. iOS menus only
 * accept system icons (symbol) and do not draw (drawHomeScreenIcon does nothing on iOS).
 */
async function toNative({ art, ...item }: HomeScreenEntry): Promise<ShortcutItem> {
  if (!art) return item;
  const image = await drawHomeScreenIcon(art).catch(() => null);
  return image ? { ...item, image } : item;
}

/** Drawing requires waiting: queued sequentially so the menu of a later operation doesn't overwrite an earlier one. */
let queue: Promise<unknown> = Promise.resolve();

/** Local module MorphShortcuts (D-271); absent in Expo Go, Web, and tests, returns null (not synchronized, buttons not displayed). */
export const nativeHomeScreen: HomeScreenPlatform | null = MorphShortcuts
  ? {
      setItems: (items, disabledMessage) => {
        const next = queue
          .catch(() => undefined)
          .then(async () =>
            MorphShortcuts!.setItems(await Promise.all(items.map(toNative)), disabledMessage),
          );
        queue = next;
        return next;
      },
      canPin: () => MorphShortcuts!.canPin(),
      pin: async (item) => MorphShortcuts!.pin(await toNative(item)),
      takeLaunched: () => MorphShortcuts!.takeLaunched(),
      onOpen: (listener) => {
        const sub = MorphShortcuts!.addListener('onOpen', (e) => listener(e.id));
        return () => sub.remove();
      },
    }
  : null;
