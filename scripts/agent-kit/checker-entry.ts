// 网站上的 App 文件检查页用的脚本（D-593）：和 App 导入时同一套检查，在浏览器里跑，不联网。
import {
  BUILTIN_TOOLS,
  appLink,
  appLinkPayload,
  readAppLink,
  checkHandoffFileText,
  setupPreviewFiles,
  createRegistry,
} from '@morph/core';

const registry = createRegistry(BUILTIN_TOOLS);

(globalThis as { tinkrumCheckAppFile?: unknown }).tinkrumCheckAppFile = (text: string) =>
  checkHandoffFileText(text, { registry, locale: 'en', now: new Date() });

// /open 与检查页共用检查器，以及 core 中唯一的压缩编码。
Object.assign(globalThis, {
  tinkrumAppLink: appLink,
  tinkrumReadAppLink: readAppLink,
  tinkrumAppLinkPayload: appLinkPayload,
  tinkrumSetupPreviewFiles: setupPreviewFiles,
});
