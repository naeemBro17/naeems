import type { AdminSection, NavAccess } from './adminNav';

/**
 * Batch 32 Part 3: the big admin forms are full pages with their own link
 * (not pop-ups a stray tap can close):
 *   /admin/orders/new                 New order
 *   /admin/orders/:orderNumber        The order (Batch 35: no pop-up)
 *   /admin/orders/:orderNumber/edit   Edit order
 *   /admin/products/new               Add product
 *   /admin/products/:id/edit          Edit product
 *   /admin/customers/new              Add customer
 *   /admin/customers/:key             Customer profile
 *   /admin/payouts/:id                One Steadfast payout (Batch 36)
 *   /admin/customers/:key/merge       Merge old data (Batch 54)
 *   /admin/customers/:key/merge/:bill One receipt before the merge
 *   /admin/customers/:key/old/:id     One merged old receipt
 *   /admin/customers/:key/join        Merge with another customer (Batch 55;
 *                                     ?pick=<key> picks one first)
 *   /admin/campaigns/new              New campaign (Batch 66)
 *   /admin/campaigns/:id/edit         Edit campaign
 *   (/admin/campaigns itself is the list, /admin?tab=campaigns.)
 * Everything else under /admin is the section list (?tab=...), as before.
 */
export type AdminSubPage =
  | { kind: 'new-order' }
  | { kind: 'edit-order'; orderNumber: string }
  | { kind: 'order'; orderNumber: string }
  | { kind: 'new-product' }
  | { kind: 'edit-product'; productId: string }
  | { kind: 'new-customer' }
  | { kind: 'customer'; customerKey: string }
  | { kind: 'payout'; payoutId: string }
  | { kind: 'merge-old'; customerKey: string }
  | { kind: 'merge-receipt'; customerKey: string; bill: string }
  | { kind: 'old-receipt'; customerKey: string; billId: string }
  | { kind: 'join-customer'; customerKey: string }
  | { kind: 'new-campaign' }
  | { kind: 'edit-campaign'; campaignId: string };

function decode(part: string): string | null {
  try {
    const value = decodeURIComponent(part).trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

/** null = /admin itself; 'unknown' = an /admin/... link that isn't a page. */
export function parseAdminSubPage(pathname: string): AdminSubPage | null | 'unknown' {
  const path = pathname.replace(/\/+$/, '');
  if (path === '/admin' || path === '') return null;
  if (!path.startsWith('/admin/')) return 'unknown';
  const parts = path.slice('/admin/'.length).split('/');
  const [section, second, third] = parts;
  if (section === 'orders') {
    if (parts.length === 2 && second === 'new') return { kind: 'new-order' };
    const shown = parts.length === 2 ? decode(second) : null;
    if (shown) return { kind: 'order', orderNumber: shown };
    const orderNumber = parts.length === 3 && third === 'edit' ? decode(second) : null;
    if (orderNumber) return { kind: 'edit-order', orderNumber };
  }
  if (section === 'products') {
    if (parts.length === 2 && second === 'new') return { kind: 'new-product' };
    const productId = parts.length === 3 && third === 'edit' ? decode(second) : null;
    if (productId) return { kind: 'edit-product', productId };
  }
  if (section === 'customers' && parts.length === 2) {
    if (second === 'new') return { kind: 'new-customer' };
    const customerKey = decode(second);
    if (customerKey) return { kind: 'customer', customerKey };
  }
  // Batch 54: Merge old data (Super Admin), and an old receipt.
  if (section === 'customers' && (parts.length === 3 || parts.length === 4)) {
    const customerKey = decode(second);
    const fourth = parts.length === 4 ? decode(parts[3]) : null;
    if (customerKey && third === 'merge' && parts.length === 3) return { kind: 'merge-old', customerKey };
    if (customerKey && third === 'join' && parts.length === 3) return { kind: 'join-customer', customerKey };
    if (customerKey && third === 'merge' && fourth) return { kind: 'merge-receipt', customerKey, bill: fourth };
    if (customerKey && third === 'old' && fourth) return { kind: 'old-receipt', customerKey, billId: fourth };
  }
  if (section === 'campaigns') {
    if (parts.length === 2 && second === 'new') return { kind: 'new-campaign' };
    const campaignId = parts.length === 3 && third === 'edit' ? decode(second) : null;
    if (campaignId) return { kind: 'edit-campaign', campaignId };
  }
  if (section === 'payouts' && parts.length === 2) {
    const payoutId = decode(second);
    if (payoutId) return { kind: 'payout', payoutId };
  }
  return 'unknown';
}

/** The section a page belongs to (lit in the sidebar / bottom bar). */
export function subPageSection(page: AdminSubPage): AdminSection {
  switch (page.kind) {
    case 'new-order':
    case 'edit-order':
    case 'order':
      return 'orders';
    case 'new-product':
    case 'edit-product':
      return 'products';
    case 'payout':
      return 'payouts';
    case 'new-campaign':
    case 'edit-campaign':
      return 'campaigns';
    default:
      return 'customers';
  }
}

/** Who may open a page — the same switches as the buttons that lead there
 *  (the database checks them again on every save). */
export function canOpenSubPage(page: AdminSubPage, access: NavAccess): boolean {
  const { isAdmin, can } = access;
  switch (page.kind) {
    case 'new-order':
      return can('create_orders');
    case 'edit-order':
      return can('edit_orders');
    case 'order':
      return can('view_orders');
    case 'new-product':
    case 'edit-product':
      return can('edit_products');
    case 'new-customer':
      return isAdmin || can('create_orders') || can('manage_customers');
    case 'customer':
      return can('view_customers');
    case 'payout':
      return can('view_profit_costs');
    case 'merge-old':
    case 'merge-receipt':
    case 'join-customer':
      return isAdmin;
    case 'old-receipt':
      return can('view_profit_costs');
    case 'new-campaign':
    case 'edit-campaign':
      return isAdmin;
  }
}

/** Pages that are a form with one Save button (it docks at the bottom on a
 *  phone, so the bottom tab bar steps aside). */
export function isFormSubPage(page: AdminSubPage): boolean {
  return page.kind !== 'customer' && page.kind !== 'payout';
}

/** Where each page's Back goes when there is no list to return to (a link
 *  opened directly, or after a refresh). */
export function subPageFallback(page: AdminSubPage): string {
  if (page.kind === 'merge-old' || page.kind === 'old-receipt' || page.kind === 'join-customer') return adminPath.customer(page.customerKey);
  if (page.kind === 'merge-receipt') return adminPath.mergeOld(page.customerKey);
  return `/admin?tab=${subPageSection(page)}`;
}

export const adminPath = {
  newOrder: () => '/admin/orders/new',
  order: (orderNumber: string) => `/admin/orders/${encodeURIComponent(orderNumber)}`,
  editOrder: (orderNumber: string) => `/admin/orders/${encodeURIComponent(orderNumber)}/edit`,
  newProduct: () => '/admin/products/new',
  editProduct: (id: string) => `/admin/products/${encodeURIComponent(id)}/edit`,
  newCustomer: () => '/admin/customers/new',
  customer: (key: string) => `/admin/customers/${encodeURIComponent(key)}`,
  payout: (id: string) => `/admin/payouts/${encodeURIComponent(id)}`,
  customerJoin: (key: string, pickKey?: string) =>
    `/admin/customers/${encodeURIComponent(key)}/join${pickKey ? `?pick=${encodeURIComponent(pickKey)}` : ''}`,
  mergeOld: (key: string) => `/admin/customers/${encodeURIComponent(key)}/merge`,
  mergeReceipt: (key: string, bill: string) => `/admin/customers/${encodeURIComponent(key)}/merge/${encodeURIComponent(bill)}`,
  newCampaign: () => '/admin/campaigns/new',
  editCampaign: (id: string) => `/admin/campaigns/${encodeURIComponent(id)}/edit`,
  oldReceipt: (key: string, billId: string) => `/admin/customers/${encodeURIComponent(key)}/old/${encodeURIComponent(billId)}`,
};

/**
 * Batch 47: a click the browser should handle itself — Ctrl/⌘/Shift-click
 * or a middle click opens the link in a new tab or window. A list row's
 * own click handler must then leave it alone (the row's <Link> does).
 */
export function isNewTabClick(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; button: number }): boolean {
  return e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0;
}

/** For a click on a row's padding (outside its <Link>): a new-tab click
 *  opens the same page in a new tab instead of this one. */
export function openInNewTab(path: string): void {
  window.open(path, '_blank', 'noopener');
}

/** A "next" link after signing in may only lead back into the admin. */
export function safeAdminNext(next: string | null | undefined): string {
  if (!next) return '/admin';
  if (!next.startsWith('/admin') || next.startsWith('//') || next.includes('://')) return '/admin';
  return next;
}
