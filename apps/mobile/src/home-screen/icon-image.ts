import type { HomeScreenArt } from './platform';

// 桌面图标上的图只有 Android 画（icon-image.android.ts，D-606）。iOS 的菜单只收系统图标，这里不画；
// 分成两个文件，Android 用的图标字体就不会打进 iOS 的包。

/** 画不了：调用方不带图。 */
export async function drawHomeScreenIcon(_art: HomeScreenArt): Promise<string | null> {
  return null;
}
