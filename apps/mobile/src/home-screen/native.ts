import MorphShortcuts, { type ShortcutItem } from '../../modules/morph-shortcuts';
import { drawHomeScreenIcon } from './icon-image';
import type { HomeScreenEntry, HomeScreenPlatform } from './platform';

/**
 * 交给本地模块的项。Android：App 自己的图标先画成一张图（D-606）；画不出来就不带图，原生用 Tinkrum 的图标。
 * iOS 的菜单只收系统图标（symbol），不画（drawHomeScreenIcon 在 iOS 上什么都不画）。
 */
async function toNative({ art, ...item }: HomeScreenEntry): Promise<ShortcutItem> {
  if (!art) return item;
  const image = await drawHomeScreenIcon(art).catch(() => null);
  return image ? { ...item, image } : item;
}

/** 画图要等：一次一次排着换，后一次的菜单不会被前一次的盖掉。 */
let queue: Promise<unknown> = Promise.resolve();

/** 本地模块 MorphShortcuts（D-271）；Expo Go、Web 和测试里没有，返回 null（不同步、不显示按钮）。 */
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
