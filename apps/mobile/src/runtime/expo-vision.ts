import { layoutOcrLines } from '@morph/core';
import { Directory, File, Paths } from 'expo-file-system';

import MorphVision from '../../modules/morph-vision';
import { expoPackFs, expoPackStore } from '../packs/expo-pack-fs';
import { classifyImageWith } from './classify-image';
import { detectDataWith } from './detect-data';
import type { Pixels, VisionPlatform } from './platform';
import { DEWARP_PACK, createFlattener } from './flatten';
import { LAYOUT_PACK, createLayoutDetector } from './layout';
import {
  PPOCR_INPUT_SIDE,
  PPOCR_LANGUAGES,
  PPOCR_PACK,
  coversLanguage,
  createPpocr,
} from './ppocr';
import { ocrPixels, openFlattenPage } from './skia';

// Implementation of VisionPlatform: local Expo module MorphVision (iOS: Vision, D-084; Android: ML
// Kit, D-087). Uses PP-OCRv6 for text recognition (D-269): Chinese, Japanese, English, French,
// German, Spanish, Portuguese, Italian; system-default for remaining languages (iOS Vision, Android
// ML Kit only for Korean). Null when this module is absent (Expo Go).

/** Used exclusively to locate text recognition model files (downloads are handled by the app root layout, D-064); shares the same instance as the root layout (D-510). */
const ocrPacks = expoPackStore;

/** JPG quality after straightening, matching the document camera page. */
const QUALITY = 0.9;

export function expoVision(
  runFileUri: (runId: string, relPath: string) => string,
): VisionPlatform | null {
  const native = MorphVision;
  if (!native) return null;
  const { ocrLoad, ocrDetect, ocrRecognize } = native;
  const ppocr =
    ocrLoad && ocrDetect && ocrRecognize
      ? createPpocr(
          { ocrLoad, ocrDetect, ocrRecognize },
          {
            installed: () => ocrPacks.isInstalled(PPOCR_PACK),
            modelUri: (file) => expoPackFs.uri(ocrPacks.path(PPOCR_PACK, file)),
            readText: (uri) => new File(uri).text(),
            tempDir() {
              const dir = new Directory(Paths.cache, 'ocr', `${Date.now()}-${Math.random()}`);
              dir.create({ idempotent: true, intermediates: true });
              return {
                uri: dir.uri.replace(/\/$/, ''),
                remove: () => {
                  try {
                    dir.delete();
                  } catch {
                    // Already deleted.
                  }
                },
              };
            },
            async write(uri, bytes) {
              const file = new File(uri);
              file.create({ overwrite: true });
              await file.write(bytes);
            },
            read: (uri) => new File(uri).bytes(),
            pixels: async (uri, maxSide) => ocrPixels(await new File(uri).bytes(), maxSide),
          },
        )
      : null;
  const { modelRun } = native;
  // Scan flattening (D-274): the model resides in the extension pack; text line detection and text recognition share the PP-OCRv6 model.
  const flattener = modelRun
    ? createFlattener(
        { modelRun, ...(ocrLoad && ocrDetect ? { ocrLoad, ocrDetect } : {}) },
        {
          installed: (pack) => ocrPacks.isInstalled(pack),
          modelUri: (pack, file) => expoPackFs.uri(ocrPacks.path(pack, file)),
          readFile: (uri) => new File(uri).bytes(),
          async writeFile(uri, bytes) {
            const file = new File(uri);
            file.create({ overwrite: true, intermediates: true });
            await file.write(bytes);
            return bytes.length;
          },
          tempDir() {
            const dir = new Directory(Paths.cache, 'flatten', `${Date.now()}-${Math.random()}`);
            dir.create({ idempotent: true, intermediates: true });
            return {
              uri: dir.uri.replace(/\/$/, ''),
              remove: () => {
                try {
                  dir.delete();
                } catch {
                  // Already deleted.
                }
              },
            };
          },
          open: openFlattenPage,
        },
        { ocrPack: PPOCR_PACK, quality: QUALITY },
      )
    : null;
  // Layout analysis for Word conversion (D-328): runs models from the extension pack via modelRun, identical to flattening.
  const layout = modelRun
    ? createLayoutDetector(
        { modelRun },
        {
          installed: (pack) => ocrPacks.isInstalled(pack),
          modelUri: (pack, file) => expoPackFs.uri(ocrPacks.path(pack, file)),
          readFile: (uri) => new File(uri).bytes(),
          async writeFile(uri, bytes) {
            const file = new File(uri);
            file.create({ overwrite: true, intermediates: true });
            await file.write(bytes);
          },
          tempDir() {
            const dir = new Directory(Paths.cache, 'layout', `${Date.now()}-${Math.random()}`);
            dir.create({ idempotent: true, intermediates: true });
            return {
              uri: dir.uri.replace(/\/$/, ''),
              remove: () => {
                try {
                  dir.delete();
                } catch {
                  // Already deleted.
                }
              },
            };
          },
        },
      )
    : null;
  /** Recognize this group of languages using PP-OCRv6 (the first is the user-selected language). */
  const viaPpocr = (languages: readonly string[]) =>
    ppocr !== null && languages[0] !== undefined && coversLanguage(languages[0]);
  return {
    async adjustImage(uri, settings, format, runId, relPath) {
      if (!native.adjustImage) throw new Error('Image adjustment unavailable');
      const output = runFileUri(runId, relPath);
      return { uri: output, ...(await native.adjustImage(uri, settings, format, output)) };
    },

    backgroundRemovalSupported: native.backgroundRemovalSupported?.() ?? false,
    backgroundStatus: () => native.backgroundStatus?.() ?? Promise.resolve('unsupported'),
    async downloadBackgroundModel() {
      if (native.downloadBackgroundModel) await native.downloadBackgroundModel();
    },
    async removeBackground(uri, background, runId, relPath) {
      if (!native.removeBackground) throw new Error('Background removal unavailable');
      const output = runFileUri(runId, relPath);
      return { uri: output, ...(await native.removeBackground(uri, background, output)) };
    },

    ...(native.detectFaces
      ? {
          detectFaces: (uri: string) => native.detectFaces!(uri),
        }
      : {}),
    ...(native.classifyImage
      ? {
          classifyImage: (uri: string, options?: Parameters<typeof classifyImageWith>[2]) =>
            classifyImageWith(
              { classifyImage: native.classifyImage!, cancelClassify: native.cancelClassify },
              uri,
              options,
            ),
        }
      : {}),
    ...(native.detectData
      ? {
          detectData: (text: string, language: string) =>
            detectDataWith(native.detectData!.bind(native), text, language),
          dataDetectionStatus: async (language: string) =>
            (await native.dataDetectionStatus?.(language)) ?? 'unsupported',
          downloadDataModel: async (language: string) => {
            await native.downloadDataModel?.(language);
          },
        }
      : {}),
    personSegmentation: Boolean(native.replacePersonBackground),
    ...(native.replacePersonBackground || native.removeBackground
      ? {
          async replaceBackground(uri: string, color: string, runId: string, relPath: string) {
            const output = runFileUri(runId, relPath);
            const done = native.replacePersonBackground
              ? await native.replacePersonBackground(uri, color, output)
              : await native.removeBackground!(uri, color, output);
            return { uri: output, ...done };
          },
        }
      : {}),

    supportsLanguage: (code) =>
      (ppocr !== null && coversLanguage(code)) || native.supportsLanguage(code),
    ...(ppocr ? { ocrModel: { pack: PPOCR_PACK, languages: PPOCR_LANGUAGES } } : {}),

    async pdfText(uri) {
      if (!native.pdfText) return null;
      return await native.pdfText(uri);
    },

    async recognizeText(uri, languages) {
      // Format layout according to line positions, re-joining wrapped lines within the same paragraph (D-268); falls back to natively arranged text when positions are absent.
      if (viaPpocr(languages)) return layoutOcrLines((await ppocr!.recognize(uri)).lines);
      const { text, items } = await native.recognizeText(uri, languages);
      return items.length > 0 ? layoutOcrLines(items) : text;
    },

    async recognizeLines(uri, languages, pixels) {
      if (viaPpocr(languages)) {
        const { width, height, lines } = await ppocr!.recognize(uri, pixels);
        return {
          width,
          height,
          lines: lines.map(({ text, x, y, width: w, height: h, chars }) => ({
            text,
            x,
            y,
            width: w,
            height: h,
            ...(chars ? { chars } : {}),
          })),
        };
      }
      const { width, height, items } = await native.recognizeText(uri, languages);
      return { width, height, lines: items };
    },

    // Prompt for flattening model download only when the extension pack URL is configured; still flatten if unconfigured but already installed (simulator testing).
    ...(flattener && process.env.EXPO_PUBLIC_MORPH_PACKS_URL
      ? { flattenModel: { pack: DEWARP_PACK } }
      : {}),
    ...(flattener
      ? {
          async flatten(uri: string, runId: string, relPath: string) {
            const output = runFileUri(runId, relPath);
            const done = await flattener.flatten(uri, output);
            // Execution time for each step (visible in dev build logs for performance profiling on devices).
            if (__DEV__ && done) console.log('[flatten]', JSON.stringify(done.timing));
            return done && { uri: output, ...done };
          },
        }
      : {}),
    // Layout analysis model, similar to the flattening model, prompts for download only when the extension pack URL is configured; used as-is if unconfigured but already installed.
    ...(layout && process.env.EXPO_PUBLIC_MORPH_PACKS_URL
      ? { layoutModel: { pack: LAYOUT_PACK } }
      : {}),
    ...(layout ? { detectLayout: (pixels: Pixels) => layout.detect(pixels) } : {}),
    // Decoded identically to PP-OCRv6 recognition (same size), allowing line detection and character recognition to share a single pixel buffer (D-272).
    tablePixels: async (uri) => ocrPixels(await new File(uri).bytes(), PPOCR_INPUT_SIDE),

    canFindPaper: native.canFindPaper(),

    async findPaper(uri) {
      const { candidates, gray } = await native.detectDocument(uri);
      const data = Uint8Array.from(atob(gray.data), (c) => c.charCodeAt(0));
      return { candidates, gray: { width: gray.width, height: gray.height, data } };
    },

    async straighten(uri, quad, size, runId, relPath) {
      const output = runFileUri(runId, relPath);
      const out = await native.straighten(uri, quad, size.width, size.height, QUALITY, output);
      return { uri: output, ...out };
    },

    documentCamera: native.isDocumentCameraSupported(),

    async scanDocuments(runId, maxSide) {
      const dir = new Directory(Paths.cache, 'runs', runId, 'scanner');
      dir.create({ idempotent: true, intermediates: true });
      const pages = await native.scanDocuments(dir.uri, maxSide, QUALITY);
      if (!pages) return null;
      const now = Date.now();
      return pages.map((p, i) => ({
        uri: p.uri,
        name: `scan-${i + 1}.jpg`,
        size: p.size,
        mimeType: 'image/jpeg',
        width: p.width,
        height: p.height,
        takenAt: now,
        straightened: true,
      }));
    },
  };
}
