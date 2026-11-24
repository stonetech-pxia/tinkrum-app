// Script used by the app file check page on the website (D-593): the same check suite as app import, running in the browser without network access.
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

// Shares the checker between /open and inspection pages, along with the sole compression encoding implementation in core.
Object.assign(globalThis, {
  tinkrumAppLink: appLink,
  tinkrumReadAppLink: readAppLink,
  tinkrumAppLinkPayload: appLinkPayload,
  tinkrumSetupPreviewFiles: setupPreviewFiles,
});
