import { TEST_STAFF_PREFIX } from '../../supabase/functions/_shared/testOrders';
import type { StaffMember } from '../types';

/**
 * Batch 31 Part 3: the automatic tests keep two fixed logins in the live
 * database (the test customer "E2E Test Customer" and the test Super Admin
 * "e2e.admin") and briefly create customers named "E2E …". They must stay
 * for the tests to run, but Naeem and his team should never see them in
 * their lists. Same naming rule as the Telegram filter (testOrders.ts):
 * a name starting with "E2E", or an e-mail starting with "e2e".
 */
export function isTestCustomer(c: { name?: string | null; email?: string | null }): boolean {
  const name = (c.name ?? '').trim().toLowerCase();
  const email = (c.email ?? '').trim().toLowerCase();
  return name.startsWith('e2e') || email.startsWith('e2e');
}

/** A test staff login (username "e2e.…") — the tests themselves still see
 *  their own test customers, so they can check them. */
export function isTestViewer(staff: Pick<StaffMember, 'username'> | null): boolean {
  return (staff?.username ?? '').toLowerCase().startsWith(TEST_STAFF_PREFIX);
}
