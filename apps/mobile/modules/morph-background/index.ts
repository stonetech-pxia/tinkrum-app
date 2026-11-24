import { requireOptionalNativeModule } from 'expo';

// Local Expo module MorphBackground (D-160–D-163): long-running tasks (video, audio) continue when
// switching to other apps. Android uses android/…/MorphBackgroundService.kt (foreground service +
// progress notification); iOS uses ios/MorphBackgroundModule.swift (iOS 26
// BGContinuedProcessingTask, disabled by default, continuesInBackground is false). Returns null in
// Expo Go and tests.

export interface MorphBackgroundModule {
  /** Whether long-running tasks continue when switching to other apps (Android is always true; iOS is true only when the experimental switch is enabled and starting with iOS 26). */
  readonly continuesInBackground: boolean;
  /** Starting with Android 13: ask once if notification permission was never granted, and never ask again (D-161). Returns whether notifications can currently be sent. */
  ensureNotificationPermission(): Promise<boolean>;
  /** Start keep-alive and display the progress notification; returns false when starting is disallowed by the system (e.g., the app is already in the background). */
  begin(title: string, text: string): boolean;
  /** Update the progress notification; the progress bar is indeterminate when fraction is null. */
  update(text: string, fraction: number | null): void;
  /** End keep-alive; sends a completion notification when done is not null (Android only). */
  end(done: { title: string; body: string } | null): void;
  /**
   * iOS: when a button action on a reminder notification is received (D-318), the module first
   * requests background time from the system and calls this to release it after processing. Does
   * nothing on Android.
   */
  releaseActionTime(): void;
}

export default requireOptionalNativeModule<MorphBackgroundModule>('MorphBackground');
