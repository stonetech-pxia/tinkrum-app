import type { Collection, DataRecord, RunItem } from '@morph/core';
import type { Quad } from '@morph/tool-image';

import type { ImageAnnotation } from './annotations';
import type { PickedFile } from './platform';

// Local operation steps (TOOLS_DESIGN §4): when execution reaches here, the runner page opens the
// corresponding interface, and user operation results are used only for the current run. Inputs and
// outputs for each interface are registered here; the runner page (app/run/[workflowId].tsx)
// handles display.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocalSteps {
  annotate: {
    in: {
      items: RunItem[];
      tool?: ImageAnnotation['kind'] | 'note';
      /** Is a document page (PDF): newly written text defaults to body text size rather than photo label size. */
      document?: boolean;
      /** Recognized text lines on the specified page (in original image coordinates), new text determines font size based on the nearest line; recognized locally only, never stored or transmitted. */
      lines?: (index: number) => Promise<readonly Rect[]>;
    };
    out: ImageAnnotation[][];
  };
  /** Crop regions selected per image (original image pixels). Free aspect ratio when aspect is null. */
  /** initial: pre-positioned crop boxes for each photo (auto face framing for ID photos, D-252); centered if null or absent. */
  crop: { in: { items: RunItem[]; aspect: number | null; initial?: (Rect | null)[] }; out: Rect[] };
  /**
   * Organize PDF pages: select, delete, reorder, rotate. Returns retained pages (0-based original
   * page numbers) in new order; rotate is incremental clockwise rotation angle. thumbnails
   * available only when PDF preview pack is present.
   */
  pages: {
    in: {
      item: RunItem;
      pages: { width: number; height: number; rotation: number }[];
      thumbnails?: string[];
    };
    out: { index: number; rotate: 0 | 90 | 180 | 270 }[];
  };
  /**
   * Signature: select a saved signature or draw one, place it on a page. pages are page preview
   * images (rendered by PDF preview pack). Returns signature PNG and position (page-proportional
   * coordinates, top-left origin).
   */
  sign: {
    in: {
      item: RunItem;
      pages: { uri: string; width: number; height: number }[];
      /** Recognized text lines on the specified page (in original image coordinates), signature height determined by the nearby line; recognized locally only, never stored or transmitted. */
      lines?: (index: number) => Promise<readonly Rect[]>;
    };
    out: { png: Uint8Array; pageIndex: number; x: number; y: number; width: number };
  };
  /** Fill form: fields are read by pdf-lib and filled by the user locally. Returns field name to value mapping. */
  fillForm: {
    in: {
      item: RunItem;
      fields: {
        name: string;
        type: string;
        value?: string | boolean;
        options?: string[];
        multiline?: boolean;
        readOnly?: boolean;
      }[];
    };
    out: Record<string, string | boolean>;
  };
  /**
   * Scan: confirm or drag the four corners of the paper per image (original image pixel
   * coordinates). quad is the corners found by the scanning pack, null if not found. Returns the
   * final four corners for each image.
   */
  corners: { in: { items: { item: RunItem; quad: Quad | null }[] }; out: Quad[] };
  /** Redact: box out areas to cover on each image (original image pixels). Returns boxes for each image, optional. */
  redact: { in: { items: RunItem[] }; out: Rect[][] };
  /** Reorder and delete: returns retained indices in the new order. */
  reorder: { in: { items: RunItem[] }; out: number[] };
  /**
   * Trim segment (shared for video and audio, D-143): select start and end (milliseconds)
   * individually. Video displays frames, audio displays waveform. Returns the selected segment
   * for each file.
   */
  frameMedia: {
    in: {
      items: RunItem[];
      loadThumbnails: (index: number, timesMs: number[]) => Promise<string[]>;
    };
    out: number[];
  };
  trimMedia: {
    /**
     * loadWaveform: reads waveform of the i-th file (peak values 0–1; null for video or if
     * unreadable, D-155). UI opens first, waveform renders after loading: long recordings take
     * tens of seconds to decode on Android.
     */
    in: {
      items: RunItem[];
      loadWaveform?: (index: number) => Promise<number[] | null>;
      /**
       * loadThumbnails: fetches frames (file URIs) of the i-th video at specified timestamps
       * (milliseconds). Used when expo-video fails: Samsung default HDR video fails precise
       * timestamp frame extraction on Android, leaving the timeline without thumbnails.
       */
      loadThumbnails?: (index: number, timesMs: number[]) => Promise<string[]>;
    };
    out: { startMs: number; endMs: number }[];
  };
  /**
   * Audio recording (D-154): start / pause / complete, continues recording when screen is locked.
   * name is the recording filename (without extension). Returns the recorded file (M4A, located
   * in cache directory, subsequently moved to the run's temp directory).
   */
  record: { in: { name: string; autoStart?: boolean }; out: PickedFile };
  /**
   * Log an entry (D-187, D-397): new record form identical to the record page (formulas omitted).
   * Files are already stored, IDs are in prefill attachment fields, allowing the form to read
   * them for candidates; prefill also contains pre-filled text. Returns form values, or skips
   * (when one entry per file).
   */
  recordEntry: {
    in: {
      collection: Collection;
      prefill: Record<string, unknown>;
      /** Present only when the table has no attachment field: displays only the file corresponding to this entry without storing it in records. */
      file?: RunItem;
      /** Files exceed the capacity of a single record, excess files are not included (D-397). */
      overflow?: boolean;
      /**
       * Add to existing record (D-443): the form belongs to this record, starting with its
       * current values, followed by prefill (appended files and text); updates this record on
       * save instead of creating a new one.
       */
      existing?: DataRecord;
      /** Passed from the previous step as a spoken sentence (speech-to-text, D-575): the form directly populates confident fields based on it. */
      heard?: string;
      index: number;
      total: number;
    };
    out: { values: Record<string, unknown> } | { skip: true };
  };
  /** Add to existing record (D-443): select an existing record from this table (displays titles only). Returns null on cancellation. */
  recordPick: {
    in: {
      collection: Collection;
      records: DataRecord[];
      /** Selects a single entry only (for template population), does not append to it: confirmation button reads "Select". */
      select?: boolean;
    };
    out: { recordId: string };
  };
  /**
   * Remove PDF password (D-194): enter the open password for this PDF. wrong: previous attempt
   * was incorrect. Returns the password, or skips this item.
   */
  password: {
    in: { name: string; wrong: boolean; index: number; total: number };
    out: { password: string } | { skip: true };
  };
}

export type LocalKind = keyof LocalSteps;

export interface LocalUi {
  /** Simple binary choice, e.g., "Retake photo?". message is explanatory text below the title (Android titles support up to two lines). */
  confirm(title: string, ok: string, cancel: string, message?: string): Promise<boolean>;
  /**
   * Prompt during execution (fixed questions with pre-written app copy, not AI-generated), e.g.,
   * when PDF compression is insufficient: "Convert to images / Use current". Returns selected
   * index, or null on cancellation.
   */
  choose(title: string, message: string, options: readonly string[]): Promise<number | null>;
  /** Opens local operation interface; returns null if cancelled by the user. */
  open<K extends LocalKind>(
    kind: K,
    input: LocalSteps[K]['in'],
  ): Promise<LocalSteps[K]['out'] | null>;
}
