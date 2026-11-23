import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADVANCE_MIN,
  advanceDiscountFor,
  advanceQualifies,
  defaultStoreWalletAccount,
  parseMyStoreWallet,
  splitStoreWallet,
  storeWalletDay,
  storeWalletEntryLabel,
  storeWalletSigned,
  storeWalletWhatsAppMessage,
  storeWalletWhatsAppUrl,
} from './storeWallet';
import { invoiceFromSnapshot } from './invoice/invoiceData';
import type { AdvanceDiscountRule } from './advanceDiscount';
import type { OrderSnapshot } from '../features/checkout/types';

const FIXED_50: AdvanceDiscountRule = { enabled: true, type: 'fixed', value: 50 };
const HALF: AdvanceDiscountRule = { enabled: true, type: 'percent', value: 0.5 };

describe('Batch 60: splitting an order between the wallet and the rest', () => {
  it('the wallet pays first, up to the balance', () => {
    expect(splitStoreWallet(1070, 3000, true)).toEqual({ fromStore: 1070, rest: 0, fullyPaid: true });
    expect(splitStoreWallet(1070, 500, true)).toEqual({ fromStore: 500, rest: 570, fullyPaid: false });
  });
  it('off (or nothing in it) takes nothing', () => {
    expect(splitStoreWallet(1070, 3000, false)).toEqual({ fromStore: 0, rest: 1070, fullyPaid: false });
    expect(splitStoreWallet(1070, 0, true)).toEqual({ fromStore: 0, rest: 1070, fullyPaid: false });
  });
  it('never below 0 and to the paisa', () => {
    expect(splitStoreWallet(99.995, 50.004, true).fromStore).toBe(50);
    expect(splitStoreWallet(-5, 100, true)).toEqual({ fromStore: 0, rest: 0, fullyPaid: false });
  });
});

describe('Batch 60: the advance discount only from ৳1,000 paid in advance', () => {
  it('৳999 gets none, ৳1,000 gets it', () => {
    expect(ADVANCE_MIN).toBe(1000);
    expect(advanceQualifies(999)).toBe(false);
    expect(advanceQualifies(999.99)).toBe(false);
    expect(advanceQualifies(1000)).toBe(true);
    expect(advanceDiscountFor({ rule: FIXED_50, productsAfterPromo: 929, leftAfterStore: 999, method: 'bkash' })).toBe(0);
    expect(advanceDiscountFor({ rule: FIXED_50, productsAfterPromo: 930, leftAfterStore: 1000, method: 'bkash' })).toBe(50);
  });
  it('cash on delivery never gets it', () => {
    expect(advanceDiscountFor({ rule: FIXED_50, productsAfterPromo: 5000, leftAfterStore: 5000, method: 'cod' })).toBe(0);
  });
  it('the wallet part never earns it: worked out on what is left after the wallet', () => {
    // ৳1,500 order, ৳500 from the wallet: ৳1,000 left in advance.
    expect(advanceDiscountFor({ rule: HALF, productsAfterPromo: 1430, leftAfterStore: 1000, method: 'nagad' })).toBe(5);
    // ৳1,429, ৳430 from the wallet: ৳999 left — none.
    expect(advanceDiscountFor({ rule: HALF, productsAfterPromo: 1359, leftAfterStore: 999, method: 'nagad' })).toBe(0);
  });
  it('never on delivery: the base is the products part of what is left', () => {
    // Products ৳1,000, delivery ৳70, nothing from the wallet: 0.5% of ৳1,000.
    expect(advanceDiscountFor({ rule: HALF, productsAfterPromo: 1000, leftAfterStore: 1070, method: 'bkash' })).toBe(5);
  });
});

describe('Batch 60: the WhatsApp message after "Add money"', () => {
  it('is the agreed Bangla text with the amount, method, transaction ID and name', () => {
    expect(storeWalletWhatsAppMessage({ amount: 3000, method: 'bkash', trx: '9AK2XYZ1AB', name: ' Ayesha ' })).toBe(
      'হাই, আমি আমার Wallet-এ ৳3,000 পাঠিয়েছি।\nbKash, Transaction ID: 9AK2XYZ1AB\nনাম: Ayesha\nপ্লিজ কনফার্ম করবেন। ধন্যবাদ!'
    );
    expect(storeWalletWhatsAppMessage({ amount: 500, method: 'nagad', trx: 'N1', name: 'Rahim' })).toContain('Nagad, Transaction ID: N1');
  });
  it('opens the shop number with the message typed; no number, no link', () => {
    const url = storeWalletWhatsAppUrl('01711-000000', 'hi there');
    expect(url).toBe('https://wa.me/8801711000000?text=hi%20there');
    expect(storeWalletWhatsAppUrl('', 'hi')).toBeNull();
  });
});

describe('Batch 60: history labels and amounts', () => {
  it('says what each row is', () => {
    expect(storeWalletEntryLabel({ kind: 'added', amount: 3000, orderNumber: null, byShop: false })).toBe('Added');
    expect(storeWalletEntryLabel({ kind: 'added', amount: 3000, orderNumber: null, byShop: true })).toBe("Added by NAEEM'S");
    expect(storeWalletEntryLabel({ kind: 'order', amount: -1000, orderNumber: 'NM-5120', byShop: false })).toBe('Used on order NM-5120');
    expect(storeWalletEntryLabel({ kind: 'order_back', amount: 1000, orderNumber: 'NM-5120', byShop: false })).toBe('Returned from order NM-5120');
    expect(storeWalletEntryLabel({ kind: 'order_back', amount: -70, orderNumber: 'NM-5120', byShop: false })).toBe('Used on order NM-5120');
    expect(storeWalletEntryLabel({ kind: 'overpaid', amount: 200, orderNumber: 'NM-5120', byShop: false })).toBe('Extra paid on order NM-5120');
    expect(storeWalletEntryLabel({ kind: 'correction', amount: -10, orderNumber: null, byShop: false })).toBe('Correction');
  });
  it('signs and days', () => {
    expect(storeWalletSigned(3000)).toBe('+৳3,000');
    expect(storeWalletSigned(-1070)).toBe('−৳1,070');
    expect(storeWalletDay('2026-11-23')).toBe('23 Nov 2026');
  });
});

describe('Batch 60: reading the database answer', () => {
  it('turns store_wallet_my() into numbers and lists', () => {
    const w = parseMyStoreWallet({
      available: true,
      balance: '3000.00',
      due: '70',
      waiting: [{ id: 'r1', amount: '2000', method: 'nagad', trx_id: 'ABC123', created_at: '2026-11-23T10:00:00Z' }],
      results: [{ id: 'r0', amount: '3000', method: 'bkash', status: 'confirmed', decided_at: '2026-11-23T09:00:00Z' }],
      history: [{ id: 'e1', date: '2026-11-23', at: 'x', kind: 'order', amount: '-1000', order_id: 'o1', order_number: 'NM-5120', by_shop: false }],
    });
    expect(w.balance).toBe(3000);
    expect(w.due).toBe(70);
    expect(w.waiting[0]).toMatchObject({ amount: 2000, method: 'nagad', trxId: 'ABC123' });
    expect(w.results[0]).toMatchObject({ status: 'confirmed', amount: 3000 });
    expect(w.history[0]).toMatchObject({ kind: 'order', amount: -1000, orderNumber: 'NM-5120' });
  });
  it('anything else is "no wallet"', () => {
    expect(parseMyStoreWallet(null).available).toBe(false);
    expect(parseMyStoreWallet('nope').balance).toBe(0);
  });
});

describe('Batch 60: the default account for a confirmed request', () => {
  const accounts = [
    { id: 'cash', payment_method: 'cash', kind: 'cash' },
    { id: 'bk', payment_method: 'bkash', kind: 'bkash' },
    { id: 'ng', payment_method: 'nagad', kind: 'nagad' },
    { id: 'sf', payment_method: 'cod_steadfast', kind: 'steadfast' },
  ];
  it('bKash for bKash, Nagad for Nagad, bKash when there is no Nagad account', () => {
    expect(defaultStoreWalletAccount(accounts, 'bkash')).toBe('bk');
    expect(defaultStoreWalletAccount(accounts, 'nagad')).toBe('ng');
    expect(defaultStoreWalletAccount(accounts.filter((a) => a.id !== 'ng'), 'nagad')).toBe('bk');
  });
});

describe('Batch 60: the customer invoice shows "Paid from wallet"', () => {
  const base: Omit<OrderSnapshot, 'paymentMethod'> = {
    orderId: 'o',
    orderNumber: 'NM-6001',
    items: [],
    zone: { id: 'inside_dhaka', label: 'Inside Dhaka', fee: 70 },
    address: { fullName: 'A', phone: '01711000000', division: 'Dhaka', district: 'Dhaka', thana: 'Gulshan', fullAddress: 'Road 1' },
    promo: null,
    subtotal: 1000,
    discount: 0,
    total: 1070,
    bkashTrxId: null,
    placedAt: '2026-11-23T10:00:00Z',
  };
  it('part wallet, rest on delivery', () => {
    const inv = invoiceFromSnapshot({ ...base, paymentMethod: 'cod', storeWallet: 1000 });
    expect(inv.paidRows).toContainEqual({ label: 'Paid from wallet', amount: 1000, minus: true });
    expect(inv.cod.amount).toBe(70);
    expect(inv.finalRow.amount).toBe(70);
  });
  it('fully from the wallet: nothing to collect', () => {
    const inv = invoiceFromSnapshot({ ...base, paymentMethod: 'cod', storeWallet: 1070 });
    expect(inv.cod.amount).toBe(0);
    expect(inv.paymentLabel).toBe('Paid (Wallet)');
  });
  it('no wallet: unchanged', () => {
    const inv = invoiceFromSnapshot({ ...base, paymentMethod: 'cod' });
    expect(inv.cod.amount).toBe(1070);
    expect(inv.paymentLabel).toBe('Cash on delivery');
  });
});

describe('Batch 60: customer text has no long dashes', () => {
  // Naeem dislikes the em dash and the en dash in what customers read.
  const files = [
    'src/pages/WalletPage.tsx',
    'src/components/wallet/AddMoneySheet.tsx',
    'src/hooks/useMyStoreWallet.ts',
  ];
  it('the wallet screens', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect(text, file).not.toMatch(/[–—]/);
    }
  });
  it('the migration keeps one transaction and needs no signed-in user', () => {
    const sql = readFileSync('supabase/migration-060-batch60.sql', 'utf8');
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).not.toMatch(/request\.jwt\.claims/);
  });
  it('the new style file is imported after the other batch files', () => {
    const main = readFileSync('src/main.tsx', 'utf8');
    expect(main.indexOf("import './styles/batch60.css';")).toBeGreaterThan(main.indexOf("import './styles/batch52.css';"));
    expect(statSync(join('src', 'styles', 'batch60.css')).size).toBeGreaterThan(0);
    expect(readdirSync(join('src', 'styles'))).toContain('batch60.css');
  });
});
