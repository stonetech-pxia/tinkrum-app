import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import type { PackBridge, PackPageId } from './bridge';
import { PACK_BASE_URL } from './pages/common';
import { OCR_PAGE } from './pages/ocr';
import { PDFVIEW_PAGE } from './pages/pdfview';
import { SCAN_PAGE } from './pages/scan';
import type { PackStore } from './store';

// Pack runtime environment: lazily mounts hidden WebViews (one per pack), using fixed HTML shipped alongside the app.

const PAGES: Record<PackPageId, string> = {
  pdfview: PDFVIEW_PAGE,
  scan: SCAN_PAGE,
  ocr: OCR_PAGE,
};

export interface Packs {
  store: PackStore;
  bridge: PackBridge;
}

const PacksContext = createContext<Packs | null>(null);

/** Returns null when the pack environment is missing (some tests): steps requiring packs will report that they cannot be prepared. */
export function usePacks(): Packs | null {
  return useContext(PacksContext);
}

export function PackHostProvider({ value, children }: { value: Packs; children: ReactNode }) {
  const active = useSyncExternalStore(value.bridge.subscribe, value.bridge.activePages);
  return (
    <PacksContext.Provider value={value}>
      {children}
      <View pointerEvents="none" style={styles.hidden}>
        {active.map((page) =>
          PAGES[page] ? (
            <WebView
              key={page}
              ref={(w) => value.bridge.attach(page, w)}
              source={{ html: PAGES[page]!, baseUrl: PACK_BASE_URL }}
              // Origin whitelist set to '*', delegating all loading to the following check: only
              // our own pages are allowed, all other URLs are rejected. (URLs not in the whitelist
              // are opened by react-native-webview using the system, e.g., Safari, so whitelist
              // filtering alone is insufficient.)
              originWhitelist={['*']}
              onShouldStartLoadWithRequest={(r) =>
                r.url.startsWith(PACK_BASE_URL) ||
                r.url === 'about:blank' ||
                r.url.startsWith('blob:')
              }
              onMessage={(e) => void value.bridge.onMessage(page, e.nativeEvent.data)}
              // When iOS experiences low memory pressure, it terminates the web process; on Android, it's the render process: both are treated as page stops, remounting on the next call.
              onContentProcessDidTerminate={() => value.bridge.processGone(page)}
              onRenderProcessGone={() => value.bridge.processGone(page)}
              onError={(e) => {
                if (__DEV__) console.warn(`[pack:${page}] load error`, e.nativeEvent.description);
              }}
              javaScriptEnabled
              allowFileAccess={false}
              setSupportMultipleWindows={false}
              style={styles.webview}
            />
          ) : null,
        )}
      </View>
    </PacksContext.Provider>
  );
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', left: 0, top: 0, width: 2, height: 2, opacity: 0.01 },
  webview: { width: 2, height: 2 },
});
