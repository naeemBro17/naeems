// Batch 68: the Account greeting, by the customer's own clock.
// 05:00 to 11:59 morning, 12:00 to 16:59 afternoon, 17:00 to 04:59 evening.
// ("Good Night" is a goodbye, so it is never used.)
export interface Greeting {
  text: 'Good Morning' | 'Good Afternoon' | 'Good Evening';
  icon: 'sun' | 'moon';
}

export function greetingFor(hour: number): Greeting {
  if (hour >= 5 && hour < 12) return { text: 'Good Morning', icon: 'sun' };
  if (hour >= 12 && hour < 17) return { text: 'Good Afternoon', icon: 'sun' };
  return { text: 'Good Evening', icon: 'moon' };
}

/** "Sadia Rahman" -> "SADIA"; empty / missing -> "THERE" (so it reads "HI THERE"). */
export function greetingName(fullName: string | null | undefined): string {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  return first === '' ? 'THERE' : first.toUpperCase();
}

/** "2026-10-05T…" -> "Oct 2026" (English month, the customer's own time zone). */
export function memberSince(createdAt: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}
