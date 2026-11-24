import { requireOptionalNativeModule } from 'expo';

// Local Expo module MorphVision (D-084, D-087): iOS is ios/MorphVisionModule.swift (Vision),
// Android is android/…/MorphVisionModule.kt (ML Kit). Returns null in Expo Go and tests; callers
// fall back to the pack. Coordinates: pixels, origin at top-left, consistent with Quad in
// @morph/tool-image.

export interface NativePoint {
  x: number;
  y: number;
}

export interface NativeQuad {
  tl: NativePoint;
  tr: NativePoint;
  br: NativePoint;
  bl: NativePoint;
}

export interface NativeImage {
  uri: string;
  width: number;
  height: number;
  size: number;
}

/** Native-side error codes (error.code). */
export const VISION_ERRORS = {
  /** Cancelled via cancelClassify(taskId). */
  cancelled: 'ERR_VISION_CANCELLED',
  /** detectData: Entity recognition model for this language is not yet downloaded on Android (either downloads are disallowed, or there is no network). */
  needsDownload: 'ERR_VISION_NEEDS_DOWNLOAD',
} as const;

/** Date or amount recognized by the system: position within the full text (UTF-16); date value is YYYY-MM-DD, amount value is optional. */
export interface NativeDataMatch {
  kind: 'amount' | 'date';
  start: number;
  end: number;
  value?: string;
}

/** An image classification label: id is the platform's own English identifier (iOS Vision and Android ML Kit have different vocabularies). */
export interface NativeImageLabel {
  id: string;
  /** 0–1。 */
  confidence: number;
}

export interface MorphVisionModule {
  adjustImage?(
    uri: string,
    options: { mode: 'auto' | 'manual'; brightness: number; contrast: number; saturation: number },
    format: 'jpeg' | 'png',
    output: string,
  ): Promise<Omit<NativeImage, 'uri'>>;

  backgroundRemovalSupported?(): boolean;
  backgroundStatus?(): Promise<'ready' | 'download' | 'unsupported'>;
  downloadBackgroundModel?(): Promise<void>;
  removeBackground?(
    uri: string,
    background: string,
    output: string,
  ): Promise<Omit<NativeImage, 'uri'>>;

  /** Face bounding boxes (pixels, origin at top-left, straightened); width/height are the dimensions of the image used for detection (Android scales down first, D-252). */
  detectFaces?(uri: string): Promise<{
    width: number;
    height: number;
    faces: { x: number; y: number; width: number; height: number }[];
  }>;
  /**
   * What is in the photo (used for recommendations on photos without text): iOS uses Vision's
   * VNClassifyImageRequest, Android uses ML Kit image labeling (base model bundled into the app).
   * Scales down to maxSide 1024 before classification, without writing intermediate files.
   * Returns at most maxResults items with confidence no less than minConfidence, ordered from
   * highest to lowest; width/height are the dimensions of the image used for classification.
   * taskId is used for cancelClassify. Older development builds lack these two methods.
   */
  classifyImage?(
    taskId: string,
    uri: string,
    options: { maxResults: number; minConfidence: number },
  ): Promise<{ labels: NativeImageLabel[]; width: number; height: number }>;
  /**
   * System recognition for "Log an expense" prefill (acting only as a rule supplement): iOS 26+
   * uses DataDetection (dates, amounts), earlier iOS uses NSDataDetector (dates only); Android
   * uses ML Kit entity recognition (model for each language downloaded on first use; not
   * downloaded when allowDownload is false, terminating with ERR_VISION_NEEDS_DOWNLOAD). language
   * is BCP 47.
   */
  detectData?(text: string, language: string, allowDownload: boolean): Promise<NativeDataMatch[]>;
  /** ready: ready to use directly; download: model needs to be downloaded first (Android); unsupported: language is not supported. */
  dataDetectionStatus?(language: string): Promise<'ready' | 'download' | 'unsupported'>;
  /** Download the recognition model for this language (Android; does nothing on iOS). Called by the app only after prompting the user. */
  downloadDataModel?(language: string): Promise<void>;
  /** Cancel an ongoing classification: that operation terminates with ERR_VISION_CANCELLED; has no effect if it hasn't started or has already finished. */
  cancelClassify?(taskId: string): void;
  /** Keep only the portrait, replacing the rest with a solid color (iOS portrait segmentation, D-252); Android does not have this, uses removeBackground. */
  replacePersonBackground?(
    uri: string,
    color: string,
    output: string,
  ): Promise<Omit<NativeImage, 'uri'>>;

  /** Whether the system document camera is available (false on simulators and very old devices). */
  isDocumentCameraSupported(): boolean;
  /** Whether a camera is present (none on simulators). */
  isCameraAvailable(): boolean;
  /** Whether the four corners of a paper can be found in a photo (supported on iOS, not supported by Android ML Kit: detectDocument / straighten do not exist). */
  canFindPaper(): boolean;
  /**
   * PDF first-page thumbnail (D-451): white-background JPEG written to output, long side not
   * exceeding maxSide. Throws when it cannot be opened (damaged, password-protected). iOS uses
   * PDFKit, Android uses PdfRenderer.
   */
  pdfThumbnail(
    uri: string,
    output: string,
    maxSide: number,
  ): Promise<{ width: number; height: number; pageCount: number }>;
  /**
   * PDF text layer (D-455): iOS PDFKit, or page text from PdfRenderer on Android 15+; null if
   * there is no text layer, if a password is required, or if the system is too old. Older app
   * versions lack this function.
   */
  pdfText?(uri: string): Promise<string | null>;
  /** Whether the system can recognize this language (BCP 47) (only Korean uses ML Kit on Android, D-269). */
  supportsLanguage(code: string): boolean;

  /**
   * PP-OCRv6 (D-269): loads two models from the pack; inputs and outputs are temporary files
   * (float32 little-endian). ocrDetect writes probability × 255 per pixel (width × height bytes);
   * ocrRecognize writes count × steps int32 categories followed by count × steps float32
   * probabilities, and returns steps. Undefined in older app versions (missing in the native
   * module).
   */
  ocrLoad?(det: string, rec: string): Promise<void>;
  ocrDetect?(input: string, width: number, height: number, output: string): Promise<void>;
  ocrRecognize?(input: string, count: number, width: number, output: string): Promise<number>;
  ocrUnload?(): Promise<void>;
  /**
   * Run a model with a single float32 input and a single float32 output (D-274: scan-flattened
   * UVDoc grid model): inputs and outputs are temporary files (float32 little-endian), returning
   * the output shape. Undefined if missing in older app versions.
   */
  modelRun?(model: string, input: string, shape: number[], output: string): Promise<number[]>;
  modelUnload?(): Promise<void>;
  supportedLanguages(): Promise<string[]>;
  /** languages: BCP 47, the first must be supported, and subsequent ones are supplementary. */
  recognizeText(
    uri: string,
    languages: readonly string[],
  ): Promise<{
    text: string;
    lines: number;
    languages: string[];
    /** Pixel dimensions of the image during recognition and the positions of each line (origin at top-left, D-195). */
    width: number;
    height: number;
    items: { text: string; x: number; y: number; width: number; height: number }[];
  }>;
  /**
   * Find paper candidates (D-327): document segmentation quadrilateral and rectangle detection
   * quadrilaterals (pixels, four points tl/tr/br/bl), plus a grayscale image with a long side of
   * about 500 (one byte per pixel, base64). The selection is determined by the app's pickPaper.
   */
  detectDocument(uri: string): Promise<{
    width: number;
    height: number;
    candidates: { x: number; y: number }[][];
    gray: { width: number; height: number; data: string };
  }>;
  straighten(
    uri: string,
    quad: NativeQuad,
    width: number,
    height: number,
    quality: number,
    output: string,
  ): Promise<{ width: number; height: number; size: number }>;
  /** Open the system document camera (iOS: VisionKit; Android: ML Kit, requires Google Play Services); returns null if the user cancels. */
  scanDocuments(directory: string, maxSide: number, quality: number): Promise<NativeImage[] | null>;
}

export default requireOptionalNativeModule<MorphVisionModule>('MorphVision');
