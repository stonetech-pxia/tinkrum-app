// Desktop widgets (D-321-D-325): The UI calculated on device by the app and written for the widget,
// along with taps written back by the widget. The iOS extension (targets/widget/Snapshot.swift) and
// Android (modules/morph-widgets/.../WidgetStore.kt) read this format; when changing the format,
// update all three places together. AI cannot see these (D-042): calculated only on device and
// written only to on-device shared storage.

/** Row: a list record, a tiles circle, or an option in grouped statistics. */
export interface WidgetRow {
  id: string;
  title: string;
  trailing?: string;
  /** Action executed on tap (key in snapshot.ops). */
  op?: string;
  /** URL opened on tap. */
  link?: string;
  /** Progress ring (0-1). */
  ratio?: number;
  /** Target reached, circle filled. */
  full?: boolean;
}

/** Widget view. message: unsupported widgets, deleted widgets. */
export type WidgetView =
  | {
      kind: 'stat';
      title: string;
      value: string;
      ratio?: number;
      percent?: string;
      note?: string;
      /** By single-select group: one row per option. */
      rows?: WidgetRow[];
      link?: string;
    }
  | { kind: 'button'; title: string; icon?: string; op?: string; link?: string; note?: string }
  | {
      kind: 'list';
      title: string;
      display: 'list' | 'tiles';
      rows: WidgetRow[];
      empty: string;
      link?: string;
    }
  | { kind: 'message'; title: string; note: string; link?: string };

export type WidgetViews = Record<string, WidgetView>;

/** View over a period: current view, and after 1...N consecutive operations (D-322). */
export interface WidgetState {
  from: number;
  until: number;
  views: WidgetViews;
  after: Record<string, WidgetViews[]>;
}

/** Operations triggerable on the widget: which widget, which record (operations for each list row), hash is the operation definition at the time (if modified, it won't execute). */
export interface WidgetOpRef {
  component: string;
  record?: string;
  hash: string;
}

export interface WidgetPalette {
  primary: string;
  tint: string;
  onPrimary: string;
}

export interface WidgetSnapshot {
  v: 1;
  strings: { stale: string };
  colors: { light: WidgetPalette; dark: WidgetPalette };
  /** Widgets placed on the desktop, most recently placed at the end (iOS "Edit Widget" list; shows the last one when none selected). */
  items: { id: string; name: string }[];
  ops: Record<string, WidgetOpRef>;
  /** Today and tomorrow (widget updates itself across days without waiting for the app to open). */
  states: WidgetState[];
}

/** A tap queued by the widget (at: tap time in milliseconds). */
export interface QueuedWidgetOp extends WidgetOpRef {
  op: string;
  at: number;
}

/** "Placed on desktop" recorded locally (does not enter config, D-325). */
export interface PlacedWidget {
  componentId: string;
  placedAt: number;
}

/** A tap in the queue: id is its filename in the queue (for confirming deletion), text is the written JSON. */
export interface QueueEntry {
  id: string;
  text: string;
}

export interface WidgetPlatform {
  setSnapshot(json: string): Promise<void>;
  /** Read unprocessed taps without deleting them (R07). */
  readQueue(): Promise<QueueEntry[]>;
  /** Confirm these taps have been processed and delete them. Missing IDs are not considered errors. */
  removeQueue(ids: string[]): Promise<void>;
  canPin(): boolean;
  pin(itemId: string, label: string): Promise<boolean>;
  /** Android: Widget tapped while app is open. Returns unsubscribe function. */
  onQueue(listener: () => void): () => void;
}
