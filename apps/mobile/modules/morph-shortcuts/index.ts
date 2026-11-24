import { requireOptionalNativeModule, type EventSubscription } from 'expo';

// Local Expo module MorphShortcuts (D-271): quick actions marked by the user as "Add to Desktop"
// appear in the menu when long-pressing the Morph icon. On iOS, ios/MorphShortcutsModule.swift
// (UIApplicationShortcutItem, taps received by app delegate subscribers; SDK 58's
// ExpoAppSceneDelegate forwards both cold starts and taps while the app is running to it). On
// Android, android/.../MorphShortcutsModule.kt (dynamic shortcuts via ShortcutManagerCompat; when
// the user taps the button, requestPinShortcut places a standalone icon on the desktop with a
// system confirmation dialog; pinned icons no longer in the menu are disabled using
// disableShortcuts; items with an image use that image as their icon, D-606). Uses system
// frameworks only with no network access. Returns null in Expo Go and tests, and callers take no
// action.

export interface ShortcutItem {
  /** Quick action ID: used to locate and start the quick action upon being tapped. */
  id: string;
  title: string;
  /** iOS SF Symbol name; Android uses the app icon. */
  symbol?: string;
  /** Android: the item's own icon (D-606), a PNG sized for an adaptive icon (base64); uses the app icon if missing. Not passed on iOS. */
  image?: string;
}

export interface MorphShortcutsModule {
  /**
   * Replaces the entire long-press menu. On Android, simultaneously updates icons already pinned
   * to the desktop: updates names and enables those present in items, and disables those absent
   * (tapping them displays disabledMessage), because the app cannot remove desktop icons on
   * behalf of the user.
   */
  setItems(items: readonly ShortcutItem[], disabledMessage: string): Promise<void>;
  /** Whether this device can place a standalone icon on the desktop (true on Android 8+ when supported by the launcher; always false on iOS). */
  canPin(): boolean;
  /** Requests placing an icon on the desktop: the system displays a confirmation dialog for the user to decide. Returns whether the request was successfully sent (does not imply user approval). */
  pin(item: ShortcutItem): Promise<boolean>;
  /** Indicates which quick action opened the app on a cold start; returns the value only once, and returns null thereafter. */
  takeLaunched(): string | null;
  /** Tapped the desktop menu / icon while the app is running (or returning from the background). */
  addListener(event: 'onOpen', listener: (e: { id: string }) => void): EventSubscription;
}

export default requireOptionalNativeModule<MorphShortcutsModule>('MorphShortcuts');
