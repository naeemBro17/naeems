// Batch 25 Part 7: which orders are automatic-test orders, so they never
// reach Naeem's Telegram. Plain TypeScript with no Deno imports, so the
// same file is unit-tested by vitest (src/lib/testOrders.test.ts).
//
// An order is a test order when ANY of these is true:
//   - it belongs to the fixed e2e test customer (E2E_TEST_CUSTOMER_ID);
//   - it was made by a test staff login: every test account's username
//     starts with "e2e." (e2e.admin, e2e.mod, e2e.role ...) or is listed in
//     E2E_TEST_STAFF_IDS;
//   - the customer name starts with "E2E" (any capitals), e.g. the tests'
//     "E2E Someone Else" manual order that reached Telegram as NM-1046.
// Everything else is a real order and notifies exactly as before.

export interface TestOrderFacts {
  customerId: string | null;
  customerName: string | null;
  /** Who created the order (first history row), when known. */
  creatorId: string | null;
  creatorUsername: string | null;
}

export interface TestAccounts {
  testCustomerId: string | null;
  /** Extra test staff login ids (comma-separated secret). */
  testStaffIds: readonly string[];
}

export const TEST_STAFF_PREFIX = 'e2e.';

export function parseIdList(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function isTestOrder(order: TestOrderFacts, accounts: TestAccounts): boolean {
  if (accounts.testCustomerId && order.customerId === accounts.testCustomerId) return true;
  if (order.creatorId && accounts.testStaffIds.includes(order.creatorId)) return true;
  if (order.customerId && accounts.testStaffIds.includes(order.customerId)) return true;
  const username = (order.creatorUsername ?? '').trim().toLowerCase();
  if (username.startsWith(TEST_STAFF_PREFIX)) return true;
  const name = (order.customerName ?? '').trim().toLowerCase();
  if (name.startsWith('e2e')) return true;
  return false;
}
