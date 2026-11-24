// Runs the app's pdfview page (apps/mobile/src/packs/pages/pdfview.ts, PDF.js) in headless Chrome;
// the message protocol is identical to the WebView on mobile: the page packages the file, specifies
// authorized input files, and returns results by id. Only allows the single file provided this time
// (matching the app), and rejects all other local files.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

import { PDFVIEW_PAGE } from '../../../apps/mobile/src/packs/pages/pdfview';
import { ENV, need } from './env';

export interface PdfClient {
  call<T>(method: string, args: Record<string, unknown>, files: Record<string, string>): Promise<T>;
  close(): Promise<void>;
}

/** Prevents the process from hanging on exit just to wait for a timeout. */
function timeout(fn: () => void, ms: number) {
  (setTimeout(fn, ms) as unknown as { unref?: () => void }).unref?.();
}

export async function pdfClient(): Promise<PdfClient> {
  const { chromium } = createRequire(`${need(ENV.playwright, 'playwright')}/package.json`)(
    'playwright',
  );
  const pdfjs = need(ENV.pdfjs, 'pdfview pack (pdf.js)');
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(PDFVIEW_PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({
    executablePath: need(ENV.chrome, 'Chrome'),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e: Error) => console.error('pdfview page error:', e.message));
    const waits = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let next = 0;
    let allowed: Record<string, string> = {};
    let ready!: () => void;
    const isReady = new Promise<void>((r) => (ready = r));
    const send = (v: unknown) =>
      page.evaluate(
        (m: string) => window.dispatchEvent(new MessageEvent('message', { data: m })),
        JSON.stringify(v),
      );
    await page.exposeFunction('nativePost', async (s: string) => {
      const m = JSON.parse(s);
      if (m.t === 'ready') ready();
      if (m.t === 'need') {
        try {
          let path: string;
          if (m.ref.pack === 'pdfview' && !String(m.ref.path).includes('..')) {
            path = `${pdfjs}/${m.ref.path}`;
          } else if (m.ref.file && allowed[m.ref.file]) path = allowed[m.ref.file]!;
          else throw new Error('Unauthorized local file');
          const bytes = readFileSync(path);
          const data = m.as === 'text' ? bytes.toString('utf8') : bytes.toString('base64');
          const chunk = 512 * 1024;
          const n = Math.max(1, Math.ceil(data.length / chunk));
          for (let i = 0; i < n; i++) {
            await send({
              t: 'chunk',
              id: m.id,
              i,
              n,
              data: data.slice(i * chunk, (i + 1) * chunk),
            });
          }
        } catch (e) {
          await send({ t: 'chunk', id: m.id, error: String(e) });
        }
      }
      if (m.t === 'result') {
        const w = waits.get(m.id);
        waits.delete(m.id);
        if (m.ok) w?.resolve(m.value);
        else w?.reject(new Error(m.error));
      }
    });
    await page.addInitScript({
      content: 'window.ReactNativeWebView={postMessage:function(s){window.nativePost(s)}};',
    });
    // The page cannot access the network: only allows the page itself.
    await page.route(
      '**/*',
      (route: { request(): { url(): string }; continue(): void; abort(): void }) =>
        route.request().url() === `${base}/` ? route.continue() : route.abort(),
    );
    await page.goto(base);
    await Promise.race([
      isReady,
      new Promise((_, reject) => timeout(() => reject(new Error('pdfview ready timeout')), 15000)),
    ]);
    return {
      async call<T>(method: string, args: Record<string, unknown>, files: Record<string, string>) {
        allowed = files;
        const id = ++next;
        const result = new Promise<T>((resolve, reject) =>
          waits.set(id, { resolve: resolve as (v: unknown) => void, reject }),
        );
        await send({ t: 'call', id, method, args });
        return Promise.race([
          result,
          new Promise<T>((_, reject) =>
            timeout(() => reject(new Error(`pdfview ${method} timeout`)), 180000),
          ),
        ]);
      },
      async close() {
        await browser.close();
        await new Promise((r) => server.close(r));
      },
    };
  } catch (e) {
    await browser.close();
    await new Promise((r) => server.close(r));
    throw e;
  }
}
