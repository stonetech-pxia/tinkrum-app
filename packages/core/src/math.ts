/** 把 value 限在闭区间内；调用处明确传 lower、upper，避免把上限误当下限。 */
export function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}
