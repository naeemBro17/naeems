import { describe, expect, it } from 'vitest';
import {
  adminTitle,
  bottomTabs,
  formatTakaBd,
  greeting,
  greetingName,
  groupNavItems,
  moreItems,
  visibleNavItems,
} from './adminNav';
import type { StaffPermission } from '../types';

const superAdmin = { isAdmin: true, can: () => true };
const staffWith = (perms: StaffPermission[]) => ({ isAdmin: false, can: (p: StaffPermission) => perms.includes(p) });

describe('admin navigation', () => {
  it('Super Admin: sidebar groups in the mockup order, Brands in its reserved place (Batch 26)', () => {
    const groups = groupNavItems(visibleNavItems(superAdmin)).map((g) => [g.group.label, g.items.map((i) => i.label)]);
    expect(groups).toEqual([
      ['', ['Home', 'Orders', 'Shopping list', 'Steadfast payouts', 'Money', 'Reports', 'Customers']],
      ['CATALOG', ['Products', 'Inventory', 'Categories', 'Brands', 'Import / Export']],
      ['SALES', ['Promo Codes', 'Wholesalers', 'Reviews']],
      ['STORE DESIGN', ['Bento Tiles', 'Banner & Texts']],
      ['ADMIN', ['Team', 'Activity Log', 'Import from Kaarbar', 'Settings']],
    ]);
  });

  it('Super Admin: exactly 5 bottom tabs, More lists the rest', () => {
    const items = visibleNavItems(superAdmin);
    const tabs = bottomTabs(items);
    expect(tabs.map((t) => t.label)).toEqual(['Home', 'Orders', 'Products', 'Customers', 'More']);
    expect(moreItems(items, tabs).map((i) => i.id)).toEqual([
      'shopping', 'payouts', 'money', 'reports', 'inventory', 'categories', 'brands', 'import-export', 'promo-codes', 'wholesalers', 'reviews', 'bento', 'design', 'team', 'activity', 'kaarbar', 'settings',
    ]);
  });

  it('staff without Customers: the next allowed item takes its place', () => {
    const items = visibleNavItems(staffWith(['view_orders', 'edit_products', 'edit_categories', 'view_wholesalers']));
    const tabs = bottomTabs(items);
    expect(tabs).toHaveLength(5);
    // Batch 51: the Shopping list (right under Orders) is the next item.
    expect(tabs.map((t) => t.id)).toEqual(['home', 'orders', 'products', 'shopping', 'more']);
    expect(moreItems(items, tabs).map((i) => i.id)).toEqual(['categories', 'wholesalers', 'profile']);
  });

  it('staff only see what they may open; empty groups are dropped', () => {
    const items = visibleNavItems(staffWith(['view_orders']));
    expect(items.map((i) => i.id)).toEqual(['home', 'orders', 'shopping', 'profile']);
    expect(groupNavItems(items).map((g) => g.group.id)).toEqual(['main', 'admin']);
    expect(bottomTabs(items).map((t) => t.id)).toEqual(['home', 'orders', 'shopping', 'profile']);
  });

  it('Brands only with "Edit brands"', () => {
    expect(visibleNavItems(staffWith(['edit_products', 'edit_categories'])).map((i) => i.id)).not.toContain('brands');
    expect(visibleNavItems(staffWith(['edit_brands'])).map((i) => i.id)).toEqual(['home', 'brands', 'profile']);
  });

  it('Super-Admin-only sections never show for staff, whatever they have', () => {
    const all: StaffPermission[] = [
      'view_orders', 'change_order_status', 'create_orders', 'book_steadfast', 'edit_products',
      'edit_categories', 'view_customers', 'delete_early_orders', 'view_wholesalers', 'see_sales',
      'edit_brands', 'edit_customer_notes',
    ];
    const ids = visibleNavItems(staffWith(all)).map((i) => i.id);
    for (const id of ['team', 'activity', 'kaarbar', 'settings', 'import-export', 'promo-codes', 'reviews', 'bento', 'design']) {
      expect(ids).not.toContain(id);
    }
  });
});

describe('titles and greeting', () => {
  it('shows the role name in capitals for staff', () => {
    expect(adminTitle(true, null)).toBe("NAEEM'S SUPER ADMIN");
    expect(adminTitle(false, 'Manager')).toBe("NAEEM'S MANAGER");
    expect(adminTitle(false, null)).toBe("NAEEM'S MODERATOR");
  });

  it('greets in Bangladesh time (UTC+6)', () => {
    expect(greeting(new Date('2026-10-01T02:00:00Z'))).toBe('Good morning'); // 08:00 Dhaka
    expect(greeting(new Date('2026-10-01T08:00:00Z'))).toBe('Good afternoon'); // 14:00
    expect(greeting(new Date('2026-10-01T14:00:00Z'))).toBe('Good evening'); // 20:00
    expect(greeting(new Date('2026-09-30T20:30:00Z'))).toBe('Good evening'); // 02:30 (Batch 51: night is evening again)
    expect(greeting(new Date('2026-09-30T22:59:00Z'))).toBe('Good evening'); // 04:59
    expect(greeting(new Date('2026-09-30T23:00:00Z'))).toBe('Good morning'); // 05:00
    expect(greeting(new Date('2026-10-01T05:59:00Z'))).toBe('Good morning'); // 11:59
    expect(greeting(new Date('2026-10-01T06:00:00Z'))).toBe('Good afternoon'); // 12:00
    expect(greeting(new Date('2026-10-01T10:59:00Z'))).toBe('Good afternoon'); // 16:59
    expect(greeting(new Date('2026-10-01T11:00:00Z'))).toBe('Good evening'); // 17:00
  });

  it('uses the first name, else the username', () => {
    expect(greetingName('Naeem Hasan', 'naeem')).toBe('Naeem');
    expect(greetingName('', 'rafi')).toBe('Rafi');
  });
});

describe('formatTakaBd', () => {
  it('groups digits the Bangladeshi way', () => {
    expect(formatTakaBd(124300)).toBe('৳1,24,300');
    expect(formatTakaBd(18450)).toBe('৳18,450');
    expect(formatTakaBd(999)).toBe('৳999');
    expect(formatTakaBd(12345678)).toBe('৳1,23,45,678');
    expect(formatTakaBd(0)).toBe('৳0');
  });
});
