/** ID for new user files / records / presets (timestamp + random). In a separate file: both storage and renderer need it and should not depend on the executor for this (R11). */
export function newAssetId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
