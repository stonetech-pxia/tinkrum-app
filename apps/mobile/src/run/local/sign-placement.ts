import { clamp } from '@morph/core';
// Placement position and size of the signature on the page (page proportional coordinates, top-left
// origin). 2026-11-09 user testing: previously defaulted to bottom-right with a width of 32% of
// page width, about 80 pt high on A4, whereas contract lines are only about a dozen points high,
// causing it to cover two lines immediately; users could only drag and could not tap to place it on
// a specific line. Now, tapping a line places it on that line, and unless a size was explicitly
// chosen, the height is determined by that line of text.

type Size = { width: number; height: number };

export interface SignPlacement {
  place: { x: number; y: number; width: number };
  /** Position at the start of drag (PanResponder's dx is the accumulated value from the initial press). */
  start: { x: number; y: number };
  /** Size of the page on screen. */
  size: Size;
  /** User has manually selected S / M / L: subsequent taps elsewhere will no longer resize based on that line. */
  sized: boolean;
}

export type SignAction =
  | { type: 'grant' }
  | { type: 'move'; dx: number; dy: number }
  | { type: 'size'; width: number }
  | { type: 'layout'; width: number; height: number }
  /** Signature selected (aspect ratio known) or page changed: returns to default size and position. */
  | { type: 'reset' }
  /** Tap on the page (screen points); lineHeight is the height of the line of text near the point (original image points), omitted if text is unrecognized. */
  | { type: 'tap'; x: number; y: number; lineHeight?: number };

/** Fallback body line height when text is not recognized: 1.9% of the short side (approx. 11 pt font) × 1.3. */
const bodyLineHeight = (page: Size) => Math.min(page.width, page.height) * 0.019 * 1.3;
/** Signatures are approximately two and a half lines tall (slightly larger than text, but without overlapping adjacent lines). */
const SIGNATURE_LINES = 2.5;

function widthFor(lineHeight: number, page: Size, aspect: number): number {
  const width = (SIGNATURE_LINES * lineHeight * aspect) / page.width;
  return Math.min(0.45, Math.max(0.08, width));
}

export function initialPlacement(page: Size, aspect: number): SignPlacement {
  const width = widthFor(bodyLineHeight(page), page, aspect);
  return {
    place: { x: Math.min(0.55, 1 - width), y: 0.8, width },
    start: { x: 0, y: 0 },
    size: { width: 0, height: 0 },
    sized: false,
  };
}

export function reducePlacement(
  state: SignPlacement,
  action: SignAction,
  page: Size,
  aspect: number,
): SignPlacement {
  const { place } = state;
  switch (action.type) {
    case 'grant':
      return { ...state, start: { x: place.x, y: place.y } };
    case 'move': {
      if (!state.size.width) return state;
      const x = state.start.x + action.dx / state.size.width;
      const y = state.start.y + action.dy / state.size.height;
      return {
        ...state,
        place: { ...place, x: clamp(x, 0, 1 - place.width), y: clamp(y, 0, 0.97) },
      };
    }
    case 'size':
      return {
        ...state,
        sized: true,
        place: { ...place, width: action.width, x: Math.min(place.x, 1 - action.width) },
      };
    case 'layout':
      return { ...state, size: { width: action.width, height: action.height } };
    case 'reset':
      return { ...initialPlacement(page, aspect), size: state.size };
    case 'tap': {
      if (!state.size.width || !state.size.height) return state;
      const width = state.sized
        ? place.width
        : widthFor(action.lineHeight ?? bodyLineHeight(page), page, aspect);
      const height = (width * page.width) / aspect / page.height;
      // Left edge starts at the finger position, baseline lands on the target text line.
      return {
        ...state,
        place: {
          width,
          x: clamp(action.x / state.size.width, 0, 1 - width),
          y: clamp(action.y / state.size.height - height, 0, Math.min(0.97, 1 - height)),
        },
      };
    }
  }
}
