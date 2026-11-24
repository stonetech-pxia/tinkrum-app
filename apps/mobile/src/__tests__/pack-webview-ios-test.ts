/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { PackBridge } from '../packs/bridge';
import { PDFJS_POLYFILLS } from '../packs/pages/common';

// Extension pack pages (hidden WebViews) are attached to the root view. On iOS, full-screen modal
// presentations (UIModalPresentationFullScreen) remove the underlying view from the window
// hierarchy, taking the WebView out of the window, which causes the system to suspend its web
// process: PDF preview, organization pages, and signatures stay permanently "Loading" (2026-10-31
// iPhone real device: timers in the page never ran once, pdf.js rendering halted halfway). Android
// dialogs are separate windows and remain unaffected.

const SRC = join(__dirname, '..');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

describe('Extension pack pages are not pushed out of the window by modal presentations on iOS', () => {
  it('Opaque modals use overFullScreen (keeping underlying views in the window)', () => {
    const bad: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/<Modal\b[^>]*>/gs)) {
        const tag = m[0];
        if (/\btransparent\b/.test(tag)) continue;
        if (!/presentationStyle="overFullScreen"/.test(tag)) {
          bad.push(`${file.slice(SRC.length + 1)}:${text.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('Routes do not use fullScreenModal', () => {
    const bad = tsxFiles(SRC).filter((file) =>
      /presentation:\s*'fullScreenModal'/.test(readFileSync(file, 'utf8')),
    );
    expect(bad.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});

describe('Web process terminated by system', () => {
  const files = {
    packFile: async () => '',
    isInstalled: async () => true,
    runFile: async () => '',
  };

  it('Pending calls fail immediately, next call re-opens the page', async () => {
    const bridge = new PackBridge(files);
    const posted: string[] = [];
    bridge.attach('pdfview', { postMessage: (m) => posted.push(m) });
    await bridge.onMessage('pdfview', JSON.stringify({ t: 'ready' }));

    const call = bridge.call('pdfview', 'render', {});
    await Promise.resolve();
    expect(posted).toHaveLength(1);
    bridge.processGone('pdfview');
    await expect(call).rejects.toThrow('page stopped');
    // Page unmounted, re-attached (reloaded) on next invocation.
    expect(bridge.activePages()).toEqual([]);

    const again = bridge.call('pdfview', 'ping', {});
    await Promise.resolve();
    expect(bridge.activePages()).toEqual(['pdfview']);
    expect(posted).toHaveLength(1);
    await bridge.onMessage('pdfview', JSON.stringify({ t: 'ready' }));
    await Promise.resolve();
    const id = JSON.parse(posted[1]!).id;
    await bridge.onMessage('pdfview', JSON.stringify({ t: 'result', id, ok: true, value: 1 }));
    await expect(again).resolves.toBe(1);
  });
});

describe('View containing the extension pack page re-renders', () => {
  const files = {
    packFile: async () => '',
    isInstalled: async () => true,
    runFile: async () => '',
  };

  // Re-rendering the same WebView with null and then re-attaching keeps the page ready: Being in
  // use prevents disconnection; the next invocation sends directly without awaiting a ready state
  // that will never arrive again (on real devices, PDF preview kept spinning and failed after 30
  // seconds).
  it('Re-attaching the same WebView after null leaves the page ready', async () => {
    const bridge = new PackBridge(files);
    const posted: string[] = [];
    const webview = { postMessage: (m: string) => posted.push(m) };
    bridge.attach('pdfview', webview);
    const first = bridge.call('pdfview', 'preview', {});
    await Promise.resolve();
    await bridge.onMessage('pdfview', JSON.stringify({ t: 'ready' }));
    await Promise.resolve();
    expect(posted).toHaveLength(1);

    bridge.attach('pdfview', null);
    bridge.attach('pdfview', webview);
    const second = bridge.call('pdfview', 'preview', {});
    await Promise.resolve();
    await Promise.resolve();
    expect(posted).toHaveLength(2);

    bridge.processGone('pdfview');
    await expect(first).rejects.toThrow('page stopped');
    await expect(second).rejects.toThrow('page stopped');
  });

  it('After page is truly unmounted (no longer in use), next call must re-await ready', async () => {
    const bridge = new PackBridge(files);
    const posted: string[] = [];
    const webview = { postMessage: (m: string) => posted.push(m) };
    bridge.attach('pdfview', webview);
    const first = bridge.call('pdfview', 'preview', {});
    await Promise.resolve();
    await bridge.onMessage('pdfview', JSON.stringify({ t: 'ready' }));
    await Promise.resolve();
    bridge.processGone('pdfview');
    await expect(first).rejects.toThrow();
    bridge.attach('pdfview', null);
    bridge.attach('pdfview', webview);

    const again = bridge.call('pdfview', 'preview', {});
    await Promise.resolve();
    expect(posted).toHaveLength(1);
    await bridge.onMessage('pdfview', JSON.stringify({ t: 'ready' }));
    await Promise.resolve();
    expect(posted).toHaveLength(2);
    bridge.processGone('pdfview');
    await expect(again).rejects.toThrow();
  });
});

describe('pdf.js text reading on iOS WebView', () => {
  // Patch enables ReadableStream for..await iteration: ReadableStreams cannot be for..await
  // iterated in iOS WebViews, causing pdf.js getTextContent to throw "undefined is not a function
  // (near '...t of e...')" (2026-10-31 iPhone real device).
  it('Patch enables ReadableStream for..await iteration', async () => {
    const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
    const original = proto[Symbol.asyncIterator];
    delete proto[Symbol.asyncIterator];
    try {
      new Function(PDFJS_POLYFILLS)();
      const stream = new ReadableStream<number>({
        start(c) {
          c.enqueue(1);
          c.enqueue(2);
          c.close();
        },
      });
      const got: number[] = [];
      for await (const x of stream as unknown as AsyncIterable<number>) got.push(x);
      expect(got).toEqual([1, 2]);
    } finally {
      proto[Symbol.asyncIterator] = original;
    }
  });
});
