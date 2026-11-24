import { AppState } from 'react-native';

import MorphBackground from '../../modules/morph-background';
import type { BackgroundPlatform } from './platform';

// Implementation of BackgroundPlatform: local Expo module MorphBackground (D-160-D-163). Null if this module is absent (Expo Go).

export function expoBackground(): BackgroundPlatform | null {
  const native = MorphBackground;
  if (!native) return null;
  return {
    continuesInBackground: native.continuesInBackground,
    ensureNotificationPermission: () => native.ensureNotificationPermission().catch(() => false),
    begin: (title, text) => {
      try {
        return native.begin(title, text);
      } catch {
        return false;
      }
    },
    update: (text, fraction) => {
      try {
        native.update(text, fraction);
      } catch {
        // Failure to update notification does not affect the task.
      }
    },
    end: (done) => {
      try {
        native.end(done);
      } catch {
        // Same as above.
      }
    },
    isForeground: () => AppState.currentState === 'active',
  };
}
