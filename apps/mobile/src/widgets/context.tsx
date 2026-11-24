import { createContext, useContext } from 'react';

import type { WidgetPlatform } from './types';

// Home screen widget platform (D-321): native module in root layout, mock in tests; null when unavailable (Expo Go, Web).
const WidgetContext = createContext<WidgetPlatform | null>(null);

export const WidgetProvider = WidgetContext.Provider;

export function useWidgetPlatform(): WidgetPlatform | null {
  return useContext(WidgetContext);
}
