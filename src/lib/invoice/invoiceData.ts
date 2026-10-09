// Batch 37: what one printed invoice says, worked out from a saved order
// (admin) or the checkout snapshot (the customer's "Download invoice").
// Pure code — the PDF drawing lives in renderInvoice.ts.
import type { AppSettings, OrderWithDetails } from '../../types';
import type { OrderSnapshot } from '../../features/checkout/types';
import { codAmountFor, normalizeCollectMode } from '../../../supabase/functions/_shared/cod';
import { PAYMENT_METHOD_NAMES, summarizePayments, type OrderPayment } from '../payments';
import { bdPhoneKey } from '../phone';
import { amountInWords } from './amountInWords';

export const INVOICE_DEFAULTS = {
  shopName: "NAEEM'S",
  city: 'Dhaka, Bangladesh',
  communityLink: 'https://www.facebook.com/groups/skinscience.psychology.solution',
  communityTitle: "Join the NAEEM'S skincare community",
  communityLine1: 'Skincare tips, new arrivals and members-only offers.',
  communityLine2: 'Scan the code with your phone camera to join our Facebook group.',
} as const;

/** Steadfast parcels are booked as their standard home delivery. */
export const STEADFAST_DELIVERY_TYPE = 'Regular';

export interface InvoiceShop {
  name: string;
  /** "01560-040012" (or as typed when not a BD mobile); '' when unset. */
  phone: string;
  city: string;
  community: {
    show: boolean;
    link: string;
    title: string;
    line1: string;
    line2: string;
  };
}

export interface InvoiceLine {
  name: string;
  /** The real price of one (list price). */
  unitPrice: number;
  quantity: number;
  /** Total taken off this line (0 when sold at list price). */
  discount: number;
  /** What the line costs — the order's own line total. */
  amount: number;
}

export interface InvoiceMoneyRow {
  label: string;
  amount: number;
  /** Printed with a minus sign. */
  minus: boolean;
}

export interface InvoiceData {
  /** 'customer' (the shopper's own copy) shows the order number where the
   *  admin copy shows the consignment, and never staff instructions. */
  audience: 'admin' | 'customer';
  orderNumber: string;
  invoiceNumber: string;
  /** "06 Oct 2026" (Dhaka time). */
  date: string;
  /** Pieces in the parcel. */
  itemCount: number;
  consignmentId: string | null;
  trackingCode: string | null;
  deliveryType: string;
  customer: {
    name: string;
    phone: string;
    /** The street part of the address. */
    addressLine: string;
    /** "Thana, District" (blank parts left out). */
    area: string;
  };
  paymentLabel: string;
  lines: InvoiceLine[];
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  /** "Paid in advance" rows (one per method), refunds, courier. */
  paidRows: InvoiceMoneyRow[];
  /** The dark COD panel on the label. */
  cod: { amount: number; note: string };
  /** The last, bold totals row. */
  finalRow: { label: string; amount: number };
  amountInWords: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "01850-078600" for a BD mobile; anything else as typed. */
export function formatInvoicePhone(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (/^https?:/i.test(text)) {
    const digits = text.replace(/\D/g, '');
    return digits === '' ? '' : formatInvoicePhone(digits);
  }
  const key = bdPhoneKey(text);
  if (key && /^01\d{9}$/.test(key)) return `${key.slice(0, 5)}-${key.slice(5)}`;
  return text;
}

/** ৳ amounts the Bangladeshi way: 1,20,450 — decimals only when there are any. */
export function invoiceMoney(amount: number): string {
  const negative = amount < 0;
  const abs = Math.abs(round2(amount));
  const whole = Math.floor(abs);
  const paisa = Math.round((abs - whole) * 100);
  const digits = String(whole);
  let grouped = digits;
  if (digits.length > 3) {
    let head = digits.slice(0, -3);
    const pairs: string[] = [];
    while (head.length > 2) {
      pairs.unshift(head.slice(-2));
      head = head.slice(0, -2);
    }
    if (head) pairs.unshift(head);
    grouped = `${pairs.join(',')},${digits.slice(-3)}`;
  }
  const text = paisa > 0 ? `${grouped}.${String(paisa).padStart(2, '0')}` : grouped;
  return `${negative ? '−' : ''}৳${text}`;
}

export function invoiceDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** Every invoice setting, read from one place, with its default. */
export function invoiceShop(settings: Partial<AppSettings>): InvoiceShop {
  const pick = (value: string | undefined, fallback: string) => {
    const v = (value ?? '').trim();
    return v === '' ? fallback : v;
  };
  return {
    name: INVOICE_DEFAULTS.shopName,
    phone: formatInvoicePhone(pick(settings.invoice_shop_phone, settings.shop_whatsapp_number ?? '')),
    city: pick(settings.invoice_shop_city, INVOICE_DEFAULTS.city),
    community: {
      show: (settings.invoice_show_community ?? 'true').trim() !== 'false',
      link: pick(settings.invoice_community_link, INVOICE_DEFAULTS.communityLink),
      title: pick(settings.invoice_community_title, INVOICE_DEFAULTS.communityTitle),
      line1: pick(settings.invoice_community_line1, INVOICE_DEFAULTS.communityLine1),
      line2: pick(settings.invoice_community_line2, INVOICE_DEFAULTS.communityLine2),
    },
  };
}

function areaOf(thana: string, district: string): string {
  return [thana, district].map((v) => (v ?? '').trim()).filter((v) => v !== '').join(', ');
}

/** The one address text both the label and "Billed to" print. */
export function fullAddress(customer: InvoiceData['customer']): string {
  return [customer.addressLine.trim(), customer.area].filter((v) => v !== '').join(', ');
}

function lineOf(name: string, variant: string | null | undefined, listPrice: number | undefined, unitPrice: number, quantity: number, amount: number): InvoiceLine {
  const list = listPrice !== undefined && listPrice > unitPrice ? listPrice : unitPrice;
  return {
    name: variant ? `${name} (${variant})` : name,
    unitPrice: list,
    quantity,
    discount: round2((list - unitPrice) * quantity),
    amount,
  };
}

function codNote(due: number, payLater: boolean): string {
  if (due <= 0) return 'Paid — do not collect';
  if (payLater) return 'Customer pays later';
  return 'Cash on delivery';
}

/**
 * The admin invoice for a saved order. `payments` is null before
 * migration-033 (no payments table) — then "paid" follows the old
 * payment_status column, exactly like the COD rule does.
 */
export function invoiceFromOrder(order: OrderWithDetails, payments: OrderPayment[] | null): InvoiceData {
  const total = Number(order.total);
  const summary = payments ? summarizePayments(total, payments) : null;
  const due = summary ? summary.due : order.payment_status === 'paid' ? 0 : total;
  const payLater = normalizeCollectMode(order.collect_mode) === 'pay_later';
  const collect = codAmountFor(order, summary ? summary.due : null);

  const paidRows: InvoiceMoneyRow[] = [];
  const advanceMethods: string[] = [];
  if (payments) {
    const byMethod = new Map<string, number>();
    let courier = 0;
    let refunded = 0;
    for (const p of payments) {
      if (p.kind === 'refund') refunded += Number(p.amount);
      else if (p.method === 'cod_steadfast') courier += Number(p.amount);
      else {
        const name = PAYMENT_METHOD_NAMES[p.method] ?? 'Other';
        byMethod.set(name, (byMethod.get(name) ?? 0) + Number(p.amount));
      }
    }
    for (const [name, amount] of byMethod) {
      advanceMethods.push(name);
      paidRows.push({ label: `Paid in advance (${name})`, amount: round2(amount), minus: true });
    }
    if (byMethod.size === 0) paidRows.push({ label: 'Paid in advance', amount: 0, minus: false });
    if (courier > 0) paidRows.push({ label: 'Collected by courier', amount: round2(courier), minus: true });
    if (refunded > 0) paidRows.push({ label: 'Refunded', amount: round2(refunded), minus: false });
  } else if (order.payment_status === 'paid') {
    const name = order.payment_method === 'bkash' ? 'bKash' : order.payment_method === 'cash' ? 'Cash' : 'Paid';
    advanceMethods.push(name);
    paidRows.push({ label: `Paid in advance (${name})`, amount: total, minus: true });
  } else {
    paidRows.push({ label: 'Paid in advance', amount: 0, minus: false });
  }

  const hasAdvance = paidRows.some((r) => r.minus && r.label.startsWith('Paid in advance'));
  let paymentLabel: string;
  if (due <= 0) paymentLabel = advanceMethods.length > 0 ? `Paid (${advanceMethods.join(', ')})` : 'Paid';
  else if (payLater) paymentLabel = hasAdvance ? 'Advance + pay later' : 'Pay later';
  else if (hasAdvance) paymentLabel = `${advanceMethods.join(', ')} advance + COD`;
  else paymentLabel = 'Cash on delivery';

  const finalRow =
    payLater && due > 0
      ? { label: 'Balance due (pay later)', amount: due }
      : { label: 'Amount to collect', amount: collect };

  return {
    audience: 'admin',
    orderNumber: order.order_number,
    invoiceNumber: `INV-${order.order_number}`,
    date: invoiceDate(order.created_at),
    itemCount: order.items.reduce((n, item) => n + item.quantity, 0),
    consignmentId: order.steadfast_consignment_id ? String(order.steadfast_consignment_id).trim() : null,
    trackingCode: order.steadfast_tracking_code,
    deliveryType: STEADFAST_DELIVERY_TYPE,
    customer: {
      name: order.customer_name.trim(),
      phone: formatInvoicePhone(order.customer_phone),
      addressLine: order.address_line.trim(),
      area: areaOf(order.thana, order.district),
    },
    paymentLabel,
    lines: order.items.map((item) =>
      lineOf(item.product_name, item.variant_label, item.list_price, Number(item.unit_price), item.quantity, Number(item.line_total))
    ),
    subtotal: Number(order.subtotal),
    deliveryFee: Number(order.delivery_fee),
    discount: Number(order.discount),
    total,
    paidRows,
    cod: { amount: collect, note: codNote(due, payLater) },
    finalRow,
    amountInWords: amountInWords(total),
  };
}

/** The customer's own copy from the checkout "Order placed" page. A
 *  website bKash order is paid in full up front; anything else is COD. */
export function invoiceFromSnapshot(order: OrderSnapshot): InvoiceData {
  const total = Number(order.total);
  const paidByBkash = order.paymentMethod === 'bkash';
  const due = paidByBkash ? 0 : total;
  return {
    audience: 'customer',
    orderNumber: order.orderNumber,
    invoiceNumber: `INV-${order.orderNumber}`,
    date: invoiceDate(order.placedAt),
    itemCount: order.items.reduce((n, item) => n + item.quantity, 0),
    consignmentId: null,
    trackingCode: null,
    deliveryType: STEADFAST_DELIVERY_TYPE,
    customer: {
      name: order.address.fullName.trim(),
      phone: formatInvoicePhone(order.address.phone),
      addressLine: order.address.fullAddress.trim(),
      area: areaOf(order.address.thana, order.address.district),
    },
    paymentLabel: paidByBkash ? 'Paid (bKash)' : 'Cash on delivery',
    lines: order.items.map((item) =>
      lineOf(item.product.name, item.variantLabel, item.listPrice, item.unitPrice, item.quantity, round2(item.unitPrice * item.quantity))
    ),
    subtotal: Number(order.subtotal),
    deliveryFee: Number(order.zone.fee),
    discount: Number(order.discount),
    total,
    paidRows: paidByBkash
      ? [{ label: 'Paid in advance (bKash)', amount: total, minus: true }]
      : [{ label: 'Paid in advance', amount: 0, minus: false }],
    cod: { amount: due, note: codNote(due, false) },
    finalRow: { label: 'Amount to collect', amount: due },
    amountInWords: amountInWords(total),
  };
}
