/**
 * Batch 31 Part 7: which version this copy of the app is — the build time
 * (Bangladesh time) and the short commit — shown at the bottom of Admin →
 * Settings so Naeem can see which version his phone runs.
 */
export function appVersionLabel(): string {
  const commit = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev';
  const builtAt = typeof __APP_BUILT_AT__ === 'string' ? new Date(__APP_BUILT_AT__) : null;
  if (!builtAt || Number.isNaN(builtAt.getTime())) return commit;
  const when = builtAt.toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${when} · ${commit}`;
}
