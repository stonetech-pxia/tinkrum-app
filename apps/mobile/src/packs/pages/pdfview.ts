import { packPage, PDFJS_POLYFILLS } from './common';
import { PDF_GRAPHICS_SCRIPT } from './pdf-graphics';

// PDF preview pack page: pdf.js (legacy ESM version) loaded from blob: URL; if worker fails, pdf.js
// falls back to the main thread itself. Cmap, fonts, and decoders are requested on demand from the
// App via BinaryDataFactory (only requesting those used by this file). Renders and reads text only:
// does not load pdf.sandbox, does not execute PDF scripts, does not pass url (N3).

const SCRIPT = String.raw`
const POLY = ${JSON.stringify(PDFJS_POLYFILLS)} + '\n';
let pdfjs = null;
async function lib() {
  if (pdfjs) return pdfjs;
  pdfjs = await import(blobUrl(await need({ pack: 'pdfview', path: 'legacy/build/pdf.min.mjs' }, 'text')));
  pdfjs.GlobalWorkerOptions.workerSrc = blobUrl([
    POLY,
    await need({ pack: 'pdfview', path: 'legacy/build/pdf.worker.min.mjs' }, 'text'),
  ]);
  return pdfjs;
}
class PackBinaryDataFactory {
  constructor() {}
  async fetch({ kind, filename }) {
    const dir = { cMapUrl: 'cmaps/', standardFontDataUrl: 'standard_fonts/', wasmUrl: 'wasm/' }[kind];
    if (!dir) throw new Error('unsupported ' + kind);
    return need({ pack: 'pdfview', path: dir + filename }, 'bytes');
  }
}
async function open(file) {
  const p = await lib();
  const data = await need({ file }, 'bytes');
  const task = p.getDocument({
    data,
    BinaryDataFactory: PackBinaryDataFactory,
    useWorkerFetch: false,
    cMapPacked: true,
    enableXfa: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  // Close document and terminate worker (closing is on the loading task in 6.x).
  doc.close = () => task.destroy().catch(() => undefined);
  return doc;
}
// iOS WebView canvas upper limit is approximately 16.77 million pixels.
const MAX_PIXELS = 16000000;
async function renderList(doc, list, maxSide, quality) {
  const out = [];
  for (const index of list) {
    const page = await doc.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    let scale = maxSide / Math.max(base.width, base.height);
    if (base.width * base.height * scale * scale > MAX_PIXELS) {
      scale = Math.sqrt(MAX_PIXELS / (base.width * base.height));
    }
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push({
      index,
      width: canvas.width,
      height: canvas.height,
      paper: { width: base.width, height: base.height },
      data: canvas.toDataURL('image/jpeg', quality).split(',')[1],
    });
    page.cleanup();
    canvas.width = canvas.height = 0;
  }
  return out;
}
handlers.render = async ({ file, pages, maxSide, quality }) => {
  const doc = await open(file);
  try {
    const list = pages && pages.length ? pages : Array.from({ length: doc.numPages }, (_, i) => i);
    return await renderList(doc, list, maxSide, quality);
  } finally {
    await doc.close();
  }
};
// Large previews for file rooms (D-360): render only the pages to be viewed at a time, while informing the App of the total page count.
handlers.preview = async ({ file, pages, maxSide, quality }) => {
  const doc = await open(file);
  try {
    const list = (pages || []).filter((i) => i >= 0 && i < doc.numPages);
    return { count: doc.numPages, pages: await renderList(doc, list, maxSide, quality) };
  } finally {
    await doc.close();
  }
};
handlers.text = async ({ file }) => {
  const doc = await open(file);
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      const lines = [];
      for (const item of content.items) {
        line += item.str || '';
        if (item.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      pages.push(lines.join('\n'));
      page.cleanup();
    }
    return { pages };
  } finally {
    await doc.close();
  }
};
// Candidate values for new record forms (D-394): each paragraph of the text layer in the first few
// pages and its position (points, origin at top-left), ordered by the App using vertical overlap;
// lines is empty when scans lack a text layer.
handlers.lines = async ({ file, pages }) => {
  const doc = await open(file);
  try {
    const p = await lib();
    const out = [];
    const count = Math.min(doc.numPages, pages || 2);
    for (let i = 1; i <= count; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const lines = [];
      for (const item of content.items) {
        const text = (item.str || '').trim();
        if (!text) continue;
        const tx = p.Util.transform(viewport.transform, item.transform);
        const height = Math.hypot(tx[2], tx[3]) || item.height || 1;
        lines.push({ text, x: tx[4], y: tx[5] - height, width: item.width || text.length * height * 0.5, height });
      }
      out.push({ width: viewport.width, height: viewport.height, lines });
      page.cleanup();
    }
    return { count: doc.numPages, pages: out };
  } finally {
    await doc.close();
  }
};
${PDF_GRAPHICS_SCRIPT}
handlers.ping = async () => ({ ok: true });
`;

export const PDFVIEW_PAGE = packPage(SCRIPT);
