import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { customerKeyFor, markWalletNoteSeen, readWalletNoteSeen, shouldShowWalletNote, walletNoteKey } from './walletOpenNote';
import {
  DRAFT_MAX_AGE_MS,
  clearDraft,
  draftKey,
  draftTimeLabel,
  droppedItemsText,
  isDraftEmpty,
  loadDraft,
  restorableLines,
  saveDraft,
  type NewOrderDraftData,
} from './newOrderDraft';
import { arrivalText, deliveryLine, lowStockText, rangeWithTo } from './sellRules';
import { lineNameWithUnits } from './orderLines';

/* ------------------------------------------------------------ Part 1 */

/** Every string and JSX text in a file (comments are not included). */
function textsIn(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      out.push(node.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('Batch 64 Part 1: no long dashes in what customers read', () => {
  // Customer pages and components, the texts they share, and link previews.
  const files = [
    ...sourceFiles('src/pages').filter((f) => !/AdminPage|AdminAccessPage/.test(f)),
    ...sourceFiles('src/components/viewer'),
    ...sourceFiles('src/components/shared'),
    ...sourceFiles('src/components/checkout'),
    ...sourceFiles('src/components/combo'),
    ...sourceFiles('src/components/orders'),
    ...sourceFiles('src/components/expert'),
    ...sourceFiles('src/components/account'),
    ...sourceFiles('src/components/wallet'),
    ...sourceFiles('src/features'),
    'src/contexts/ProductContext.tsx',
    'src/lib/sellRules.ts',
    'src/lib/share.ts',
    'src/lib/clipboard.ts',
    'src/lib/orderLines.ts',
    'src/lib/invoice/invoiceData.ts',
    'api/_og.ts',
    'api/brand-og.ts',
  ];
  // Admin-only words that live in shared customer files.
  const adminOnly = ['Steadfast reports a problem with this parcel'];

  it('strings and screen text', () => {
    for (const file of files) {
      const bad = textsIn(file).filter((t) => /[–—]/.test(t) && !adminOnly.some((a) => t.includes(a)));
      expect(bad, file).toEqual([]);
    }
  });

  it('index.html and the offline page', () => {
    for (const file of ['index.html', 'public/offline.html']) {
      const html = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      expect(html, file).not.toMatch(/[–—]/);
    }
  });

  it('ranges read "to", also a dash saved in Settings', () => {
    expect(rangeWithTo('1–2 days')).toBe('1 to 2 days');
    expect(rangeWithTo('3 — 5 days')).toBe('3 to 5 days');
    expect(deliveryLine({ delivery_time_buy_after: '4–6 days' }, { available: true, inHand: false })).toBe('Get it in 4 to 6 days');
    expect(arrivalText('2026-11-19T06:00:00Z', 'inside_dhaka', true, {})).toBe('Arriving Sun, 22 to Tue, 24 Nov');
    expect(lowStockText({ keepSelling: false, stock: 2 }, 4)).toBe('Only 2 left, order soon');
    expect(lineNameWithUnits('Fish Oil', { sold_unit: 'pcs', quantity: 150 })).toBe('Fish Oil, 150 pcs');
  });
});

/* ------------------------------------------------------------ Part 4 */

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

class BrokenStorage extends MemoryStorage {
  getItem(): string | null {
    throw new Error('blocked');
  }
  setItem(): void {
    throw new Error('blocked');
  }
}

describe('Batch 64 Part 4: "Your wallet is open" shows once', () => {
  const key = customerKeyFor('u-1');

  it('the key holds her customer key', () => {
    expect(key).toBe('p:u-1');
    expect(walletNoteKey(key)).toBe('naeems.walletOpenSeen.p:u-1');
  });

  it('open + signed-in customer + not seen → show; anything else → hide', () => {
    expect(shouldShowWalletNote({ isCustomer: true, walletOpen: true, seen: false })).toBe(true);
    expect(shouldShowWalletNote({ isCustomer: true, walletOpen: true, seen: true })).toBe(false);
    expect(shouldShowWalletNote({ isCustomer: true, walletOpen: false, seen: false })).toBe(false);
    expect(shouldShowWalletNote({ isCustomer: false, walletOpen: true, seen: false })).toBe(false);
    expect(shouldShowWalletNote({ isCustomer: false, walletOpen: false, seen: false })).toBe(false);
  });

  it('storage that throws → hidden (never shown every time)', () => {
    const seen = readWalletNoteSeen(key, new BrokenStorage());
    expect(seen).toBeNull();
    expect(shouldShowWalletNote({ isCustomer: true, walletOpen: true, seen })).toBe(false);
    expect(readWalletNoteSeen(key, null)).toBeNull();
    expect(() => markWalletNoteSeen(key, new BrokenStorage())).not.toThrow();
  });

  it('marked seen → never again on this device', () => {
    const storage = new MemoryStorage();
    expect(readWalletNoteSeen(key, storage)).toBe(false);
    markWalletNoteSeen(key, storage);
    expect(readWalletNoteSeen(key, storage)).toBe(true);
    expect(readWalletNoteSeen(customerKeyFor('u-2'), storage)).toBe(false);
  });
});

/* ------------------------------------------------------------ Part 6b */

function draft(patch: Partial<NewOrderDraftData> = {}): NewOrderDraftData {
  return {
    source: null,
    address: { fullName: '', phone: '', division: '', district: '', thana: '', fullAddress: '' },
    altPhone: '',
    pickedCustomer: null,
    customerQuery: '',
    lines: [],
    zone: 'inside_dhaka',
    zoneTouched: false,
    zoneFromSource: false,
    feeInput: '70',
    orderDiscountInput: '0',
    discountReason: null,
    discountNote: '',
    paidNowInput: '',
    paidMethod: null,
    paidTrxId: '',
    collectMode: 'cod',
    markDelivered: false,
    adminNote: '',
    ...patch,
  };
}

describe('Batch 64 Part 6b: the New order draft', () => {
  const now = new Date(2026, 10, 24, 22, 42).getTime();
  const typed = draft({
    source: 'facebook',
    address: { fullName: 'Rahima', phone: '01711111111', division: 'Dhaka', district: 'Dhaka', thana: 'Mirpur', fullAddress: 'Road 1' },
    lines: [{ productId: 'p1', variantId: null, quantity: 2, soldUnit: null, soldPriceInput: '950', reason: 'promotion', reasonNote: '' }],
    adminNote: 'Call first',
  });

  it('one draft per staff login', () => {
    expect(draftKey('staff-1')).toBe('naeems.newOrderDraft.staff-1');
  });

  it('an untouched form is empty and is not kept', () => {
    const storage = new MemoryStorage();
    expect(isDraftEmpty(draft())).toBe(true);
    saveDraft('s', draft(), now, storage);
    expect(storage.length).toBe(0);
    expect(isDraftEmpty(draft({ adminNote: 'x' }))).toBe(false);
    expect(isDraftEmpty(draft({ source: 'phone' }))).toBe(false);
  });

  it('saved, then read back exactly while fresh', () => {
    const storage = new MemoryStorage();
    saveDraft('s', typed, now, storage);
    const back = loadDraft('s', now + 60_000, storage);
    expect(back?.savedAt).toBe(now);
    expect(back?.data).toEqual(typed);
    expect(loadDraft('other', now, storage)).toBeNull();
  });

  it('expires after 12 hours and is deleted silently', () => {
    const storage = new MemoryStorage();
    saveDraft('s', typed, now, storage);
    expect(loadDraft('s', now + DRAFT_MAX_AGE_MS, storage)).not.toBeNull();
    expect(loadDraft('s', now + DRAFT_MAX_AGE_MS + 1, storage)).toBeNull();
    expect(storage.getItem(draftKey('s'))).toBeNull();
  });

  it('cleared on demand; an unreadable one is deleted', () => {
    const storage = new MemoryStorage();
    saveDraft('s', typed, now, storage);
    clearDraft('s', storage);
    expect(loadDraft('s', now, storage)).toBeNull();
    storage.setItem(draftKey('s'), '{not json');
    expect(loadDraft('s', now, storage)).toBeNull();
    expect(storage.getItem(draftKey('s'))).toBeNull();
  });

  it('storage that throws: no draft, no error', () => {
    const broken = new BrokenStorage();
    expect(() => saveDraft('s', typed, now, broken)).not.toThrow();
    expect(loadDraft('s', now, broken)).toBeNull();
    expect(() => clearDraft('s', broken)).not.toThrow();
  });

  it('the bar time: today "10:42 PM", another day "23 Nov, 10:42 PM"', () => {
    expect(draftTimeLabel(now, now + 1000)).toBe('10:42 PM');
    expect(draftTimeLabel(now, now + 24 * 60 * 60 * 1000)).toBe('24 Nov, 10:42 PM');
    expect(draftTimeLabel(new Date(2026, 10, 24, 0, 5).getTime(), now)).toBe('12:05 AM');
  });

  it('items no longer for sale are left out, with the toast text', () => {
    const lines = [...typed.lines, { ...typed.lines[0], productId: 'gone' }];
    const { kept, dropped } = restorableLines(lines, (l) => (l.productId === 'p1' ? { id: 'p1' } : null));
    expect(kept.map((k) => k.option.id)).toEqual(['p1']);
    expect(dropped).toBe(1);
    expect(droppedItemsText(1)).toBe('1 item was left out because it is no longer available.');
    expect(droppedItemsText(2)).toBe('2 items were left out because they are no longer available.');
  });
});
