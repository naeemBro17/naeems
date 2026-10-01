import { describe, expect, it } from 'vitest';
import { isTestOrder, parseIdList } from '../../supabase/functions/_shared/testOrders';

// Batch 25 Part 7: automatic-test orders never reach Telegram; real orders
// still do, exactly as before.

const accounts = { testCustomerId: 'cust-e2e', testStaffIds: ['staff-extra'] };
const real = { customerId: 'cust-real', customerName: 'Rahim Uddin', creatorId: 'cust-real', creatorUsername: null };

describe('isTestOrder', () => {
  it('lets a real customer order through', () => {
    expect(isTestOrder(real, accounts)).toBe(false);
  });

  it('lets a real manual order by the Super Admin through', () => {
    expect(isTestOrder({ customerId: null, customerName: 'Karim', creatorId: 'naeem-id', creatorUsername: 'naeem' }, accounts)).toBe(false);
  });

  it('lets a real order through when no test accounts are configured', () => {
    expect(isTestOrder(real, { testCustomerId: null, testStaffIds: [] })).toBe(false);
  });

  it('skips the e2e test customer', () => {
    expect(isTestOrder({ ...real, customerId: 'cust-e2e', customerName: 'Test' }, accounts)).toBe(true);
  });

  it('skips orders made by e2e.admin and test moderators', () => {
    expect(isTestOrder({ customerId: null, customerName: 'Anyone', creatorId: 'x', creatorUsername: 'e2e.admin' }, accounts)).toBe(true);
    expect(isTestOrder({ customerId: null, customerName: 'Anyone', creatorId: 'y', creatorUsername: 'E2E.mod' }, accounts)).toBe(true);
    expect(isTestOrder({ customerId: null, customerName: 'Anyone', creatorId: 'staff-extra', creatorUsername: null }, accounts)).toBe(true);
  });

  it('skips any order whose customer name starts with E2E', () => {
    expect(isTestOrder({ ...real, customerName: 'E2E Someone Else' }, accounts)).toBe(true);
    expect(isTestOrder({ ...real, customerName: '  e2e test' }, accounts)).toBe(true);
  });

  it('does not skip a name that only contains E2E later', () => {
    expect(isTestOrder({ ...real, customerName: 'Shop E2E' }, accounts)).toBe(false);
  });
});

describe('parseIdList', () => {
  it('splits a comma list and drops blanks', () => {
    expect(parseIdList(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(parseIdList(undefined)).toEqual([]);
  });
});
