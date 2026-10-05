import { supabase } from './supabase';
import type { OrderWithDetails } from '../types';
import type { PaymentSummary } from './payments';

/* Batch 30 Part 2 — "Edit order" (any field, any stage). The sheet keeps a
   draft; this works out what actually changed and sends only that to
   admin_edit_order() (migration-033), which checks the permission, moves
   stock, recalculates the totals and writes every History line itself. */

export interface EditDraftItem {
  /** Stable React key. */
  key: string;
  /** The order line's id; null for a line added in this edit. */
  id: string | null;
  productId: string | null;
  variantId: string | null;
  productName: string;
  variantLabel: string | null;
  imageUrl: string | null;
  listPrice: number;
  unitPrice: number;
  quantity: number;
  /** Quantity saved on the order (0 for a new line). */
  originalQuantity: number;
  /** Price saved on the order (the list price for a new line). */
  originalUnitPrice: number;
  /** Tracked stock in the shop right now; null = not tracked / unknown. */
  stockQuantity: number | null;
}

export interface EditDraft {
  customerName: string;
  phone: string;
  altPhone: string;
  division: string;
  district: string;
  thana: string;
  addressLine: string;
  courierNote: string;
  deliveryFee: string;
  discount: string;
  discountNote: string;
  items: EditDraftItem[];
}

export function draftFromOrder(order: OrderWithDetails, stockFor: (productId: string | null, variantId: string | null) => number | null): EditDraft {
  return {
    customerName: order.customer_name,
    phone: order.customer_phone,
    altPhone: order.alt_phone ?? '',
    division: order.division,
    district: order.district,
    thana: order.thana,
    addressLine: order.address_line,
    courierNote: order.courier_note ?? '',
    deliveryFee: String(order.delivery_fee),
    discount: String(order.discount),
    discountNote: order.discount_note ?? '',
    items: order.items.map((item) => ({
      key: item.id,
      id: item.id,
      productId: item.product_id,
      variantId: item.variant_id,
      productName: item.product_name,
      variantLabel: item.variant_label,
      imageUrl: item.image_url,
      listPrice: item.list_price,
      unitPrice: item.unit_price,
      quantity: item.quantity,
      originalQuantity: item.quantity,
      originalUnitPrice: item.unit_price,
      stockQuantity: stockFor(item.product_id, item.variant_id),
    })),
  };
}

const sameText = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim() === (b ?? '').trim();
const money = (raw: string) => Math.round(Number(raw) * 100) / 100;

/**
 * Lines that need more stock than the shop has. Stock only moves while the
 * order still holds stock (not cancelled); the database refuses the same
 * thing ("Only N in stock").
 */
export function stockProblems(draft: EditDraft, orderHoldsStock: boolean): Map<string, number> {
  const problems = new Map<string, number>();
  if (!orderHoldsStock) return problems;
  for (const item of draft.items) {
    const extra = item.quantity - item.originalQuantity;
    if (extra > 0 && item.stockQuantity !== null && extra > item.stockQuantity) {
      problems.set(item.key, Math.max(item.stockQuantity, 0) + item.originalQuantity);
    }
  }
  return problems;
}

/** Only what changed, in the shape admin_edit_order() reads. Empty = nothing. */
export function buildOrderChanges(order: OrderWithDetails, draft: EditDraft): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (!sameText(draft.customerName, order.customer_name)) changes.customer_name = draft.customerName.trim();
  if (!sameText(draft.phone, order.customer_phone)) changes.customer_phone = draft.phone.trim();
  if (!sameText(draft.altPhone, order.alt_phone)) changes.alt_phone = draft.altPhone.trim();
  if (!sameText(draft.division, order.division)) changes.division = draft.division.trim();
  if (!sameText(draft.district, order.district)) changes.district = draft.district.trim();
  if (!sameText(draft.thana, order.thana)) changes.thana = draft.thana.trim();
  if (!sameText(draft.addressLine, order.address_line)) changes.address_line = draft.addressLine.trim();
  if (!sameText(draft.courierNote, order.courier_note)) changes.courier_note = draft.courierNote.trim();
  if (money(draft.deliveryFee) !== Number(order.delivery_fee)) changes.delivery_fee = money(draft.deliveryFee);
  if (money(draft.discount) !== Number(order.discount)) changes.discount = money(draft.discount);
  if (!sameText(draft.discountNote, order.discount_note)) changes.discount_note = draft.discountNote.trim();

  const savedIds = new Set(order.items.map((i) => i.id));
  const keptIds = new Set(draft.items.filter((i) => i.id).map((i) => i.id as string));
  const itemsChanged =
    draft.items.some((i) => i.id === null || i.quantity !== i.originalQuantity || i.unitPrice !== i.originalUnitPrice) ||
    [...savedIds].some((id) => !keptIds.has(id));
  if (itemsChanged) {
    changes.items = draft.items.map((i) => {
      if (i.id) {
        return i.unitPrice !== i.originalUnitPrice
          ? { id: i.id, quantity: i.quantity, unit_price: i.unitPrice }
          : { id: i.id, quantity: i.quantity };
      }
      return i.unitPrice !== i.listPrice
        ? { product_id: i.productId, variant_id: i.variantId, quantity: i.quantity, unit_price: i.unitPrice }
        : { product_id: i.productId, variant_id: i.variantId, quantity: i.quantity };
    });
  }
  return changes;
}

/** What the draft's totals will be (the database recalculates the real ones). */
export function draftTotals(draft: EditDraft): { subtotal: number; deliveryFee: number; discount: number; total: number } {
  const subtotal = draft.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const deliveryFee = Math.max(money(draft.deliveryFee) || 0, 0);
  const discount = Math.min(Math.max(money(draft.discount) || 0, 0), subtotal);
  return { subtotal, deliveryFee, discount, total: Math.max(subtotal + deliveryFee - discount, 0) };
}

export async function adminEditOrder(orderId: string, changes: Record<string, unknown>): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_edit_order', { p_order_id: orderId, p_changes: changes });
  if (!error) return { error: null };
  if (error.code === 'PGRST202') {
    return { error: 'Editing orders needs the Batch 30 database update. Ask Naeem to run migration-033.' };
  }
  return { error: error.message || 'Could not save the changes.' };
}

/** "Done, I updated Steadfast". */
export async function markSteadfastUpdated(orderId: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_mark_steadfast_updated', { p_order_id: orderId });
  return { error: error?.message ?? null };
}

/** Steadfast's merchant page for one parcel (opens in a new tab). */
export function steadfastParcelUrl(consignmentId: string): string {
  return `https://steadfast.com.bd/user/consignment/${encodeURIComponent(consignmentId)}`;
}

export interface SteadfastBanner {
  /** Details Steadfast still has the old version of. */
  fields: string[];
  /** What the COD on Steadfast should now be, when it no longer matches. */
  codShouldBe: number | null;
}

const FINAL_COURIER = ['delivered', 'partial_delivered', 'cancelled'];

/**
 * The "Steadfast still has the old details" banner. Steadfast's API has no
 * "edit parcel" call, so after a change that matters to the courier Naeem
 * updates it on Steadfast by hand. Null when nothing needs doing.
 */
export function steadfastBanner(order: OrderWithDetails, payments: PaymentSummary | null): SteadfastBanner | null {
  if (!order.steadfast_consignment_id) return null;
  if (order.status === 'delivered' || order.status === 'cancelled') return null;
  if (FINAL_COURIER.includes(order.steadfast_status ?? '')) return null;
  const fields = order.steadfast_outdated ?? [];
  const cod = order.steadfast_cod_amount;
  const codShouldBe = payments && cod !== null && Math.abs(payments.due - cod) > 0.004 ? payments.due : null;
  if (fields.length === 0 && codShouldBe === null) return null;
  return { fields, codShouldBe };
}
