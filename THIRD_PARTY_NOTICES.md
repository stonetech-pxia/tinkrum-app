# Third-party notices

Tinkrum is AGPL-3.0-only (`LICENSE`). It includes or downloads the third-party code, models, fonts and data below. Every license here allows commercial use and redistribution inside the app, as long as the copyright and license texts travel with it. Where the full text lives is given per item. The app itself has no page listing these yet (see `docs/RELEASE.md`).

## Native libraries compiled into the app

| Library                       | Version               | License           | Text in the repository                                           |
| ----------------------------- | --------------------- | ----------------- | ---------------------------------------------------------------- |
| LAME (MP3 encoder)            | 3.100                 | LGPL-2.0-or-later | `apps/mobile/modules/morph-media/lame/COPYING`, `LICENSE`        |
| libebur128                    | 1.2.6                 | MIT               | `apps/mobile/modules/morph-media/dsp/notices/LibEbur128-MIT.txt` |
| R128 scan code in libebur128  | 1.2.6                 | MIT               | `apps/mobile/modules/morph-media/dsp/notices/R128Scan-MIT.txt`   |
| BSD `queue.h`                 | from libebur128 1.2.6 | BSD-3-Clause      | `apps/mobile/modules/morph-media/dsp/notices/BSD-Queue.txt`      |
| RNNoise and its default model | 0.2                   | BSD-3-Clause      | `apps/mobile/modules/morph-media/dsp/notices/RNNoise-BSD.txt`    |

LAME is linked statically. The LGPL allows that because the whole app's source is published, so anyone can replace LAME and rebuild (`apps/mobile/modules/morph-media/lame/README.md`).

## Fonts bundled in the app

Inter, Karla and Sora, from `@expo-google-fonts` 0.4.2: the fonts are under the SIL Open Font License 1.1 and the package code is MIT. The texts are in each package's `LICENSE_FONT` and `LICENSE`.

## Extension packs

Some packs ship inside the app; the others are downloaded when the user agrees. Each pack's files include its license text, and the download prompt names the license (`packages/core/src/packs.ts`, field `license`). The licenses below were checked against the publishers' pages on 2026-11-22.

| Pack                                          | Contents                                                                  | License                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `scan` (inside the Android app)               | jscanify 1.4.3, OpenCV.js 4.7.0                                           | MIT; Apache-2.0                                                                                               |
| `ppocr` (inside the app)                      | PaddleOCR PP-OCRv6 small, ONNX by light-ocr 0.3.4                         | Apache-2.0                                                                                                    |
| `pdfview` (inside the app)                    | pdf.js 6.4.299; its cmaps, fonts and decoders                             | Apache-2.0; BSD                                                                                               |
| `dewarp` (inside the app)                     | UVDoc grid model, ONNX by PaddlePaddle                                    | Apache-2.0 for the ONNX conversion, MIT for UVDoc and its datasets (Tanguy Magne); both texts are in the pack |
| `layout` (inside the app)                     | PaddlePaddle PP-DocLayout-S                                               | Apache-2.0                                                                                                    |
| `prefill-model`                               | Qwen3.5-2B (Qwen), GGUF Q4_K_M by unsloth                                 | Apache-2.0                                                                                                    |
| `ocr`, `ocr-*`                                | tesseract.js 7.0.0, tesseract.js-core 7.0.0, tessdata_best 4.0.0_best_int | Apache-2.0                                                                                                    |
| `speech-vad`                                  | Silero VAD, ggml conversion by whisper.cpp                                | MIT                                                                                                           |
| `speech-whisper-small`, `speech-whisper-base` | OpenAI Whisper, ggml q5_1 by whisper.cpp                                  | MIT                                                                                                           |

## JavaScript dependencies

The app bundles npm packages. `npm run check:licenses` (`scripts/check-licenses.mjs`) checks that every installed package uses a license from its allow-list. Each package's license text is in its folder under `node_modules`.

## Data

`packages/core/src/prefill/card-names-data.ts` holds a list of common first names, used on the device to recognise a person's name on a business card. It contains the names only, merged and without counts. It comes from:

- INSEE, "Fichier des prénoms" (France). Licence Ouverte / Open Licence 2.0. https://www.insee.fr/
- INE, "Nombres y apellidos" (Spain). Source: Instituto Nacional de Estadística. https://www.ine.es/
- popular-names-by-country-dataset by sigpwned. CC0-1.0. https://github.com/sigpwned/popular-names-by-country-dataset
