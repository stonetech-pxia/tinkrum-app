// Annotations are kept only for the current run; the AI cannot see these texts, coordinates, or strokes.
export interface AnnotationPoint {
  x: number;
  y: number;
}
export type ImageAnnotation =
  | {
      kind: 'text';
      point: AnnotationPoint;
      text: string;
      fontSize: number;
      color: string;
      /** Clockwise rotation angle around the text box center. */
      rotation?: number;
      /** Comment: background color behind text (yellow sticky note). */
      fill?: string;
    }
  | {
      // erase: whiting out; mosaic: pixelating (using only the bounding box defined by start and end points).
      kind: 'arrow' | 'box' | 'pen' | 'highlight' | 'erase' | 'mosaic';
      points: AnnotationPoint[];
      width: number;
      color: string;
    };

/** Bounding box defined by start and end points (erase, mosaic). */
export function markRect(mark: { points: AnnotationPoint[] }) {
  const a = mark.points[0]!;
  const b = mark.points[mark.points.length - 1]!;
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Preview and export share the same set of original image coordinate paths. */
export function annotationPaths(
  mark: Exclude<ImageAnnotation, { kind: 'text' }>,
): AnnotationPoint[][] {
  if (mark.kind === 'erase' || mark.kind === 'mosaic') return [];
  const start = mark.points[0];
  const end = mark.points[mark.points.length - 1];
  if (!start || !end) return [];
  if (mark.kind === 'pen' || mark.kind === 'highlight') return [mark.points];
  if (mark.kind === 'box')
    return [[start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }, start]];
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const length = Math.min(Math.hypot(end.x - start.x, end.y - start.y) * 0.4, mark.width * 5);
  return [
    [start, end],
    [
      { x: end.x - length * Math.cos(angle - 0.55), y: end.y - length * Math.sin(angle - 0.55) },
      end,
      { x: end.x - length * Math.cos(angle + 0.55), y: end.y - length * Math.sin(angle + 0.55) },
    ],
  ];
}
export const annotationSvg = (points: AnnotationPoint[]) =>
  points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');

/** Scale annotations by factor k according to page zoom (drawn on the preview image, used when switching to a larger image). */
export function scaleMarks(marks: readonly ImageAnnotation[], k: number): ImageAnnotation[] {
  const pt = (p: AnnotationPoint) => ({ x: p.x * k, y: p.y * k });
  return marks.map((m) =>
    m.kind === 'text'
      ? { ...m, point: pt(m.point), fontSize: m.fontSize * k }
      : { ...m, points: m.points.map(pt), width: m.width * k },
  );
}
