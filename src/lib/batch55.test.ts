import { describe, expect, it } from 'vitest';
import type { CustomerRow } from './adminData';
import { initial, joinCandidates, joinReason, mobileKey, numberLabel, phoneText, JOIN_LIMIT, REASON_LOGIN, REASON_NO_PHONE } from './customerNumbers';
import { parseAdminSubPage, adminPath, canOpenSubPage, subPageFallback } from './adminPages';
import { wrongCustomer } from './kaarbar/merge';

function row(over: Partial<CustomerRow>): CustomerRow {
  return {
    key: 'ph:01700000001',
    id: null,
    full_name: 'Test Person',
    email: '',
    phone: '01700000001',
    order_count: 0,
    total_spent: 0,
    last_order_at: null,
    joined_at: null,
    total_due: 0,
    hidden: false,
    note: null,
    alt_phone: null,
    added_by_hand: false,
    all_orders: 0,
    ...over,
  };
}

describe('Batch 55: phoneText', () => {
  it('shows a Bangladeshi mobile as 5 + 6 digits, however it was typed', () => {
    expect(phoneText('01977123456')).toBe('01977 123456');
    expect(phoneText('+880 1977-123456')).toBe('01977 123456');
    expect(phoneText('8801977123456')).toBe('01977 123456');
    expect(phoneText('1977123456')).toBe('01977 123456');
  });
  it('keeps anything else as typed, and empty as empty', () => {
    expect(phoneText('12345')).toBe('12345');
    expect(phoneText('')).toBe('');
    expect(phoneText(null)).toBe('');
  });
  it('mobileKey accepts only a valid mobile number (as admin_add_customer)', () => {
    expect(mobileKey('01811 654321')).toBe('01811654321');
    expect(mobileKey('01211654321')).toBeNull();
    expect(mobileKey('0181165432')).toBeNull();
  });
});

describe('Batch 55: number labels', () => {
  it('main, Kaarbar, merged and added numbers', () => {
    expect(numberLabel({ is_main: true, source: null })).toBe('Main number · used for delivery');
    expect(numberLabel({ is_main: false, source: 'kaarbar' })).toBe('Old number · saved from Kaarbar');
    expect(numberLabel({ is_main: false, source: 'merge' })).toBe('Old number · from a merged customer');
    expect(numberLabel({ is_main: false, source: 'added' })).toBe('Other number');
  });
});

describe('Batch 55: wrongCustomer with all the numbers', () => {
  const s = { partyName: 'Jarin', phone: '01811654321', phoneKey: '01811654321' };
  it('the main number matches', () => {
    expect(wrongCustomer(s, { name: 'Jarin Akter', phone: '01811-654321' })).toBeNull();
  });
  it('an extra number matches', () => {
    expect(wrongCustomer(s, { name: 'Jarin Akter', phone: '01977123456', numbers: ['01977123456', '01811654321'] })).toBeNull();
  });
  it('no number matches', () => {
    expect(wrongCustomer(s, { name: 'Jarin', phone: '01977123456', numbers: ['01977123456', '01555000000'] })).not.toBeNull();
  });
  it('no number in the PDF: the same name matches', () => {
    const noPhone = { partyName: 'Jarin Akter', phone: '', phoneKey: null };
    expect(wrongCustomer(noPhone, { name: 'jarin akter', phone: '01977123456', numbers: ['01977123456'] })).toBeNull();
  });
  it('no number in the PDF: another name does not', () => {
    const noPhone = { partyName: 'Someone Else', phone: '', phoneKey: null };
    expect(wrongCustomer(noPhone, { name: 'Jarin Akter', phone: '01977123456', numbers: ['01977123456'] })).not.toBeNull();
  });
});

describe('Batch 55: Merge with another customer — search and reasons', () => {
  const rows: CustomerRow[] = [
    row({ key: 'ph:01977123456', full_name: 'Jarin Akter', phone: '01977123456', total_due: 27, order_count: 3 }),
    row({ key: 'ph:01811654321', full_name: 'Jarin', phone: '01811654321', order_count: 2 }),
    row({ key: 'p:abc', id: 'abc', full_name: 'Jarin Login', email: 'jarin@example.com', phone: '01556778899' }),
    row({ key: 'n:jarin no phone', full_name: 'Jarin No Phone', phone: '' }),
    row({ key: 'ph:01700000009', full_name: 'Other', phone: '01700000009' }),
  ];

  it('finds by name, never this customer', () => {
    const found = joinCandidates(rows, 'ph:01977123456', 'jarin');
    expect(found.map((r) => r.key)).toEqual(['ph:01811654321', 'p:abc', 'n:jarin no phone']);
  });
  it('finds by number however it is typed', () => {
    expect(joinCandidates(rows, 'ph:01977123456', '01811 654').map((r) => r.key)).toEqual(['ph:01811654321']);
    expect(joinCandidates(rows, 'ph:01977123456', '+8801811').map((r) => r.key)).toEqual(['ph:01811654321']);
  });
  it('an empty search shows nobody', () => {
    expect(joinCandidates(rows, 'ph:01977123456', '  ')).toEqual([]);
  });
  it('a customer with a login or no phone has a reason and cannot be picked', () => {
    const found = joinCandidates(rows, 'ph:01977123456', 'jarin');
    expect(found.find((r) => r.key === 'p:abc')?.reason).toBe(REASON_LOGIN);
    expect(found.find((r) => r.key === 'n:jarin no phone')?.reason).toBe(REASON_NO_PHONE);
    expect(found.find((r) => r.key === 'ph:01811654321')?.reason).toBeNull();
    expect(joinReason({ id: 'x', phone: '' })).toBe(REASON_LOGIN);
  });
  it('the due shown is the due on orders + the previous balance', () => {
    const found = joinCandidates(rows, 'ph:01811654321', 'akter', new Map([['ph:01977123456', 100]]));
    expect(found[0].due).toBe(127);
    expect(found[0].orders).toBe(3);
  });
  it('at most 20 results', () => {
    const many = Array.from({ length: 30 }, (_, i) => row({ key: `ph:0170000${String(i).padStart(4, '0')}`, full_name: `Same Name ${i}` }));
    expect(joinCandidates(many, 'ph:x', 'same name')).toHaveLength(JOIN_LIMIT);
    expect(JOIN_LIMIT).toBe(20);
  });
  it('the round letter', () => {
    expect(initial('jarin')).toBe('J');
    expect(initial('  ')).toBe('?');
  });
});

describe('Batch 55: the join page route', () => {
  it('parses, links with ?pick=, Super Admin only, back to the customer', () => {
    const page = parseAdminSubPage('/admin/customers/ph%3A01977123456/join');
    expect(page).toEqual({ kind: 'join-customer', customerKey: 'ph:01977123456' });
    expect(adminPath.customerJoin('ph:01977123456')).toBe('/admin/customers/ph%3A01977123456/join');
    expect(adminPath.customerJoin('ph:01977123456', 'ph:01811654321')).toBe('/admin/customers/ph%3A01977123456/join?pick=ph%3A01811654321');
    if (page === null || page === 'unknown') throw new Error('not parsed');
    expect(canOpenSubPage(page, { isAdmin: true, can: () => true })).toBe(true);
    expect(canOpenSubPage(page, { isAdmin: false, can: () => true })).toBe(false);
    expect(subPageFallback(page)).toBe('/admin/customers/ph%3A01977123456');
  });
});
