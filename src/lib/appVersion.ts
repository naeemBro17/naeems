/**
 * Which version this copy of the app is, shown at the bottom of Admin →
 * Settings so Naeem can see which version his phone runs.
 * Batch 32 Part 2: "Version 1.32.0" (from package.json — the middle number
 * is the batch) and, under it, "Build 1d331f9" (the short commit). No date.
 */
export function appVersionNumber(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
}

export function appBuild(): string {
  return typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev';
}
