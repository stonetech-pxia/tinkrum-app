// 网站上的 App 文件检查页用的脚本（D-593）：和 App 导入时同一套检查，在浏览器里跑，不联网。
import { BUILTIN_TOOLS, checkAppFileText, createRegistry } from '@morph/core';

const registry = createRegistry(BUILTIN_TOOLS);

(globalThis as { tinkrumCheckAppFile?: unknown }).tinkrumCheckAppFile = (text: string) =>
  checkAppFileText(text, { registry, locale: 'en', now: new Date() });
