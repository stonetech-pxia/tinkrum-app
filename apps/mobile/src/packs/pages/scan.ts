import { packPage } from './common';

// Scan pack page (T5): OpenCV.js 4.7.0 + jscanify 1.4.3, both classic UMD scripts, inserted into
// <script> from blob: URL. OpenCV configuration object must be placed on window.Module before
// loading; cannot await cv (it is an infinite-loop thenable). Edge detection is performed on a copy
// scaled down to 1000 pixels, candidate corner coordinates are scaled back to the original image
// and handed to the App along with a small grayscale image for the user to pick (D-326);
// perspective correction is performed on the original image (the App has already scaled the
// original image below 16.77 megapixels).

const SCRIPT = String.raw`
let scanner = null;
async function ready() {
  if (scanner) return scanner;
  const cvReady = new Promise((resolve) => { window.Module = { onRuntimeInitialized: resolve }; });
  await loadClassic(blobUrl(await need({ pack: 'scan', path: 'src/opencv.js' }, 'text')));
  await withTimeout(cvReady, 60000, 'OpenCV');
  await loadClassic(blobUrl(await need({ pack: 'scan', path: 'src/jscanify.js' }, 'text')));
  scanner = new jscanify();
  return scanner;
}
function canvasOf(img, maxSide) {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { canvas: c, k };
}
// Candidate quadrilaterals for edge finding (D-326): largest contour found by jscanify, plus the
// largest bright region (paper is typically brighter than the background: Otsu binarization,
// largest outer contour after closing, convex hull approximated as a quadrilateral). The App
// decides which one to pick (@morph/tool-image's pickPaper); each candidate consists of four points
// (order unspecified), with coordinates in mat.
function paperCandidates(s, mat) {
  const out = [];
  const contour = s.findPaperContour(mat);
  const p = contour ? s.getCornerPoints(contour, mat) : null;
  if (contour) contour.delete();
  if (p && p.topLeftCorner && p.topRightCorner && p.bottomRightCorner && p.bottomLeftCorner) {
    out.push([p.topLeftCorner, p.topRightCorner, p.bottomRightCorner, p.bottomLeftCorner]);
  }
  const gray = new cv.Mat();
  const mask = new cv.Mat();
  const kernel = cv.Mat.ones(15, 15, cv.CV_8U);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const hull = new cv.Mat();
  const approx = new cv.Mat();
  try {
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.threshold(gray, mask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area > bestArea) {
        if (best) best.delete();
        best = c;
        bestArea = area;
      } else c.delete();
    }
    if (best) {
      cv.convexHull(best, hull);
      best.delete();
      const length = cv.arcLength(hull, true);
      for (const eps of [0.02, 0.03, 0.05]) {
        cv.approxPolyDP(hull, approx, eps * length, true);
        if (approx.rows === 4) {
          const d = approx.data32S;
          out.push([0, 1, 2, 3].map((j) => ({ x: d[2 * j], y: d[2 * j + 1] })));
          break;
        }
      }
    }
  } finally {
    for (const m of [gray, mask, kernel, contours, hierarchy, hull, approx]) m.delete();
  }
  return out;
}
// Small grayscale image for the App to evaluate candidates (maximum side maxSide).
function grayThumb(mat, maxSide) {
  const g = new cv.Mat();
  try {
    cv.cvtColor(mat, g, cv.COLOR_RGBA2GRAY);
    const k = Math.min(1, maxSide / Math.max(g.cols, g.rows));
    cv.resize(g, g, new cv.Size(Math.max(1, Math.round(g.cols * k)), Math.max(1, Math.round(g.rows * k))), 0, 0, cv.INTER_AREA);
    return { width: g.cols, height: g.rows, data: bytesToB64(g.data) };
  } finally {
    g.delete();
  }
}
handlers.detect = async ({ file, maxSide }) => {
  const s = await ready();
  const img = await loadImage(await need({ file }, 'bytes'));
  const { canvas, k } = canvasOf(img, maxSide || 1000);
  const mat = cv.imread(canvas);
  try {
    const back = (pt) => ({ x: pt.x / k, y: pt.y / k });
    const candidates = paperCandidates(s, mat).map((pts) => pts.map(back));
    return { width: img.naturalWidth, height: img.naturalHeight, candidates, gray: grayThumb(mat, 500) };
  } finally {
    mat.delete();
    canvas.width = canvas.height = 0;
  }
};
handlers.warp = async ({ file, quad, width, height, quality }) => {
  await ready();
  const img = await loadImage(await need({ file }, 'bytes'));
  const { canvas } = canvasOf(img, Math.max(img.naturalWidth, img.naturalHeight));
  const src = cv.imread(canvas);
  canvas.width = canvas.height = 0;
  const dst = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [
    quad.tl.x, quad.tl.y, quad.tr.x, quad.tr.y, quad.br.x, quad.br.y, quad.bl.x, quad.bl.y,
  ]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
  const m = cv.getPerspectiveTransform(from, to);
  const out = document.createElement('canvas');
  try {
    cv.warpPerspective(src, dst, m, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    cv.imshow(out, dst);
    return { width: out.width, height: out.height, data: out.toDataURL('image/jpeg', quality).split(',')[1] };
  } finally {
    for (const x of [src, dst, from, to, m]) x.delete();
    out.width = out.height = 0;
  }
};
handlers.ping = async () => ({ ok: true });
`;

export const SCAN_PAGE = packPage(SCRIPT);
