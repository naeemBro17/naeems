import type { DeliveryZoneId } from '../features/checkout/types';

/**
 * The one place that decides which delivery zone a chosen District/Thana
 * maps to. The app currently only has two zones (see
 * features/checkout/types.ts DELIVERY_ZONES) — Inside Dhaka and Outside
 * Dhaka — matching Steadfast's two simplest rate tiers. Steadfast (and most
 * BD couriers) actually price a third tier for Dhaka's outer upazilas
 * (Savar, Keraniganj, Dhamrai, Nawabganj, Dohar) that's cheaper than
 * "outside Dhaka" but pricier than central Dhaka delivery — until Naeem
 * decides he wants that third tier (and its own fee) added to
 * DELIVERY_ZONES, those five outer upazilas are mapped to 'outside_dhaka'
 * here, since that fee is closer to Steadfast's real cost for them than the
 * cheaper inside-Dhaka fee would recover. See reports/batch-16.txt for the
 * full mapping table — confirm this judgment call is right for you.
 *
 * Everything else (all 63 non-Dhaka districts) is 'outside_dhaka'.
 */

const DHAKA_OUTER_UPAZILAS = new Set([
  'Savar',
  'Dhamrai',
  'Keraniganj',
  'Nawabganj',
  'Dohar',
]);

/** Given the chosen District and Thana/Upazila names, returns which existing
 *  delivery zone the order should default to. */
export function zoneForAddress(district: string | null, thana: string | null): DeliveryZoneId {
  if (district !== 'Dhaka') return 'outside_dhaka';
  if (thana !== null && DHAKA_OUTER_UPAZILAS.has(thana)) return 'outside_dhaka';
  return 'inside_dhaka';
}
