/**
 * Resolve the WhatsApp setting into an openable URL. The field accepts either
 * a full link or a bare phone number, which becomes a wa.me link.
 */
export function whatsAppUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  if (value.startsWith('http')) return value;
  const digits = value.replace(/[^\d]/g, '');
  return digits === '' ? null : `https://wa.me/${digits}`;
}

/** Open an external destination in a new tab, never leaking the opener. */
export function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}
