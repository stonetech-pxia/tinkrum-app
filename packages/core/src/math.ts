/** Clamp value within closed interval; callers should explicitly pass lower and upper bounds to avoid mistaking the upper bound for the lower bound. */
export function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}
