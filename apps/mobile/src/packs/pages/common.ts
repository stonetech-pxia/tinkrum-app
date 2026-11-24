// Common parts of pack pages (fixed HTML shipped with the App, not downloaded).
// - CSP blocks all network requests: libraries and input files are supplied on demand by the App
// through the message channel (D-074).
// - Fixed format messages only between page and App: call / result / need / chunk, with no
// model-generated strings injected.
// - Pages may only request files permitted for the current call (checked on App side, see
// PackHost).

/** Page origin (.invalid can never be resolved), allowing blob: URLs to be considered same-origin so Workers and import() can function. */
export const PACK_BASE_URL = 'https://morph-pack.invalid/';

const CSP = [
  "default-src 'none'",
  // OpenCV's embind requires unsafe-eval; all wasms require wasm-unsafe-eval.
  "script-src blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  'worker-src blob:',
  'connect-src blob: data:',
  'img-src blob: data:',
  "style-src 'unsafe-inline'",
  'font-src blob: data:',
].join('; ');

/**
 * pdf.js legacy version patch: Promise.withResolvers (missing below iOS 17.4); when reading text,
 * for await traversal of ReadableStream (iOS WebView cannot traverse, real-device test on
 * 2026-10-31).
 */
export const PDFJS_POLYFILLS =
  'if(!Promise.withResolvers){Promise.withResolvers=function(){let resolve,reject;const promise=new this((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}}\n' +
  "if(typeof ReadableStream!=='undefined'&&!ReadableStream.prototype[Symbol.asyncIterator]){ReadableStream.prototype[Symbol.asyncIterator]=async function*(){const r=this.getReader();try{for(;;){const{done,value}=await r.read();if(done)return;yield value}}finally{r.releaseLock()}}}";

const BRIDGE = String.raw`
const post = (m) => window.ReactNativeWebView.postMessage(JSON.stringify(m));
const blobUrl = (parts, type = 'text/javascript') =>
  URL.createObjectURL(new Blob(Array.isArray(parts) ? parts : [parts], { type }));
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** Classic scripts (UMD, e.g., opencv.js, tesseract.min.js): insert <script> from a blob: URL. */
const loadClassic = (src) => new Promise((resolve, reject) => {
  const el = document.createElement('script');
  el.src = src;
  el.onload = resolve;
  el.onerror = () => reject(new Error('script failed to load'));
  document.head.appendChild(el);
});
/** Decode input file bytes into an image. */
const loadImage = (bytes, type = 'image/jpeg') => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('image could not be decoded'));
  img.src = blobUrl([bytes], type);
});
const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(what + ' timed out')), ms)),
]);
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
let reqId = 0;
const waiting = new Map();
const parts = new Map();
/** Request a file from the App: { pack, path } refers to a file inside the expansion pack, and { file } refers to a file passed into this invocation. */
function need(ref, as) {
  const id = ++reqId;
  post({ t: 'need', id, ref, as });
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject, as }));
}
const handlers = {};
async function onMessage(e) {
  let m;
  try { m = JSON.parse(e.data); } catch (_) { return; }
  if (m.t === 'chunk') {
    const w = waiting.get(m.id);
    if (!w) return;
    if (m.error) { waiting.delete(m.id); w.reject(new Error(m.error)); return; }
    const arr = parts.get(m.id) || [];
    arr[m.i] = m.data;
    parts.set(m.id, arr);
    if (arr.filter((x) => x !== undefined).length === m.n) {
      waiting.delete(m.id);
      parts.delete(m.id);
      const s = arr.join('');
      w.resolve(w.as === 'bytes' ? b64ToBytes(s) : s);
    }
    return;
  }
  if (m.t === 'call') {
    post({ t: 'log', message: 'call ' + m.method });
    const fn = handlers[m.method];
    try {
      if (!fn) throw new Error('unknown method ' + m.method);
      post({ t: 'result', id: m.id, ok: true, value: await fn(m.args || {}) });
    } catch (err) {
      post({ t: 'result', id: m.id, ok: false, error: String((err && err.message) || err) });
    }
  }
}
window.addEventListener('message', onMessage);
document.addEventListener('message', onMessage);
window.onerror = (msg) => post({ t: 'log', message: String(msg) });
window.addEventListener('unhandledrejection', (e) => post({ t: 'log', message: 'unhandled: ' + String(e.reason && e.reason.message || e.reason) }));
`;

/** Generates an extension pack page: public channel + this pack's own handler function (written to handlers). */
export function packPage(script: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<script>${PDFJS_POLYFILLS}</script></head><body><script>
${BRIDGE}
${script}
post({ t: 'ready' });
</script></body></html>`;
}
