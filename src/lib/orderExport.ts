import type { OrderSnapshot } from '../features/checkout/types';
import { DISCOUNT_REASON_LABELS } from './manualOrders';

/**
 * jsPDF's built-in fonts only cover WinAnsi, not the Bengali Taka sign (৳),
 * so the PDF export spells it out as "Tk" instead.
 */
function formatTakaAscii(amount: number): string {
  const hasDecimals = amount % 1 !== 0;
  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `Tk ${formatted}`;
}

function areaLine(order: OrderSnapshot): string {
  return [order.address.thana, order.address.district, order.address.division]
    .filter((v) => v.trim() !== '')
    .join(', ');
}

/**
 * Renders the order into a one-page PDF invoice for OrderSuccessPage's
 * "Download invoice" (and the admin Orders tab's matching action).
 * jsPDF pulls in html2canvas (~230kB) as a hard dependency of its .html()
 * plugin even though this file never calls it, so the import is deferred
 * here — the cost is only paid when someone actually taps the button, not
 * on every page load.
 */
export async function buildOrderPdf(order: OrderSnapshot) {
  const { default: jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const marginX = 48;
  const lineHeight = 18;
  let y = 56;

  const writeLine = (text: string, bold = false, size = 11) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.text(text, marginX, y);
    y += lineHeight * (size > 14 ? 1.4 : 1);
  };

  writeLine(`Order ${order.orderNumber}`, true, 18);
  writeLine(new Date(order.placedAt).toLocaleString('en-GB'), false, 10);
  y += lineHeight * 0.5;

  writeLine(`Name: ${order.address.fullName}`);
  writeLine(`Phone: ${order.address.phone}`);
  const area = areaLine(order);
  if (area !== '') writeLine(`Area: ${area}`);
  writeLine(`Address: ${order.address.fullAddress}`);
  y += lineHeight * 0.5;

  writeLine('Items', true);
  for (const item of order.items) {
    const variant = item.variantLabel ? ` (${item.variantLabel})` : '';
    writeLine(
      `${item.product.name}${variant}  x${item.quantity}  ${formatTakaAscii(item.unitPrice * item.quantity)}`
    );
    // Batch 22: a manual order line sold below (or at) list price shows the
    // real list price and why — undefined listPrice (every website order)
    // or an unchanged price prints nothing extra here.
    if (item.listPrice !== undefined && item.listPrice !== item.unitPrice) {
      const reasonLabel = item.discountReason ? DISCOUNT_REASON_LABELS[item.discountReason] : null;
      const note =
        item.unitPrice === 0
          ? `FREE — list price ${formatTakaAscii(item.listPrice)}`
          : `List price ${formatTakaAscii(item.listPrice)}, discount ${formatTakaAscii(item.listPrice - item.unitPrice)}`;
      writeLine(`  ${note}${reasonLabel ? ` (${reasonLabel})` : ''}`, false, 9);
    }
  }
  y += lineHeight * 0.5;

  writeLine(`Delivery (${order.zone.label}): ${formatTakaAscii(order.zone.fee)}`);
  writeLine(`Subtotal: ${formatTakaAscii(order.subtotal)}`);
  if (order.promo) {
    writeLine(`Promo (${order.promo.code}): -${formatTakaAscii(order.discount)}`);
  } else if (order.discount > 0) {
    const reasonLabel = order.orderDiscountReason ? DISCOUNT_REASON_LABELS[order.orderDiscountReason] : null;
    writeLine(`Discount${reasonLabel ? ` (${reasonLabel})` : ''}: -${formatTakaAscii(order.discount)}`);
  }
  writeLine(`Total: ${formatTakaAscii(order.total)}`, true);
  y += lineHeight * 0.5;

  const paymentLine =
    order.paymentMethod === 'bkash'
      ? `Payment: bKash (TrxID: ${order.bkashTrxId ?? '-'})`
      : 'Payment: Cash on Delivery';
  writeLine(paymentLine);

  return doc;
}
