import { beforeEach, describe, expect, it } from 'vitest';
import { lotTotalText, lotsStockText, packStockText, packWord } from './inventory/unitText';
import { STOCK_UNITS } from './inventory/types';
import { parseMyStoreWallet, storeWalletOpenMessage, storeWalletRequestName, storeWalletWhatsAppUrl } from './storeWallet';
import { shopVisibleVariants } from './variants';
import { SWR_MAX_AGE_MS, clearSwr, dropOtherVersions, isFresh, readSwr, writeSwr } from './swrCache';
import { comboLineStatus } from '../components/combo/ComboItemsEditor';
import type { ProductVariant } from '../types';

describe('Batch 62: loose ml / tab', () => {
  it('tab is a stock unit', () => {
    expect(STOCK_UNITS).toEqual(['pcs', 'ml', 'g', 'tab']);
  });

  it('Lot total says each unit word', () => {
    expect(lotTotalText([{ units: 100, unit: 'ml' }])).toBe('100 ml');
    expect(lotTotalText([{ units: 2, unit: 'pcs' }, { units: 300, unit: 'ml' }])).toBe('2 pcs, 300 ml');
    expect(lotTotalText([{ units: 1600, unit: 'tab' }, { units: 400, unit: 'tab' }])).toBe('2,000 tab');
    expect(lotTotalText([])).toBe('0 pcs');
    expect(lotTotalText([{ units: 0, unit: 'ml' }])).toBe('0 pcs');
  });

  it('order form stock line: whole packs, then every unit', () => {
    expect(packStockText(473, 473, 'ml')).toBe('Stock: 1 bottle (473 ml)');
    expect(packStockText(300, 473, 'ml')).toBe('Stock: 0 bottles + 300 ml');
    expect(packStockText(1600, 400, 'tab')).toBe('Stock: 4 bottles (1,600 tab)');
    expect(packStockText(773, 473, 'ml')).toBe('Stock: 1 bottle + 300 ml (773 ml)');
    expect(packStockText(0, 473, 'ml')).toBe('Stock: 0 bottles (0 ml)');
    expect(packStockText(5, 1, 'pcs')).toBeNull();
  });

  it('Edit product Stock card in Mode On', () => {
    expect(lotsStockText(946, 473, 'ml')).toEqual({ packs: 2, text: 'bottles in lots (946 ml)' });
    expect(lotsStockText(5, 1, 'pcs')).toEqual({ packs: 5, text: 'bottles in lots' });
    expect(lotsStockText(1, 1, 'pcs')).toEqual({ packs: 1, text: 'bottle in lots' });
    expect(packWord(1)).toBe('bottle');
    expect(packWord(0)).toBe('bottles');
  });
});

describe('Batch 62: wallet by invitation', () => {
  it('open comes from the database; before migration-061 every wallet counts as open', () => {
    expect(parseMyStoreWallet({ available: true, open: false }).open).toBe(false);
    expect(parseMyStoreWallet({ available: true, open: true }).open).toBe(true);
    expect(parseMyStoreWallet({ available: true }).open).toBe(true);
    expect(parseMyStoreWallet({ available: false }).open).toBe(false);
  });

  it('the WhatsApp text to ask for a wallet', () => {
    expect(storeWalletOpenMessage(' Rina Akter ')).toBe('হাই, আমি আমার Wallet চালু করতে চাই।\nনাম: Rina Akter');
    const url = storeWalletWhatsAppUrl('01711000062', storeWalletOpenMessage('Rina'));
    expect(url).not.toBeNull();
    expect(decodeURIComponent((url ?? '').split('?text=')[1])).toBe('হাই, আমি আমার Wallet চালু করতে চাই।\nনাম: Rina');
  });

  it('a wallet request is listed by name, else phone, else "A customer" (never the key)', () => {
    expect(storeWalletRequestName('Rina')).toBe('Rina');
    expect(storeWalletRequestName('p:f05af719-1111-2222-3333-444455556666')).toBe('A customer');
    expect(storeWalletRequestName('ph:01712345678')).toBe('01712345678');
    expect(storeWalletRequestName('', '01812345678')).toBe('01812345678');
    expect(storeWalletRequestName('  ')).toBe('A customer');
  });
});

describe('Batch 62: hide a size from the shop', () => {
  const v = (id: string, is_visible?: boolean) => ({ id, product_id: 'p', is_visible }) as ProductVariant;
  it('hidden sizes are left out; nothing hidden keeps the same list', () => {
    const all = [v('a'), v('b', false), v('c', true)];
    expect(shopVisibleVariants(all).map((x) => x.id)).toEqual(['a', 'c']);
    const none = [v('a'), v('c', true)];
    expect(shopVisibleVariants(none)).toBe(none);
  });
});

describe('Batch 62: combo line status', () => {
  it('as the product page would say it', () => {
    expect(comboLineStatus({ available: false, facts: { keepSelling: false, stock: 0 }, lowText: null })).toBe('Out of stock');
    expect(comboLineStatus({ available: true, facts: { keepSelling: true, stock: 0 }, lowText: null })).toBe('Keep selling: bought after the order');
    expect(comboLineStatus({ available: true, facts: { keepSelling: false, stock: 2 }, lowText: 'Only 2 left — order soon' })).toBe(
      'Only 2 left — order soon'
    );
    expect(comboLineStatus({ available: true, facts: { keepSelling: false, stock: 20 }, lowText: null })).toBe('In stock');
  });
});

describe('Batch 62: saved copies (stale-while-revalidate)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('write, read, fresh for 60 seconds', () => {
    writeSwr('home:u1', { n: 3 }, 1_000);
    expect(readSwr<{ n: number }>('home:u1')).toEqual({ data: { n: 3 }, at: 1_000 });
    expect(isFresh(1_000, 1_000 + SWR_MAX_AGE_MS - 1)).toBe(true);
    expect(isFresh(1_000, 1_000 + SWR_MAX_AGE_MS)).toBe(false);
    expect(readSwr('nothing')).toBeNull();
  });

  it('a broken copy is no copy', () => {
    const key = Object.keys(window.localStorage).length;
    expect(key).toBe(0);
    writeSwr('x', 1);
    const stored = Object.keys(window.localStorage)[0];
    window.localStorage.setItem(stored, '{not json');
    expect(readSwr('x')).toBeNull();
  });

  it('sign-out clears every copy and the old product cache; another version is dropped at start', () => {
    writeSwr('a', 1);
    window.localStorage.setItem('price_hub_v1', '{}');
    window.localStorage.setItem('nh-swr:0.0.1:old', '{"data":1,"at":1}');
    window.localStorage.setItem('other-app-key', 'keep');
    dropOtherVersions();
    expect(window.localStorage.getItem('nh-swr:0.0.1:old')).toBeNull();
    expect(readSwr('a')).not.toBeNull();
    clearSwr();
    expect(readSwr('a')).toBeNull();
    expect(window.localStorage.getItem('price_hub_v1')).toBeNull();
    expect(window.localStorage.getItem('other-app-key')).toBe('keep');
  });
});
