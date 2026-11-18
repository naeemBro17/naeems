/** Batch 51 Part 5: the admin home clock's digits, in Dhaka time (UTC+6,
 *  no daylight saving) — 12-hour without AM/PM like the iPhone lock
 *  screen: 8:42, 12:05, 1:00; minutes and seconds always two digits. */
export function clockParts(now: Date): { hours: string; minutes: string; seconds: string } {
  const dhaka = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const h24 = dhaka.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return {
    hours: String(h12),
    minutes: String(dhaka.getUTCMinutes()).padStart(2, '0'),
    seconds: String(dhaka.getUTCSeconds()).padStart(2, '0'),
  };
}
