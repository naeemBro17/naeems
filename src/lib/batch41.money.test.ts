import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMINDER_TEMPLATE,
  KIND_GROUPS,
  categoryShares,
  customerOrderLink,
  dayText,
  duePhoneKey,
  kindIsIn,
  monthRange,
  moneyText,
  openingDueAmount,
  parseAmount,
  periodRange,
  readDueRows,
  reminderMessage,
  reminderWhatsAppUrl,
  signedMoney,
  typeLabel,
  writeOffReasonLabel,
} from './money/format';
import { billPhotoPath } from './money/bills';
import { BILL_PHOTO_MAX_BYTES, BILL_PHOTO_TRIES } from './imageResize';
import { canOpenSection, visibleNavItems } from './adminNav';
import { STAFF_PERMISSIONS } from './staff';
import type { StaffPermission } from '../types';

const staffWith = (perms: StaffPermission[]) => ({ isAdmin: false, can: (p: StaffPermission) => perms.includes(p) });

describe('Batch 41 — money amounts', () => {
  it('shows taka with Bangladeshi grouping and paisa only when there are any', () => {
    expect(moneyText(124300)).toBe('৳1,24,300');
    expect(moneyText(415.2)).toBe('৳415.20');
    expect(moneyText(64.8)).toBe('৳64.80');
    expect(moneyText(-500)).toBe('−৳500');
    expect(moneyText(0.1 + 0.2)).toBe('৳0.30');
    expect(signedMoney(500, true)).toBe('+৳500');
    expect(signedMoney(-500, true)).toBe('−৳500');
  });

  it('reads typed amounts: commas, ৳, spaces, Bangla digits; refuses words and 3 decimals', () => {
    expect(parseAmount('1,000')).toBe(1000);
    expect(parseAmount('৳ 2 500')).toBe(2500);
    expect(parseAmount('১২৫০')).toBe(1250);
    expect(parseAmount('99.5')).toBe(99.5);
    expect(parseAmount('-120')).toBe(-120);
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('1.005')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
});

describe('Batch 41 — the Add money form', () => {
  it('has the six big buttons in the brief\'s order', () => {
    expect(KIND_GROUPS.map((g) => g.label)).toEqual(['Expense', 'Move money', 'Investor', 'Me', 'Not shop money', 'Pay what I owe']);
  });

  it('"Add money entries" alone gets only Expense and Move money', () => {
    expect(KIND_GROUPS.filter((g) => !g.profitOnly).map((g) => g.id)).toEqual(['expense', 'transfer']);
  });

  it('knows which way the money goes', () => {
    expect(kindIsIn('investor_in')).toBe(true);
    expect(kindIsIn('owner_money_in')).toBe(true);
    expect(kindIsIn('expense')).toBe(false);
    expect(kindIsIn('investor_profit_share')).toBe(false);
    expect(kindIsIn('transfer')).toBeNull();
  });

  it('labels every ledger line in plain words', () => {
    expect(typeLabel('courier_fees')).toBe('Courier & COD fees (in order profit)');
    expect(typeLabel('customer_payment')).toBe('Customer payment');
    expect(writeOffReasonLabel('damaged_return')).toBe('Damaged return');
    expect(writeOffReasonLabel('own_use')).toBe('Own use');
  });
});

describe('Batch 41 — periods and shares', () => {
  it('Today / This month / This year / Custom', () => {
    expect(periodRange('today', '2026-10-11', { from: '', to: '' })).toEqual({ from: '2026-10-11', to: '2026-10-11' });
    expect(periodRange('month', '2026-10-11', { from: '', to: '' })).toEqual({ from: '2026-10-01', to: '2026-10-11' });
    expect(periodRange('year', '2026-10-11', { from: '', to: '' })).toEqual({ from: '2026-01-01', to: '2026-10-11' });
    expect(periodRange('custom', '2026-10-11', { from: '2026-09-01', to: '2026-09-30' })).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('a month runs to its last day (February in a leap year too)', () => {
    expect(monthRange('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(dayText('2026-10-11')).toBe('11 Oct 2026');
  });

  it('category shares are whole percents that add up to 100', () => {
    const shares = categoryShares([{ amount: 1000 }, { amount: 1000 }, { amount: 1000 }]);
    expect(shares.map((s) => s.percent).reduce((a, b) => a + b, 0)).toBe(100);
    expect(categoryShares([{ amount: 750 }, { amount: 250 }]).map((s) => s.percent)).toEqual([75, 25]);
    expect(categoryShares([{ amount: 0 }]).map((s) => s.percent)).toEqual([0]);
  });
});

describe('Batch 41 — due reminder', () => {
  const link = customerOrderLink('https://naeems-all.vercel.app/', 'abc-123');

  it('the link is our own order page, never another app', () => {
    expect(link).toBe('https://naeems-all.vercel.app/orders/abc-123');
  });

  it('fills the brief\'s message', () => {
    expect(reminderMessage(DEFAULT_REMINDER_TEMPLATE, { name: 'Rahima', due: 3070, date: '2026-10-11', link })).toBe(
      "Hello Rahima,\nYou have Tk. 3,070 left to pay as on 11 Oct 2026.\nThank you!\n– Naeem's - SkinScience\nView your orders: https://naeems-all.vercel.app/orders/abc-123"
    );
  });

  it('leaves out the "View your orders" line when the due is only a previous balance', () => {
    const text = reminderMessage(DEFAULT_REMINDER_TEMPLATE, { name: 'Rahima', due: 1000, date: '2026-10-11', link: null });
    expect(text).not.toContain('View your orders');
    expect(text.endsWith("– Naeem's - SkinScience")).toBe(true);
  });

  it('an empty Settings text falls back to the default', () => {
    expect(reminderMessage('  ', { name: 'A', due: 5, date: '2026-10-11', link: null })).toContain('Tk. 5 left to pay');
  });

  it('WhatsApp gets 880… however the phone was typed, and the text encoded', () => {
    for (const phone of ['01712345678', '+880 1712-345678', '8801712345678', '1712345678']) {
      expect(reminderWhatsAppUrl(phone, 'Hi & bye')).toBe('https://wa.me/8801712345678?text=Hi%20%26%20bye');
    }
    expect(reminderWhatsAppUrl('', 'x')).toBeNull();
  });
});

describe('Batch 41 — opening dues file', () => {
  it('reads phone / name / due_amount under the header, skips blank rows', () => {
    const { rows, error } = readDueRows([
      ['Customer dues'],
      ['phone', 'name', 'due_amount'],
      ['01712345678', 'Rahima', 1500],
      [null, null, null],
      [1812345678, 'Karim', '2,000'],
    ]);
    expect(error).toBeNull();
    expect(rows).toEqual([
      { phone: '01712345678', name: 'Rahima', due: '1500' },
      { phone: '1812345678', name: 'Karim', due: '2000' },
    ]);
  });

  it('a file without the columns is refused with a plain message', () => {
    expect(readDueRows([['a', 'b']]).error).toMatch(/phone, name and due_amount/);
  });

  it('phones match however they were typed (+880 / 0 / spaces)', () => {
    expect(duePhoneKey('+880 1712-345678')).toBe('01712345678');
    expect(duePhoneKey('1712345678')).toBe('01712345678');
    expect(duePhoneKey('12345')).toBeNull();
  });

  it('"already has a due on the site": keep the site due / use the Kaarbar due / add both', () => {
    expect(openingDueAmount(1000, 0, 'kaarbar')).toBe(1000);
    expect(openingDueAmount(1000, 380, 'keep_site')).toBe(0);
    expect(openingDueAmount(1000, 380, 'kaarbar')).toBe(620);
    expect(openingDueAmount(300, 380, 'kaarbar')).toBe(0);
    expect(openingDueAmount(1000, 380, 'both')).toBe(1000);
  });
});

describe('Batch 41 — bill photos', () => {
  it('under 150 KB, a new name every time, in a month folder', () => {
    expect(BILL_PHOTO_MAX_BYTES).toBe(150 * 1024);
    expect(BILL_PHOTO_TRIES[0].width).toBeGreaterThan(BILL_PHOTO_TRIES[BILL_PHOTO_TRIES.length - 1].width);
    const a = billPhotoPath('2026-10-11');
    const b = billPhotoPath('2026-10-11');
    expect(a).toMatch(/^bills\/2026-10\/[\w-]+\.webp$/);
    expect(a).not.toBe(b);
  });
});

describe('Batch 41 — who sees Money', () => {
  it('"View profit & costs" or "Add money entries" opens Money; nothing else does', () => {
    expect(canOpenSection('money', staffWith(['view_profit_costs']))).toBe(true);
    expect(canOpenSection('money', staffWith(['add_money_entries']))).toBe(true);
    expect(canOpenSection('money', staffWith(['view_orders', 'see_sales', 'view_customers']))).toBe(false);
    expect(visibleNavItems(staffWith(['add_money_entries'])).map((i) => i.id)).toContain('money');
  });

  it('the new switch "Add money entries" is in the Team list, after "View profit & costs"', () => {
    const ids = STAFF_PERMISSIONS.map((p) => p.id);
    expect(ids.slice(-2)).toEqual(['view_profit_costs', 'add_money_entries']);
  });
});
