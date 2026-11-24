import type { HomeScreenArt } from './platform';

// Graphics on desktop icons are only drawn on Android (icon-image.android.ts, D-606). iOS menus
// only accept system icons, nothing is drawn here; split into two files so Android icon fonts are
// not bundled into iOS builds.

/** Unable to draw: caller supplies no icon. */
export async function drawHomeScreenIcon(_art: HomeScreenArt): Promise<string | null> {
  return null;
}
