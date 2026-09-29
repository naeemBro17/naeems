/** Steadfast's generic tracking page, where a customer types the tracking
 *  code themselves. */
export const STEADFAST_GENERIC_TRACKING_URL = 'https://steadfast.com.bd/tracking';

/**
 * The link a "Track parcel" button opens, for the customer's order page and
 * the admin order screen alike (Batch 23 Part 5): Steadfast's own per-parcel
 * link (https://steadfast.com.bd/tl/...) saved from the booking response, or
 * the generic tracking page for a parcel booked before that link was saved.
 * Steadfast's API only returns the per-parcel link when the parcel is
 * booked — its status endpoints don't — so an older parcel can't get one
 * afterwards. Only an https link on steadfast.com.bd is trusted.
 */
export function steadfastTrackingUrl(savedLink: string | null | undefined): string {
  if (!savedLink) return STEADFAST_GENERIC_TRACKING_URL;
  try {
    const url = new URL(savedLink);
    const host = url.hostname.toLowerCase();
    const isSteadfast = host === 'steadfast.com.bd' || host.endsWith('.steadfast.com.bd');
    return url.protocol === 'https:' && isSteadfast ? url.href : STEADFAST_GENERIC_TRACKING_URL;
  } catch {
    return STEADFAST_GENERIC_TRACKING_URL;
  }
}

/** True when the order has its own per-parcel link, not the fallback. */
export function hasOwnTrackingLink(savedLink: string | null | undefined): boolean {
  return steadfastTrackingUrl(savedLink) !== STEADFAST_GENERIC_TRACKING_URL;
}
