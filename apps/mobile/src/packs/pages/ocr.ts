import { packPage } from './common';

// OCR pack page (T5): tesseract.js 7.0.0, fully offline (research notes pack-manifests §4).
// - tesseract.min.js is the classic script; worker is a Blob: preamble script + core (.wasm.js,
// embedded wasm) + worker.min.js. The core's top-level var defines TesseractCore so the worker does
// not importScripts again.
// - worker uses global fetch to fetch language data: preamble script replaces self.fetch with "wait
// for the page to send bytes".
// - createWorker synchronously creates the thread: temporarily wraps window.Worker to get the
// thread and passes language data as a transferable object.
// - createWorker never returns if language loading fails, so a timeout is required. Uses LSTM only
// (OEM 1), not cached to IndexedDB.

const SCRIPT = String.raw`
let tesseractLoaded = false;
let workerUrl = null;
let worker = null;
let workerLang = null;
const packOf = (lang) => 'ocr-' + lang.replace('_', '-');
function morphPrelude() {
  const files = new Map();
  const waiters = new Map();
  self.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__morph !== 'file') return;
    e.stopImmediatePropagation();
    const w = waiters.get(d.name);
    if (w) { waiters.delete(d.name); w(d.bytes); } else files.set(d.name, d.bytes);
  });
  self.fetch = (url) => new Promise((resolve) => {
    const name = String(url).split('/').pop();
    const hit = (b) => resolve(new Response(b, { status: 200 }));
    if (files.has(name)) { const b = files.get(name); files.delete(name); hit(b); } else waiters.set(name, hit);
  });
}
async function prepare() {
  if (!tesseractLoaded) {
    await loadClassic(blobUrl(await need({ pack: 'ocr', path: 'tesseract.min.js' }, 'text')));
    tesseractLoaded = true;
  }
  if (!workerUrl) {
    // SIMD byte detection identical to wasm-feature-detect.
    const simd = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]));
    const core = await need({ pack: 'ocr', path: simd ? 'core/tesseract-core-simd-lstm.wasm.js' : 'core/tesseract-core-lstm.wasm.js' }, 'text');
    workerUrl = blobUrl(['(' + morphPrelude.toString() + ')();\n', core, '\n;\n', await need({ pack: 'ocr', path: 'worker.min.js' }, 'text')]);
  }
}
async function workerFor(lang) {
  if (worker && workerLang === lang) return worker;
  if (worker) { await worker.terminate().catch(() => undefined); worker = null; workerLang = null; }
  await prepare();
  const data = await need({ pack: packOf(lang), path: lang + '.traineddata.gz' }, 'bytes');
  const RealWorker = window.Worker;
  let thread = null;
  window.Worker = class extends RealWorker { constructor(u, o) { super(u, o); thread = this; } };
  let ready;
  try {
    ready = Tesseract.createWorker([lang], 1, {
      workerPath: workerUrl,
      workerBlobURL: false,
      corePath: 'embedded/tesseract-core-lstm.wasm.js',
      langPath: 'https://morph-pack.invalid/tessdata',
      cacheMethod: 'none',
      gzip: true,
      legacyCore: false,
      legacyLang: false,
      errorHandler: (err) => post({ t: 'log', message: 'ocr worker: ' + String(err) }),
    });
  } finally {
    window.Worker = RealWorker;
  }
  if (!thread) throw new Error('worker was not created');
  thread.postMessage({ __morph: 'file', name: lang + '.traineddata.gz', bytes: data }, [data.buffer]);
  worker = await withTimeout(ready, 90000, 'text recognition');
  workerLang = lang;
  return worker;
}
handlers.recognize = async ({ file, lang }) => {
  const w = await workerFor(lang);
  const bytes = await need({ file }, 'bytes');
  const { data } = await w.recognize(new Blob([bytes], { type: 'image/jpeg' }));
  return { text: data.text || '', confidence: data.confidence || 0 };
};
handlers.ping = async () => ({ ok: true });
`;

export const OCR_PAGE = packPage(SCRIPT);
