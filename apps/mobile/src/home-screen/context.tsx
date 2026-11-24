import { createContext, useContext } from 'react';

import type { HomeScreenPlatform } from './platform';

// Mobile desktop platform (D-271): root layout puts local module, tests put mock; null when unavailable (Expo Go, Web).
const HomeScreenContext = createContext<HomeScreenPlatform | null>(null);

export const HomeScreenProvider = HomeScreenContext.Provider;

export function useHomeScreenPlatform(): HomeScreenPlatform | null {
  return useContext(HomeScreenContext);
}
