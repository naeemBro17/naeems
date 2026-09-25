/** Format a BDT price for display: "৳ 1,250" (drops trailing .00). */
export function formatTaka(amount: number): string {
  const hasDecimals = amount % 1 !== 0;
  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `৳ ${formatted}`;
}

/** Digits-only price for clipboard, e.g. "1250" or "1250.50". */
export function plainPrice(amount: number): string {
  return amount % 1 === 0 ? String(amount) : amount.toFixed(2);
}

/** Lowercase + strip accents/diacritics for accent-insensitive search. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Up to two initials for an avatar fallback, e.g. "Naeem Islam" -> "NI". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');
}

/** Auto-generate a URL slug: lowercase, spaces→hyphens, strip special chars. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
