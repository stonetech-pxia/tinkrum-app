// Assemble single-page sources from pages/<suite>/ into pdfs/<suite>.pdf, and write
// pdfs/<suite>.json (page number to case mapping and source sha256). Sources are sorted by filename
// (NN-casename.extension): .html Chrome print to PDF (digital PDF: has text layer and vector lines)
// .scan.html Print first, then rasterize to 200dpi image, slightly skew, add minor noise, and keep
// as image only (simulating scanned documents) .pdf Take the first page directly (one page clipped
// from a public document) .jpg/.png Image filling the page (photos, scanned documents) Usage: npx
// tsx tests/word-regression/build-pdfs.ts [suite-names...]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PDFDocument } from 'pdf-lib';

import { ENV, HERE, need } from './lib/env';
import { CK, decode } from './lib/ocr';
import { pdfClient } from './lib/pdfjs';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const suites = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(`${HERE}/pages`, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

const tmp = mkdtempSync(join(tmpdir(), 'word-regression-'));
const client = await pdfClient();

function printHtml(file: string): Uint8Array {
  const out = join(tmp, `${sha(Buffer.from(file)).slice(0, 12)}.pdf`);
  execFileSync(
    need(ENV.chrome, 'Chrome'),
    [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--print-to-pdf=${out}`,
      `file://${file}`,
    ],
    { stdio: 'ignore', timeout: 60000 },
  );
  return new Uint8Array(readFileSync(out));
}

/** Rasterize, skew, and add noise: the same source yields the exact same bytes every time (noise uses a fixed seed). */
async function scanOf(pdf: Uint8Array, seed: string) {
  const file = join(tmp, `${seed}.pdf`);
  writeFileSync(file, pdf);
  const [page] = await client.call<{ data: string; paper: { width: number; height: number } }[]>(
    'render',
    { file: 'input', maxSide: 2339, quality: 0.95, pages: [0] },
    { input: file },
  );
  const im = decode(Buffer.from(page!.data, 'base64'));
  const w = im.width();
  const h = im.height();
  const s = CK.MakeSurface(w, h);
  const c = s.getCanvas();
  c.clear(CK.Color(250, 249, 245, 1));
  c.save();
  c.rotate(0.6, w / 2, h / 2);
  c.drawImage(im, 0, 0, null);
  c.restore();
  s.flush();
  const snap = s.makeImageSnapshot();
  const px = new Uint8Array(
    snap.readPixels(0, 0, {
      width: w,
      height: h,
      colorType: CK.ColorType.RGBA_8888,
      alphaType: CK.AlphaType.Unpremul,
      colorSpace: CK.ColorSpace.SRGB,
    }),
  );
  let r = parseInt(seed.slice(0, 8), 16) || 1;
  for (let i = 0; i < px.length; i += 4) {
    r = (r * 1103515245 + 12345) & 0x7fffffff;
    const n = ((r >> 16) % 17) - 8;
    for (let k = 0; k < 3; k++) px[i + k] = Math.max(0, Math.min(255, px[i + k]! + n));
  }
  const noisy = CK.MakeImage(
    {
      width: w,
      height: h,
      colorType: CK.ColorType.RGBA_8888,
      alphaType: CK.AlphaType.Unpremul,
      colorSpace: CK.ColorSpace.SRGB,
    },
    px,
    w * 4,
  );
  const jpg = noisy.encodeToBytes(CK.ImageFormat.JPEG, 80);
  noisy.delete();
  snap.delete();
  s.dispose();
  im.delete();
  return { jpg: new Uint8Array(jpg), paper: page!.paper };
}

try {
  for (const suite of suites) {
    const dir = `${HERE}/pages/${suite}`;
    const out = await PDFDocument.create();
    const manifest: { page: number; id: string; source: string; sha256: string }[] = [];
    for (const f of readdirSync(dir)
      .filter((f) => !f.startsWith('.'))
      .sort()) {
      const m = /^\d+-(.+?)(\.scan)?\.(html|pdf|jpg|png)$/.exec(f);
      if (!m) continue;
      const [, id, scan, ext] = m as unknown as [string, string, string | undefined, string];
      const path = `${dir}/${f}`;
      const bytes = new Uint8Array(readFileSync(path));
      if (ext === 'html' && !scan) {
        const src = await PDFDocument.load(printHtml(path));
        const [p] = await out.copyPages(src, [0]);
        out.addPage(p!);
      } else if (ext === 'pdf') {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const [p] = await out.copyPages(src, [0]);
        out.addPage(p!);
      } else {
        let jpg: Uint8Array;
        let paper: { width: number; height: number };
        if (ext === 'html') {
          ({ jpg, paper } = await scanOf(printHtml(path), sha(bytes)));
        } else {
          const im = decode(bytes);
          paper = { width: 595, height: (595 * im.height()) / im.width() };
          im.delete();
          jpg = bytes;
        }
        const page = out.addPage([paper.width, paper.height]);
        const image = ext === 'png' ? await out.embedPng(jpg) : await out.embedJpg(jpg);
        page.drawImage(image, { x: 0, y: 0, width: paper.width, height: paper.height });
      }
      manifest.push({ page: out.getPageCount(), id, source: f, sha256: sha(bytes) });
    }
    // Fixed metadata so the same source produces identical bytes.
    const epoch = new Date('2026-01-01T00:00:00Z');
    out.setCreationDate(epoch);
    out.setModificationDate(epoch);
    out.setProducer('word-regression');
    out.setCreator('word-regression');
    writeFileSync(`${HERE}/pdfs/${suite}.pdf`, await out.save({ useObjectStreams: false }));
    writeFileSync(`${HERE}/pdfs/${suite}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`${suite}.pdf: ${manifest.length} pages`);
  }
} finally {
  await client.close();
  rmSync(tmp, { recursive: true, force: true });
}
