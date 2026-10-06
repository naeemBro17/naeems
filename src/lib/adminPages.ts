import type { AdminSection, NavAccess } from './adminNav';

/**
 * Batch 32 Part 3: the big admin forms are full pages with their own link
 * (not pop-ups a stray tap can close):
 *   /admin/orders/new                 New order
 *   /admin/orders/:orderNumber/edit   Edit order
 *   /admin/products/new               Add product
 *   /admin/products/:id/edit          Edit product
 *   /admin/customers/new              Add customer
 *   /admin/customers/:key             Customer profile
 * Everything else under /admin is the section list (?tab=...), as before.
 */
export type AdminSubPage =
  | { kind: 'new-order' }
  | { kind: 'edit-order'; orderNumber: string }
  | { kind: 'new-product' }
  | { kind: 'edit-product'; productId: string }
  | { kind: 'new-customer' }
  | { kind: 'customer'; customerKey: string };

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
  return 'unknown';
}

/** The section a page belongs to (lit in the sidebar / bottom bar). */
export function subPageSection(page: AdminSubPage): AdminSection {
  switch (page.kind) {
    case 'new-order':
    case 'edit-order':
      return 'orders';
    case 'new-product':
    case 'edit-product':
      return 'products';
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
    case 'new-product':
    case 'edit-product':
      return can('edit_products');
    case 'new-customer':
      return isAdmin || can('create_orders') || can('manage_customers');
    case 'customer':
      return can('view_customers');
  }
}

/** Pages that are a form with one Save button (it docks at the bottom on a
 *  phone, so the bottom tab bar steps aside). */
export function isFormSubPage(page: AdminSubPage): boolean {
  return page.kind !== 'customer';
}

/** Where each page's Back goes when there is no list to return to (a link
 *  opened directly, or after a refresh). */
export function subPageFallback(page: AdminSubPage): string {
  return `/admin?tab=${subPageSection(page)}`;
}

export const adminPath = {
  newOrder: () => '/admin/orders/new',
  editOrder: (orderNumber: string) => `/admin/orders/${encodeURIComponent(orderNumber)}/edit`,
  newProduct: () => '/admin/products/new',
  editProduct: (id: string) => `/admin/products/${encodeURIComponent(id)}/edit`,
  newCustomer: () => '/admin/customers/new',
  customer: (key: string) => `/admin/customers/${encodeURIComponent(key)}`,
};

/** A "next" link after signing in may only lead back into the admin. */
export function safeAdminNext(next: string | null | undefined): string {
  if (!next) return '/admin';
  if (!next.startsWith('/admin') || next.startsWith('//') || next.includes('://')) return '/admin';
  return next;
}
