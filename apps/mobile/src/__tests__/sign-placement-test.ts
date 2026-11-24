import { initialPlacement, reducePlacement } from '../run/local/sign-placement';

// 2026-11-09 user test: signature defaults to bottom right, width is 32% of page width, about 80
// points high on A4, overlapping two lines in contracts immediately; draggable only, not placeable
// with a single tap.

const page = { width: 1000, height: 1414 };
const aspect = 3;
const shown = { width: 500, height: 707 };
const laidOut = () =>
  reducePlacement(initialPlacement(page, aspect), { type: 'layout', ...shown }, page, aspect);

it('starts about as tall as two and a half lines of body text, not a third of the page', () => {
  const { place } = initialPlacement(page, aspect);
  // Body line height is approx 1.9% of short side × 1.3; signature height is 2.5 lines, width = height × 3.
  expect(place.width).toBeCloseTo((1000 * 0.019 * 1.3 * 2.5 * 3) / 1000, 3);
  expect(place.width).toBeLessThan(0.32);
});

it('a tap puts the signature on that line: left edge at the finger, bottom on the line', () => {
  const state = reducePlacement(laidOut(), { type: 'tap', x: 100, y: 300 }, page, aspect);
  expect(state.place.x).toBeCloseTo(0.2, 5);
  const heightFraction = (state.place.width * page.width) / aspect / page.height;
  expect(state.place.y + heightFraction).toBeCloseTo(300 / 707, 5);
});

it('the nearest line sets the size until the person picks S / M / L', () => {
  let state = reducePlacement(
    laidOut(),
    { type: 'tap', x: 100, y: 300, lineHeight: 30 },
    page,
    aspect,
  );
  // 2.5 × 30 = 75 height, 225 width, page width 1000.
  expect(state.place.width).toBeCloseTo(0.225, 5);
  state = reducePlacement(state, { type: 'size', width: 0.45 }, page, aspect);
  state = reducePlacement(state, { type: 'tap', x: 10, y: 600, lineHeight: 30 }, page, aspect);
  expect(state.place.width).toBe(0.45);
});

it('stays on the page near the edges', () => {
  const state = reducePlacement(laidOut(), { type: 'tap', x: 495, y: 5 }, page, aspect);
  expect(state.place.x + state.place.width).toBeLessThanOrEqual(1);
  expect(state.place.y).toBeGreaterThanOrEqual(0);
});
