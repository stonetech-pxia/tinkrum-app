import { requireOptionalNativeModule, type EventSubscription } from 'expo';

// Local Expo module MorphWidgets (D-321–D-323): two files mediating between desktop widgets and the
// app.
// - snapshot.json: App-rendered layout (src/widgets/types.ts), triggering system widget redraw upon
// completion.
// - queue/: Tapped actions from widgets, one file per tap; app reads them out, executes them in tap
// order, records completion, and then confirms deletion (read without deleting, R07). On iOS,
// stored in App Group group.dev.stonetech.tinkrum (read/write by widget extension targets/widget);
// on Android, stored in the app's own files/widgets directory (widget AppWidgetProvider resides
// within the app). Uses system frameworks only, no networking. Null in Expo Go and tests.

export interface MorphWidgetsModule {
  /** Replace the layout, prompting the system to redraw all Morph widgets. */
  setSnapshot(json: string): Promise<void>;
  /** Read unhandled actions (id is the file name in the queue, text is JSON), do not delete: App confirms via removeQueue (R07) after handling. */
  readQueue(): Promise<{ id: string; text: string }[]>;
  /** Delete handled taps (identified by file names in the queue); missing ones are not considered an error. */
  removeQueue(ids: string[]): Promise<void>;
  /** Whether it is possible to directly request placing a widget on the home screen (supported only from Android 8 onwards when the home screen supports it; iOS is always false). */
  canPin(): boolean;
  /** Request to place a widget displaying this item on the home screen: the system shows a confirmation dialog for the user to decide. Returns whether the request was successfully sent. */
  pin(itemId: string, label: string): Promise<boolean>;
  /** Android: When an action is tapped on the widget while the app is open, retrieve and execute it immediately. */
  addListener(event: 'onQueue', listener: () => void): EventSubscription;
}

export default requireOptionalNativeModule<MorphWidgetsModule>('MorphWidgets');
