import MorphWidgets from '../../modules/morph-widgets';
import type { WidgetPlatform } from './types';

/** Native module MorphWidgets (D-321); returns null in Expo Go, Web, and tests (omits rendering and instructions for placing on the home screen). */
export const nativeWidgets: WidgetPlatform | null = MorphWidgets
  ? {
      setSnapshot: (json) => MorphWidgets!.setSnapshot(json),
      readQueue: () => MorphWidgets!.readQueue(),
      removeQueue: (ids) => MorphWidgets!.removeQueue(ids),
      canPin: () => MorphWidgets!.canPin(),
      pin: (itemId, label) => MorphWidgets!.pin(itemId, label),
      onQueue: (listener) => {
        const sub = MorphWidgets!.addListener('onQueue', listener);
        return () => sub.remove();
      },
    }
  : null;
