import type { GrayImage, Point, Quad } from '@morph/tool-image';
import type { DocDoc, LayoutRegion } from '@morph/tool-office';
import type { TextLayer, TextLine } from '@morph/tool-pdf';

import type { DeskFs } from '../desk/fs';
import type { SpeechPlatform } from './speech';

/** Recognized text line; PP-OCRv6 also provides approximate character positions (at: proportion within the line, D-272). */
export interface RecognizedLine extends TextLine {
  chars?: readonly { text: string; at: number }[];
}

/** Recognized lines in an image (width / height represent image dimensions during OCR). */
export interface RecognizedLayer extends TextLayer {
  lines: readonly RecognizedLine[];
}

/** RGBA pixels (4 bytes per pixel). */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

// Platform capabilities (implemented via Expo modules in the app, see expo-platform.ts; in-memory
// implementation in test-utils/fake-files.ts for tests). Action implementations access the file
// system and system interfaces exclusively through here.

export interface PickedFile {
  uri: string;
  name: string;
  size: number | null;
  mimeType: string | null;
  width?: number;
  height?: number;
  /** Photo capture timestamp (milliseconds). */
  takenAt?: number;
  /** File modification timestamp (milliseconds, present for files selected from the Files app, D-242). */
  modifiedAt?: number;
  /** Page captured by system document camera: border-detected and deskewed. */
  straightened?: boolean;
  /** Duration of video or audio (milliseconds), when available from the picker. */
  durationMs?: number;
  /** The copy saved to the document library when opening or sharing (D-455): stored directly as records etc. without re-copying. */
  assetId?: string;
  /**
   * Intermediate format for Word on the desk (D-466, images already converted to readable URIs):
   * passed into the run (RunItem.docDoc), document-to-PDF formatting follows its layout rather
   * than relying on generic Word layout (which causes misalignment and font-size loss on
   * Android).
   */
  docDoc?: DocDoc;
}

export type ImageFormat = 'jpeg' | 'png' | 'webp';

/** Scan enhancement (D-266, Skia): auto (shadow removal, page-based color/grayscale selection), grayscale, black and white. */
export type EnhanceMode = 'auto' | 'gray' | 'bw';

/** A single image operation: crop first (original image pixel coordinates), then scale, then rotate/flip. */
export interface ImageOps {
  crop?: { x: number; y: number; width: number; height: number };
  resize?: { width: number; height: number };
  rotate?: 0 | 90 | 180 | 270;
  flip?: 'horizontal' | 'vertical';
}

export interface EncodedImage {
  uri: string;
  width: number;
  height: number;
  size: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A step in offscreen compositing (collages, pixelation/censoring, watermarks, photo print
 * layouts). Only fixed types of drawing are performed, with no configuration code execution.
 * Image sources are temporary files from the current run or freshly drawn bytes (text
 * watermarks).
 */
export type DrawOp =
  | {
      kind: 'image';
      source: { uri: string } | { bytes: Uint8Array };
      /** Which part of the source image to extract (in pixels); defaults to the entire image. */
      src?: Box;
      dst: Box;
      /** Rotation angle (in degrees) around the destination center. */
      angleDeg?: number;
      /** 0–1。 */
      opacity?: number;
    }
  | { kind: 'rect'; rect: Box; color: string }
  /** Blur this region on the canvas (censoring/pixelation). */
  | { kind: 'blur'; rect: Box; sigma: number }
  | { kind: 'path'; points: { x: number; y: number }[]; color: string; width: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number };

/** User-saved signature (documentDirectory/signatures/, excluded from configuration and versions, never sent to AI). */
export interface SavedSignature {
  uri: string;
  bytes: Uint8Array;
  aspect: number;
}

/**
 * System-native text recognition and scanning (modules/morph-vision): iOS uses Vision / VisionKit
 * / Core Image (D-084–D-086), Android uses Google ML Kit (D-087). Returns null when unavailable
 * (e.g. Expo Go). Capabilities unsupported by the system (Android edge detection, Russian OCR)
 * fall back to extension packs. All processing is local.
 */
export interface ImageAdjustSettings {
  mode: 'auto' | 'manual';
  brightness: number;
  contrast: number;
  saturation: number;
}

/** Flattened page (D-274): same size as input; refined indicates it was post-processed by text lines (OCR model installed, sufficient text lines). */
export interface FlattenResult {
  uri: string;
  width: number;
  height: number;
  size: number;
  refined: boolean;
  /** Duration of each step in milliseconds, used for performance profiling. */
  timing: Record<string, number>;
}

/** System-recognized date or amount (VisionPlatform.detectData), identical to SystemMatch pre-filled by @morph/core. */
export interface SystemDataMatch {
  kind: 'amount' | 'date';
  start: number;
  end: number;
  value?: string;
}

/** An image classification label (VisionPlatform.classifyImage). */
export interface ImageLabel {
  id: string;
  /** 0–1。 */
  confidence: number;
}

export interface VisionPlatform {
  adjustImage(
    uri: string,
    settings: ImageAdjustSettings,
    format: 'jpeg' | 'png',
    runId: string,
    relPath: string,
  ): Promise<EncodedImage>;

  readonly backgroundRemovalSupported: boolean;
  backgroundStatus(): Promise<'ready' | 'download' | 'unsupported'>;
  downloadBackgroundModel(): Promise<void>;
  removeBackground(
    uri: string,
    background: string,
    runId: string,
    relPath: string,
  ): Promise<EncodedImage>;

  /**
   * ID photo (D-252): face detection. Coordinates are pixels on a width × height image (already
   * oriented, Android scales down first), and callers scale them back relative to the original
   * image. Absent when this capability is not available.
   */
  detectFaces?(uri: string): Promise<{ width: number; height: number; faces: Box[] }>;
  /**
   * What is in the photo (used for recommendations on photos without text, not yet integrated
   * into recommendations): labels are platform-specific English identifiers, ordered from highest
   * to lowest confidence, including only those at or above minConfidence. When signal is
   * cancelled, the Promise immediately rejects with a cancelled error code, without waiting for
   * native completion. Absent when this capability is not available (older development builds).
   */
  classifyImage?(
    uri: string,
    options?: { maxResults?: number; minConfidence?: number; signal?: AbortSignal },
  ): Promise<ImageLabel[]>;
  /**
   * System recognition used for "log an expense" pre-filling (D-244, strictly a rule supplement,
   * not yet integrated into expenses): locations of dates and amounts in the text. Does not
   * download models; returns empty if system capabilities are lacking, the model is not
   * downloaded, or an error occurs (uses rules only).
   */
  detectData?(text: string, language: string): Promise<SystemDataMatch[]>;
  /** System recognition status for this language: ready for use; download requires downloading the model first (prompting the user); unsupported is not supported. */
  dataDetectionStatus?(language: string): Promise<'ready' | 'download' | 'unsupported'>;
  /** Download the recognition model (Android); called only after user consent. */
  downloadDataModel?(language: string): Promise<void>;
  /**
   * ID photo background replacement (D-252): preserves the person, replaces the rest with a solid
   * color, outputs PNG. iOS uses person segmentation (since iOS 15), Android uses subject
   * segmentation (same model as background removal, requires Google Play Services).
   */
  replaceBackground?(
    uri: string,
    color: string,
    runId: string,
    relPath: string,
  ): Promise<EncodedImage>;
  /** replaceBackground uses system-native person segmentation (iOS) without requiring prior confirmation to download a model (unlike Android subject segmentation). */
  readonly personSegmentation?: boolean;

  /** Whether this device can recognize text in this language (BCP 47) (PP-OCRv6 languages require downloading a model first, see ocrModel). */
  supportsLanguage(code: string): boolean;
  /**
   * Text recognition model (D-269): these languages (BCP 47 language subtag) are recognized using
   * PP-OCRv6 and require downloading the pack extension first; remaining languages use
   * system-native OCR (iOS Vision, Android uses ML Kit only for Korean). Older app versions
   * lacking native model interfaces do not have this property.
   */
  readonly ocrModel?: { pack: string; languages: readonly string[] };
  /** Recognize text; languages is BCP 47, with the first being the user-selected language. Text is returned only to the app. */
  recognizeText(uri: string, languages: readonly string[]): Promise<string>;
  /**
   * PDF text layer (D-455): iOS PDFKit, Android 15+ PdfRenderer; null when there is no text layer
   * or system support. Text is returned only to the app.
   */
  pdfText?(uri: string): Promise<string | null>;
  /**
   * Recognize text and provide line positions (searchable PDF text layer, D-195). pixels are
   * already-decoded pixels of the same image (provided by tablePixels), used directly by PP-OCRv6
   * without re-decoding (for Excel conversion, D-272).
   */
  recognizeLines(
    uri: string,
    languages: readonly string[],
    pixels?: Pixels,
  ): Promise<RecognizedLayer>;
  /** Excel conversion (D-272): decodes to recognition size (long side under 2000), used for finding table lines; absent if Skia is unavailable. */
  tablePixels?(uri: string): Promise<Pixels>;
  /**
   * Scan flattening model (D-274): present only when extension pack download URL is configured,
   * prompting to download the pack during scanning (scanning works without downloading). When no
   * download URL is configured but the pack is already installed (simulator testing), flatten
   * works normally without download prompts.
   */
  readonly flattenModel?: { pack: string };
  /**
   * Flatten an unwarped page (D-274): UVDoc estimates warping, and if an OCR model is installed,
   * it further refines by text lines, performing only a single resampling. Returns null if the
   * flattening model is not installed (scans normally without flattening).
   */
  flatten?(uri: string, runId: string, relPath: string): Promise<FlattenResult | null>;
  /**
   * Layout analysis model for Word conversion (D-328): present only when extension pack download
   * URL is configured, prompting to download the pack during Word conversion (optional: converts
   * without downloading, but without distinguishing titles and images).
   */
  readonly layoutModel?: { pack: string };
  /** Layout regions for a page (coordinates match pixels, where pixels are provided by tablePixels); returns null if the model is not installed. */
  detectLayout?(pixels: Pixels): Promise<LayoutRegion[] | null>;
  /** Whether edge detection and straightening (findPaper / straighten) can be performed on photos; Android ML Kit cannot. */
  readonly canFindPaper: boolean;
  /**
   * Finds paper candidate quadrilaterals (pixels, oriented according to shooting orientation;
   * four points in arbitrary order) and a small grayscale image; which one to pick is determined
   * by the app's pickPaper, same as the scanning pack (D-326, D-327).
   */
  findPaper(uri: string): Promise<{ candidates: Point[][]; gray: GrayImage }>;
  /** Straightens based on four corners, scales to size, and saves as a temporary JPG file for the current run. */
  straighten(
    uri: string,
    quad: Quad,
    size: { width: number; height: number },
    runId: string,
    relPath: string,
  ): Promise<EncodedImage>;
  /** Whether the system document camera is available (unavailable on simulators). */
  readonly documentCamera: boolean;
  /** Opens the system document camera (real-time edge detection, auto-capture, multi-page), placing pages into the temporary directory of the current run; returns null if cancelled by the user. */
  scanDocuments(runId: string, maxSide: number): Promise<PickedFile[] | null>;
}

/**
 * System-native local translation (modules/morph-translate, D-170): iOS uses the Translation
 * framework (since iOS 18), Android uses ML Kit (language model downloaded on first use, ~30 MB).
 * Languages use BCP 47. Null when native modules are absent (Expo Go). Text is processed entirely
 * locally, never uploaded or sent to AI.
 */
export interface TranslatePlatform {
  /** Whether this device can translate (iOS 17 and earlier lack system translation). */
  readonly supported: boolean;
  /** Language of each text segment; null if unrecognised. */
  detectLanguages(texts: readonly string[]): Promise<(string | null)[]>;
  /**
   * Whether this language pair can currently be translated: installed means ready to translate;
   * download requires downloading first, missing indicates languages not yet downloaded (Android,
   * prompting the user first); iOS provides no missing status, prompting the user itself during
   * translation. unsupported cannot be translated.
   */
  status(
    from: string,
    to: string,
  ): Promise<{ status: 'installed' | 'download' | 'unsupported'; missing?: string[] }>;
  /** Number of bytes to download for each language (estimated, Android ML Kit is ~30 MB). */
  readonly downloadBytes?: number;
  /** Download a language model (Android); throws if offline. iOS does not have this method. */
  download?(language: string): Promise<void>;
  /** Downloaded languages (Android, listed in "Settings -> Downloaded Content"; iOS languages are managed by system settings and lack this method). */
  downloadedLanguages?(): Promise<string[]>;
  /** Delete a language model (Android). */
  removeLanguage?(language: string): Promise<void>;
  /**
   * Translate, segment by segment. On iOS, the system pops up a confirmation dialog if download
   * is required; throws an error with code cancelled if the user cancels.
   */
  translate(texts: readonly string[], from: string, to: string): Promise<string[]>;
  /** Pre-download a language pair (iOS only: system confirmation dialog; code is cancelled if the user cancels). */
  prepare?(from: string, to: string): Promise<void>;
}

/** Reasons for speech synthesis failure (modules/morph-tts, D-270): action implementations instruct users based on this. */
export type SpeakErrorCode = 'noVoice' | 'notDownloaded' | 'unavailable' | 'cancelled' | 'failed';

export interface SpeakRequest {
  /** Voice locale code (BCP 47: zh-CN, en-US, core SPEAK_VOICE_LOCALES). */
  voice: string;
  /** 1 is normal speed, ranging from 0.5 to 2. */
  rate: number;
  runId: string;
  /** Output WAV placed in the current run's temporary directory runs/<runId>/<relPath>. */
  relPath: string;
  /** 0–1。 */
  onProgress?: (fraction: number) => void;
  /** Stop tapped on the run page (checked every 0.3 seconds). */
  isCancelled?: () => boolean;
}

/**
 * System speech synthesis (modules/morph-tts, D-270): iOS uses AVSpeechSynthesizer, Android uses
 * system TextToSpeech. Converts text to audio files only, without playing them. Null when native
 * modules are absent (Expo Go). Text is passed only to the system, never uploaded or sent to AI.
 * Throws an error with a code (SpeakErrorCode) on failure.
 */
export interface SpeakPlatform {
  /**
   * Whether this voice can be used: installed is usable; notDownloaded means voice data is not
   * yet downloaded (Android, download via system settings); unsupported means no voice exists for
   * this language; noEngine means no TTS engine is available (Android).
   */
  voiceStatus(voice: string): Promise<'installed' | 'notDownloaded' | 'unsupported' | 'noEngine'>;
  /** Synthesizes text segments in order into a 16-bit PCM WAV file; intermediate files are deleted by native modules, leaving no output files on failure or cancellation. */
  synthesize(
    segments: readonly string[],
    request: SpeakRequest,
  ): Promise<{
    uri: string;
    size: number;
    durationMs: number;
    sampleRate: number;
    channels: number;
  }>;
}

/** A file stored in a folder: local URI, file name (without extension), and extension. */
export interface FolderItem {
  uri: string;
  name: string;
  ext: string;
  mimeType: string;
}

/** Video and audio metadata (modules/morph-media probe, D-141). */
export interface MediaInfo {
  kind: 'video' | 'audio';
  durationMs: number;
  size: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Width and height after orienting the video. */
  width?: number;
  height?: number;
  fps?: number;
  hdr?: boolean;
  videoCodec?: string;
  videoBitrateKbps?: number;
  audioCodec?: string;
  audioBitrateKbps?: number;
  sampleRate?: number;
  channels?: number;
}

/** Requirements for a video encoding task (H.264 + AAC MP4). */
export interface VideoEncode {
  /** Changes video and audio speed together, with audio pitch changing accordingly. */
  speed?: number;
  /** Crop to this aspect ratio from the center. */
  aspectRatio?: number;
  videoKbps: number;
  /** 0 = remove audio. */
  audioKbps: number;
  /** Scale down to this short side; omitted when no scaling is needed. */
  shortSide?: number;
  maxFps: number;
  range?: { startMs: number; endMs: number };
}

/** Audio encoding requirements (core AudioPlan): M4A (AAC), WAV (16-bit PCM), or MP3 (D-183); range specifies a subsegment. */
export interface AudioEncode {
  format: 'm4a' | 'wav' | 'mp3';
  bitrateKbps: number;
  channels: 1 | 2;
  sampleRate: number;
  range?: { startMs: number; endMs: number };
}

/** A long-running task: intra-step progress (0–1) and cancellation. */
export interface MediaJob {
  progress(fraction: number): void;
  isCancelled(): boolean;
}

/** Processing result: temporary file for the current run. */
export interface MediaOutput {
  uri: string;
  ext: string;
  size: number;
  info: MediaInfo;
}

/** Generated animated GIF (D-184): temporary file for the current run. */
export interface GifOutput {
  uri: string;
  size: number;
  width: number;
  height: number;
  frames: number;
}

/**
 * Process video and audio on-device (modules/morph-media: iOS AVFoundation, Android Media3,
 * D-141). Returns null when native modules are absent (Expo Go); video actions report
 * needsFullApp. Screen stays on during processing (D-148). Throws errors with codes on failure
 * (ERR_MEDIA_UNSUPPORTED / CANCELLED / INTERRUPTED / NOT_IMPLEMENTED / FAILED).
 */
export interface MediaPlatform {
  probe(uri: string): Promise<MediaInfo>;
  /** Re-encode into MP4, writing to the temporary directory relPath for the current run (extension .mp4). */
  encodeVideo(
    uri: string,
    settings: VideoEncode,
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput>;
  /** Extract WAV along the full video timeline for on-device subtitle recognition, including leading/trailing silence. */
  /** Extract WAV along the full video timeline for on-device subtitle recognition, including leading/trailing silence. */
  speechAudio(uri: string, runId: string, relPath: string, job: MediaJob): Promise<MediaOutput>;
  volume(
    uri: string,
    settings: { automatic: boolean; db: number; video?: VideoEncode },
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput>;
  denoise(
    uri: string,
    settings: { automatic?: boolean; db?: number; video?: VideoEncode },
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput>;
  /** Remove audio; iOS does not re-encode, Android re-encodes the video stream. */
  muteVideo(
    uri: string,
    settings: VideoEncode,
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput>;
  /** Rotate clockwise; iOS only updates orientation metadata, Android re-encodes. */
  rotateVideo(
    uri: string,
    degrees: 90 | 180 | 270,
    settings: VideoEncode,
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput>;
  /** Selected at soundtrack runtime, not passed as a secondary value in the workflow. */
  mixVideoAudio(
    uri: string,
    music: string,
    settings: VideoEncode & {
      originalVolume: number;
      loop: boolean;
      videoDurationMs: number;
      musicDurationMs: number;
    },
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput>;
  /** Concatenate videos in order; dimensions and frame rate follow the first segment, with letterboxing for mismatched aspect ratios. */
  concatVideo(
    uris: readonly string[],
    settings: VideoEncode & { width: number; height: number },
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput>;
  /** Trim without re-encoding; output extension may differ from relPath (uses MOV when MP4 cannot hold the original audio). */
  trim(
    uri: string,
    range: { startMs: number; endMs: number },
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput>;
  /** Accurately decode a single frame near the specified timestamp at original resolution, JPEG format, properly oriented. */
  frame(uri: string, timeMs: number, runId: string): Promise<string>;
  /** Extract frames by timestamp (properly oriented), saving JPEGs into the temporary directory of the current run. */
  thumbnails(
    uri: string,
    timesMs: readonly number[],
    maxSide: number,
    runId: string,
  ): Promise<string[]>;
  /** Encode audio (or video sound) into M4A / WAV / MP3 (D-153, D-183). */
  encodeAudio(
    uri: string,
    settings: AudioEncode,
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput>;
  /** Concatenate multiple segments in order into a single file (D-155), supporting differing formats and sample rates. */
  concatAudio(
    uris: readonly string[],
    settings: AudioEncode,
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<MediaOutput>;
  /** Waveform (buckets of 0-1 peak values), for UI snippet trimming; returns null if it cannot be read. */
  waveform(uri: string, buckets: number): Promise<number[] | null>;
  /** Convert an entire video to GIF (D-184): extract frames by fps, capping width at width. */
  videoGif(
    uri: string,
    settings: { width: number; fps: number },
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<GifOutput>;
  /** Create a GIF from multiple images (D-184): shrink long side to maxSide, center-align based on the first image's dimensions, holding each frame for delayMs. */
  imagesGif(
    uris: readonly string[],
    settings: { delayMs: number; maxSide: number },
    runId: string,
    relPath: string,
    job: MediaJob,
  ): Promise<GifOutput>;
}

/**
 * Convert office documents to PDF (D-186). iOS uses system document preview rendering
 * (modules/morph-docs), supporting Word, Excel, PowerPoint, and RTF; Android (and Expo Go without
 * native modules) uses mammoth to convert Word (.docx) into HTML and prints it to PDF.
 */
/** PDF password (D-194, PDFKit in modules/morph-docs). Results are written to the current run's temporary file runs/<runId>/<relPath>. */
export interface PdfPasswordPlatform {
  /** none: no encryption; restricted: can open without password but with restrictions; locked: requires password to open. Throws an error if it cannot be opened. */
  lockState(uri: string): Promise<'none' | 'restricted' | 'locked'>;
  /** Save a copy without a password; returns null if the password is incorrect. */
  unlock(
    uri: string,
    password: string,
    runId: string,
    relPath: string,
  ): Promise<{ uri: string; size: number } | null>;
  protect(
    uri: string,
    password: string,
    runId: string,
    relPath: string,
  ): Promise<{ uri: string; size: number }>;
}

export interface DocumentPlatform {
  /** Supported file extensions (lowercase). */
  readonly extensions: readonly string[];
  /** PDF password support; absent on Android and Expo Go (P-025). */
  readonly passwords: PdfPasswordPlatform | null;
  /** Convert to a temporary PDF file for the current run; throws an error with code ERR_DOC_UNREADABLE if it cannot be opened. */
  toPdf(
    uri: string,
    ext: string,
    page: { width: number; height: number },
    runId: string,
    relPath: string,
  ): Promise<{ uri: string; size: number; pageCount: number }>;
}

/**
 * Keep long tasks running even when switching to other apps (modules/morph-background,
 * D-160-D-163): Android uses a foreground service and progress notifications, while iOS 16 uses
 * system background tasks (disabled by default). Run entry points are called before and after
 * operations containing long steps; returns null when native modules are absent.
 */
export interface BackgroundPlatform {
  /** Whether execution continues when switching to another app; the run page uses this to display "You can switch away" or "Please stay in Morph". */
  readonly continuesInBackground: boolean;
  /** Prompt for notification permission the first time starting from Android 13 (D-161); returns whether notifications can currently be sent. */
  ensureNotificationPermission(): Promise<boolean>;
  /** Returns false if the system disallows starting, and the task runs in the foreground as usual. */
  begin(title: string, text: string): boolean;
  /** Progress is indeterminate when fraction is null. */
  update(text: string, fraction: number | null): void;
  /** Send a completion notification when done is not null (D-162). */
  end(done: { title: string; body: string } | null): void;
  /** Whether Morph is currently in the foreground (determines whether to send completion notifications). */
  isForeground(): boolean;
}

export interface FilePlatform {
  /** Convert office documents to PDF (D-186). */
  readonly documents: DocumentPlatform;
  /** System-provided text recognition and scanning; null when unavailable. */
  readonly vision: VisionPlatform | null;
  /** System-provided on-device translation (D-170); null when native modules are absent. */
  readonly translator: TranslatePlatform | null;
  /** On-device video and audio processing; null when unavailable (Expo Go). */
  readonly media: MediaPlatform | null;
  /** On-device speech-to-text (D-150, D-151, modules/morph-speech); null when unavailable (Expo Go). */
  readonly speech: SpeechPlatform | null;
  /** Synthesize text into audio files using system speech (D-270, modules/morph-tts); null when unavailable (Expo Go). */
  readonly speaker: SpeakPlatform | null;
  /** Keep long tasks running when switched to the background (D-160); null when native modules are absent (Expo Go). */
  readonly background: BackgroundPlatform | null;
  /** Desk directory in the document workspace (D-357, desk/ under the documents directory). */
  readonly desk: DeskFs;

  // ---- User files (assets/<id>/<filename>, D-019) ----
  /**
   * Pick a photo from the photo library (used for image components and backgrounds), re-encoding
   * to JPEG with its longest side scaled down to maxSide (default 2048), scaling during decode;
   * returns null if the user cancels.
   */
  pickImage(maxSide?: number): Promise<PickedFile | null>;
  /** Direct display URI for a user file (used by image components). */
  fileUri(path: string): string;
  /**
   * Thumbnail URI for the first page of a PDF (D-451): generated on-device when a PDF is saved to
   * user files, stored in the same directory; null when unavailable (not a PDF, unreadable, or
   * legacy storage). Read-only, never generated on demand.
   */
  thumbnailUri?(path: string): string | null;
  /**
   * Text extracted from files (D-455, exception to invariant 14): OCR text from images and text
   * layers from PDFs are stored next to the file and deleted alongside it. On-device only,
   * excluded from config and never sent to AI.
   */
  saveAssetText?(path: string, text: string): Promise<void>;
  assetText?(path: string): Promise<string | null>;
  importFile(
    file: PickedFile,
    assetId: string,
    name: string,
  ): Promise<{ path: string; size: number }>;
  /**
   * Delete a user file directory assets/<id>/ from disk ("Settings -> Storage", D-264). Does
   * nothing if path is not under assets/; missing files are ignored.
   */
  removeAssetFile(path: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  /**
   * SHA-256 digest of file contents (lowercase hex): computed natively on the fly so large files
   * do not enter JS memory. uri can be a picked file (file://, content://) or a user file URI
   * (fileUri). Used on-device only to distinguish file identities; digests are never stored or
   * transmitted (invariants 1, 2). Throws on read failure.
   */
  contentDigest(uri: string): Promise<string>;
  writeBytes(
    assetId: string,
    name: string,
    bytes: Uint8Array,
  ): Promise<{ path: string; size: number }>;
  share(path: string, mimeType: string): Promise<void>;
  /** Save text to a temporary file and open the system share sheet (used for CSV export). Never becomes a user file. */
  shareText(fileName: string, text: string, mimeType: string): Promise<void>;
  /**
   * Send to other AI apps (D-611): app files along with prompts are passed to the system share
   * sheet, letting the user manually choose the app and tap send (invariant 10). When native
   * sharing is available, app files are attached alongside the packaged inspector
   * (tinkrum-check.js); prompts include actual provided contents. When native sharing is absent
   * (Expo Go), only text is sent, with app files appended to the prompt. App files contain
   * structure only (invariants 1, 2, 3).
   */
  shareWithAi(input: {
    file?: { name: string; text: string };
    prompt: (how: { attached: boolean; checker: boolean; docs?: boolean }) => string;
    /** Shared text when files are present: the prompt itself is placed inside the tinkrum-request.md attachment, and the text merely points to it. */
    pointer: string;
  }): Promise<void>;
  /**
   * Read a text file selected by the user from the "Files" app (used for restoring prefilled
   * memory backups). Deletes the picker's temporary copy in App cache (Caches/DocumentPicker,
   * internal to the app) after reading; the original file remains untouched.
   */
  readPickedText(uri: string): Promise<string>;

  // ---- Workflow execution: Selection ----
  /** Select a mix of photos and videos from the photo library; returns null if the user cancels. */
  pickMedia(max: number): Promise<PickedFile[] | null>;
  /** Select multiple photos from the photo library; returns null if the user cancels. */
  pickPhotos(max: number): Promise<PickedFile[] | null>;
  /** Take a photo; returns null if the user cancels, throws cameraUnavailable if no camera is present. */
  takePhoto(): Promise<PickedFile | null>;
  /** Select multiple videos from the photo library (without transcoding at selection time); returns null if the user cancels. */
  pickVideos(max: number): Promise<PickedFile[] | null>;
  /**
   * Select files from the "Files" app; types specifies MIME types (may include image/*, * /*).
   * When inPlace is true, files are not copied to cache, returning the original URI (original
   * path on iOS, content:// on Android): avoids copying multi-gigabyte archives (full restore,
   * D-600); originals are read-only and never moved or deleted.
   */
  pickDocuments(
    types: readonly string[],
    multiple: boolean,
    inPlace?: boolean,
  ): Promise<PickedFile[] | null>;

  // ---- Workflow execution: Temporary files (cache directory runs/<runId>/, D-063) ----
  /** Copy a file provided by the picker into the temporary directory of the current run. */
  copyToRun(uri: string, runId: string, fileName: string): Promise<{ uri: string; size: number }>;
  /**
   * Do not copy large files (videos, audio) (D-142): move the picker's cached copy into the
   * current run's temporary directory (to be deleted together later); files shared in place
   * (shared directory, content://) are used directly and their original URI is returned; when
   * keepSource is true, cached copies are also not moved (the inbox page needs to support
   * re-running).
   */
  adoptIntoRun(
    uri: string,
    runId: string,
    fileName: string,
    keepSource?: boolean,
  ): Promise<{ uri: string; size: number }>;
  /** Remaining free space on device in bytes; null if unreadable. */
  freeDiskBytes(): number | null;
  writeRunFile(
    runId: string,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<{ uri: string; size: number }>;
  readUri(uri: string): Promise<Uint8Array>;
  /** Delete a temporary file in the current run (edited xlsx written as a new file, discarding the old one, D-272); restricts deletion strictly to the run directory. */
  removeRunFile(uri: string): Promise<void>;
  /** Delete the temporary directory for the current run. */
  removeRun(runId: string): Promise<void>;
  /** Clean up leftover temporary directories from previous uncompleted startups. */
  removeAllRuns(): Promise<void>;
  /**
   * Delete copies of shared files (D-116): delete all files in the App Group shared directory
   * except those in keep (restricts to top-level, UUID-named files in the shared directory);
   * copies refers to native Android module copies in the cache directory, restricted to the cache
   * directory. Android content:// URIs themselves require no deletion.
   */
  removeShared(keep?: readonly string[], copies?: readonly string[]): Promise<void>;
  /**
   * Delete picker copies stored in the app cache directory (copies created by the system after
   * selecting from photo library or "Files"). Files outside the cache directory (original photo
   * library items, content:// URIs, user files, run temporary directories runs/) are never
   * touched.
   */
  removePickedCopies(uris: readonly string[]): Promise<void>;
  /** Called at startup: at this point no inbox batches are in memory, so any remaining copies in the picker cache directory are obsolete. */
  removeStalePickerCopies(): Promise<void>;
  /** Save a temporary file as a user file. */
  saveRunFile(uri: string, assetId: string, name: string): Promise<{ path: string; size: number }>;

  // ---- Workflow execution: Output ----
  /** Open the system share sheet once with all files included (MorphShare, D-119); opens them individually when native modules are absent (Expo Go). */
  /** name and ext are the filenames seen by the user (used when sharing, D-466); falls back to the file's own name when absent. */
  shareUris(
    items: readonly { uri: string; mimeType: string; name?: string; ext?: string }[],
  ): Promise<void>;
  /**
   * Copies a file into a folder within "Files" (D-120). Each quick action (keyed by its ID)
   * remembers its own folder (D-196): if choose is not true, saves directly to the remembered one
   * if present, or uses the last chosen one (D-123) and remembers it; otherwise prompts the user
   * to choose one and remembers it. Returns the count of saved files and the folder name, or null
   * if cancelled. Throws folderNotWritable if the folder cannot be written to.
   */
  saveToFolder(
    items: readonly FolderItem[],
    key: string,
    choose?: boolean,
  ): Promise<{ saved: number; folder: string } | null>;
  /** The name of the folder this quick action will save into; null if none remembered. */
  rememberedFolder(key: string): string | null;
  /** Forgets folders of quick actions that have been deleted (keep: IDs of currently existing quick actions); called on app startup. */
  forgetFolders(keep: readonly string[]): void;
  /** Saves to the system photo library; throws permissionDenied if permissions are lacking. */
  saveToPhotos(uris: readonly string[]): Promise<void>;
  /**
   * Opens a file using the system viewer (such as PDFs on the inbox page, D-238): QuickLook on
   * iOS, hands off to an app capable of opening it on Android. Throws noViewer if no app can open
   * it.
   */
  previewFile(item: { uri: string; mimeType: string; name: string }): Promise<void>;
  print(item: { uri: string; mimeType: string }): Promise<void>;
  copyText(text: string): Promise<void>;
  /** Text from the clipboard (read only when the user taps "Paste from clipboard", D-593); empty string when there is no text. */
  readClipboardText(): Promise<string>;

  // ---- Images (expo-image-manipulator) ----
  /** Image dimensions (corrected for capture orientation). */
  imageSize(uri: string): Promise<{ width: number; height: number }>;
  /** Processes and encodes into a temporary file for the current run; quality 0-1, ignored for PNG. Re-encoding strips EXIF metadata (including location). */
  transformImage(
    uri: string,
    ops: ImageOps,
    save: { format: ImageFormat; quality: number },
    runId: string,
    relPath: string,
  ): Promise<EncodedImage>;

  /** Enhances an image (scanned document), outputting a temporary JPG file; skew and base are the rotation angle and pre-rotation dimensions (D-267). */
  enhanceImage(
    uri: string,
    mode: EnhanceMode,
    runId: string,
    relPath: string,
  ): Promise<EncodedImage & { skew: number; base: { width: number; height: number } }>;

  /** Off-screen composition of an image, encoded into a temporary file for the current run. */
  composeImage(
    canvas: { width: number; height: number; background: string },
    ops: readonly DrawOp[],
    save: { format: 'jpeg' | 'png'; quality: number },
    runId: string,
    relPath: string,
  ): Promise<EncodedImage>;
  /** Reads RGBA pixels of an image (with the long side scaled down within maxSide), used for QR code recognition. */
  imagePixels(
    uri: string,
    maxSide: number,
  ): Promise<{ width: number; height: number; data: Uint8Array }>;
  /**
   * Converts an image into a JPEG with a long side not exceeding maxSide, saved as a temporary
   * file for the current run (D-425). Downscales during decoding so multi-megapixel photos do not
   * load entirely into memory (Android rules in AGENTS.md); re-encoding also strips location and
   * other metadata (D-047).
   */
  reducedJpeg(
    uri: string,
    maxSide: number,
    quality: number,
    runId: string,
    relPath: string,
  ): Promise<EncodedImage>;
  /** Converts HTML into a PDF using system print layout (expo-print), saved as a temporary file for the current run. */
  htmlToPdf(
    html: string,
    page: { width: number; height: number },
    runId: string,
    relPath: string,
    /** Page margins (in points); defaults used when omitted (pass 0 if the web page defines its own margins). */
    margins?: { left: number; right: number; top: number; bottom: number },
  ): Promise<{ uri: string; size: number; pageCount: number }>;

  // ---- Signatures ----
  loadSignatures(): Promise<SavedSignature[]>;
  saveSignature(png: Uint8Array, aspect: number): Promise<void>;

  // ---- Skia ----
  /** Renders a line of text into a transparent-background PNG using system fonts (including CJK characters and emoji). */
  renderText(
    text: string,
    style: { fontSize: number; color: string; opacity: number; background?: string },
  ): Promise<{ bytes: Uint8Array; width: number; height: number }>;
}
