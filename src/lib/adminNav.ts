import type { StaffPermission } from '../types';

/**
 * Admin navigation (Batch 25 Part 1). One list drives the desktop sidebar,
 * the phone bottom bar and the More page, so the three can never disagree
 * about what exists or who may open it. Hiding an item is only tidiness —
 * the database refuses the same actions anyway (staff_can()).
 */
export type AdminSection =
  | 'home'
  | 'orders'
  | 'payouts'
  | 'customers'
  | 'products'
  | 'inventory'
  | 'categories'
  | 'brands'
  | 'import-export'
  | 'promo-codes'
  | 'wholesalers'
  | 'reviews'
  | 'bento'
  | 'design'
  | 'team'
  | 'activity'
  | 'settings'
  | 'profile'
  | 'more';

export type AdminIconName =
  | 'home'
  | 'orders'
  | 'payouts'
  | 'customers'
  | 'products'
  | 'inventory'
  | 'categories'
  | 'brands'
  | 'import'
  | 'promo'
  | 'wholesalers'
  | 'reviews'
  | 'bento'
  | 'design'
  | 'team'
  | 'activity'
  | 'settings'
  | 'profile'
  | 'more';

export type NavGroupId = 'main' | 'catalog' | 'sales' | 'design' | 'admin';

export interface NavGroup {
  id: NavGroupId;
  /** Sidebar heading ('' = no heading). */
  label: string;
  /** Heading on the phone's More page, where it differs (mockup screen 2). */
  moreLabel?: string;
}

export interface NavItem {
  id: AdminSection;
  label: string;
  /** Label on the More page, where the mockup words it differently. */
  moreLabel?: string;
  /** Short label for the bottom bar. */
  tabLabel?: string;
  icon: AdminIconName;
  group: NavGroupId;
  /** Shown with the small "Super Admin" pill on the More page. */
  superAdminOnly?: boolean;
  /** Not built yet — kept in the list so its place is fixed, never shown. */
  comingLater?: boolean;
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: 'main', label: '' },
  { id: 'catalog', label: 'CATALOG' },
  { id: 'sales', label: 'SALES' },
  { id: 'design', label: 'STORE DESIGN' },
  { id: 'admin', label: 'ADMIN', moreLabel: 'TEAM & SETTINGS' },
];

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', label: 'Home', icon: 'home', group: 'main' },
  { id: 'orders', label: 'Orders', icon: 'orders', group: 'main' },
  // Batch 36 Part 1: under Orders; only with "View profit & costs".
  { id: 'payouts', label: 'Steadfast payouts', tabLabel: 'Payouts', icon: 'payouts', group: 'main' },
  { id: 'customers', label: 'Customers', icon: 'customers', group: 'main' },
  { id: 'products', label: 'Products', icon: 'products', group: 'catalog' },
  // Batch 38: lots, landed cost, opening stock; only with "View profit & costs".
  { id: 'inventory', label: 'Inventory', icon: 'inventory', group: 'catalog' },
  { id: 'categories', label: 'Categories', icon: 'categories', group: 'catalog' },
  { id: 'brands', label: 'Brands', icon: 'brands', group: 'catalog' },
  { id: 'import-export', label: 'Import / Export', icon: 'import', group: 'catalog' },
  { id: 'promo-codes', label: 'Promo Codes', icon: 'promo', group: 'sales' },
  { id: 'wholesalers', label: 'Wholesalers', icon: 'wholesalers', group: 'sales' },
  { id: 'reviews', label: 'Reviews', icon: 'reviews', group: 'sales' },
  { id: 'bento', label: 'Bento Tiles', icon: 'bento', group: 'design' },
  { id: 'design', label: 'Banner & Texts', moreLabel: 'Banner, Expert page, Texts', icon: 'design', group: 'design' },
  { id: 'team', label: 'Team', icon: 'team', group: 'admin', superAdminOnly: true },
  { id: 'activity', label: 'Activity Log', icon: 'activity', group: 'admin', superAdminOnly: true },
  { id: 'settings', label: 'Settings', icon: 'settings', group: 'admin' },
  { id: 'profile', label: 'My Profile', icon: 'profile', group: 'admin' },
];

export const MORE_ITEM: NavItem = { id: 'more', label: 'More', icon: 'more', group: 'main' };

/** Every section id the URL may hold (?tab=...). */
export const ALL_SECTIONS: readonly AdminSection[] = [...NAV_ITEMS.map((i) => i.id), 'more'];

export interface NavAccess {
  isAdmin: boolean;
  can: (perm: StaffPermission) => boolean;
}

/** Whether this person may open a section. */
export function canOpenSection(section: AdminSection, access: NavAccess): boolean {
  const { isAdmin, can } = access;
  switch (section) {
    case 'home':
    case 'more':
      return true;
    case 'orders':
      return can('view_orders');
    case 'payouts':
    case 'inventory':
      return can('view_profit_costs');
    case 'customers':
      return can('view_customers');
    case 'products':
      return can('edit_products');
    case 'categories':
      return can('edit_categories') || can('edit_products');
    case 'wholesalers':
      return can('view_wholesalers');
    case 'profile':
      return !isAdmin;
    case 'brands':
      return can('edit_brands');
    default:
      return isAdmin;
  }
}

/** The menu items this person sees, in menu order. */
export function visibleNavItems(access: NavAccess): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.comingLater && canOpenSection(item.id, access));
}

/** Menu items grouped for the sidebar / More page; empty groups dropped. */
export function groupNavItems(items: readonly NavItem[]): { group: NavGroup; items: NavItem[] }[] {
  return NAV_GROUPS.map((group) => ({ group, items: items.filter((i) => i.group === group.id) })).filter(
    (g) => g.items.length > 0
  );
}

/** Bottom-bar order of preference; anything else follows in menu order. */
const TAB_PRIORITY: readonly AdminSection[] = ['home', 'orders', 'products', 'customers'];
const TAB_SLOTS = 4;

/**
 * The phone's bottom bar: four sections plus More (5 tabs). When someone
 * may not open one of Home / Orders / Products / Customers, the next item
 * they may open takes its place. More is only added when something is left
 * over for it to list.
 */
export function bottomTabs(visible: readonly NavItem[]): NavItem[] {
  const preferred = TAB_PRIORITY.map((id) => visible.find((i) => i.id === id)).filter(
    (i): i is NavItem => i !== undefined
  );
  const rest = visible.filter((i) => !TAB_PRIORITY.includes(i.id));
  const tabs = [...preferred, ...rest].slice(0, TAB_SLOTS);
  const leftover = visible.filter((i) => !tabs.includes(i));
  return leftover.length > 0 ? [...tabs, MORE_ITEM] : tabs;
}

/** What the More page lists: every visible item not in the bottom bar. */
export function moreItems(visible: readonly NavItem[], tabs: readonly NavItem[]): NavItem[] {
  return visible.filter((i) => !tabs.some((t) => t.id === i.id));
}

export function navItem(section: AdminSection): NavItem {
  return NAV_ITEMS.find((i) => i.id === section) ?? MORE_ITEM;
}

/** "NAEEM'S SUPER ADMIN", or "NAEEM'S <ROLE>" for staff. */
export function adminTitle(isAdmin: boolean, roleName: string | null): string {
  if (isAdmin) return "NAEEM'S SUPER ADMIN";
  const role = (roleName ?? '').trim() || 'Moderator';
  return `NAEEM'S ${role.toUpperCase()}`;
}

/** The hour in Bangladesh (UTC+6 all year, no daylight saving). */
export function dhakaHour(now: Date = new Date()): number {
  return (now.getUTCHours() + 6) % 24;
}

export function greeting(now: Date = new Date()): string {
  const hour = dhakaHour(now);
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17) return 'Good evening';
  // Batch 35 Part 5: 00:00–04:59 is neither evening nor morning.
  return 'Hello';
}

/** First name for the greeting: the first word of the full name, else the
 *  username with a capital letter. */
export function greetingName(fullName: string | null | undefined, username: string | null | undefined): string {
  const first = (fullName ?? '').trim().split(/\s+/)[0];
  if (first) return first;
  const user = (username ?? '').trim();
  return user ? user.charAt(0).toUpperCase() + user.slice(1) : 'there';
}

/**
 * Money with Bangladeshi digit grouping: the last three digits, then pairs
 * — ৳1,24,300 (the mockup's style). Rounded to whole taka.
 */
export function formatTakaBd(amount: number): string {
  const rounded = Math.round(amount);
  const negative = rounded < 0;
  const digits = String(Math.abs(rounded));
  let grouped = digits;
  if (digits.length > 3) {
    const last3 = digits.slice(-3);
    let head = digits.slice(0, -3);
    const pairs: string[] = [];
    while (head.length > 2) {
      pairs.unshift(head.slice(-2));
      head = head.slice(0, -2);
    }
    if (head) pairs.unshift(head);
    grouped = `${pairs.join(',')},${last3}`;
  }
  return `${negative ? '-' : ''}৳${grouped}`;
}
