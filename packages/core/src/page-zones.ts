import { isKnownComponent, type Component, type KnownComponent, type Page } from './schema';

// Fixed zones of a page (established by founder 2026-11-04): config still stores a sequence of page.blocks, split by pin only during rendering (similar to the bottom-right floating "+").

export type BrowseListBlock = Extract<KnownComponent, { look: 'list' | 'cards' | 'checklist' }>;

const isBrowseList = (c: Component): c is BrowseListBlock =>
  isKnownComponent(c) &&
  (c.look === 'list' || c.look === 'cards' || c.look === 'checklist') &&
  c.show.browse !== undefined;

/** Top-level lists in the page with show.browse (including hidden ones: validation checks config, while hiding only affects display). Excludes lists inside groups. */
export const pageBrowseLists = (page: Page): BrowseListBlock[] => page.blocks.filter(isBrowseList);

export const pageDial = (page: Page): Extract<KnownComponent, { look: 'dial' }> | undefined =>
  page.blocks.find(
    (c): c is Extract<KnownComponent, { look: 'dial' }> =>
      !c.hidden && isKnownComponent(c) && c.look === 'dial',
  );

/** Time range block on the page (D-440): at most one per page, excluding hidden ones. */
export const pagePeriod = (page: Page): Extract<KnownComponent, { look: 'period' }> | undefined =>
  page.blocks.find(
    (c): c is Extract<KnownComponent, { look: 'period' }> =>
      !c.hidden && isKnownComponent(c) && c.look === 'period',
  );

/** Row of options on the page (D-573): at most one per page, excluding hidden ones. */
export const pageChoices = (page: Page): Extract<KnownComponent, { look: 'choices' }> | undefined =>
  page.blocks.find(
    (c): c is Extract<KnownComponent, { look: 'choices' }> =>
      !c.hidden && isKnownComponent(c) && c.look === 'choices',
  );

/**
 * The list whose state should be kept on the page: search, sorting, and filtering are rendered in
 * the fixed zone (browse.pin), or separate floating buttons use its selected records. Excludes
 * hidden lists. Other lists maintain state within their own blocks.
 */
export function pageBrowseHost(page: Page): BrowseListBlock | undefined {
  const visible = pageBrowseLists(page).filter((c) => !c.hidden);
  const handing = pageDial(page)?.tools.some((u) => u.as === 'list');
  return visible.find((c) => c.show.browse?.pin === true) ?? (handing ? visible[0] : undefined);
}

/** Page divided into top, middle, and bottom sections (hidden ones are not rendered). */
export function pageZones(page: Page): {
  top: Component[];
  middle: Component[];
  bottom: Component[];
} {
  const shown = page.blocks.filter((c) => !c.hidden);
  const pinOf = (c: Component) => (isKnownComponent(c) ? c.pin : undefined);
  return {
    top: shown.filter((c) => pinOf(c) === 'top'),
    middle: shown.filter((c) => pinOf(c) === undefined),
    bottom: shown.filter((c) => pinOf(c) === 'bottom'),
  };
}
