import { appLinkPayload } from '@morph/core';
import { isShareLink } from '@/share/useIncomingShare';

/**
 * The iOS sharing extension invokes the app via morph://dataUrl=morphShareKey... (D-114). This is
 * not a page address: on cold start it goes to home first, and if the app is already open it
 * stays on the current page; the inbox page opens files after useIncomingShare retrieves them.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    const payload = appLinkPayload(path);
    if (payload !== null) return `/open?a=${encodeURIComponent(payload)}`;
    if (isShareLink(path)) return initial ? '/' : null;
  } catch {
    // Treat as a normal address on error (throwing here would crash the app).
  }
  return path;
}
