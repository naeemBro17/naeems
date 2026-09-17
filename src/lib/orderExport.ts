import { formatTaka } from './format';
import type { OrderSnapshot } from '../features/checkout/types';

/**
 * jsPDF's built-in fonts only cover WinAnsi, not the Bengali Taka sign (৳),
 * so the PDF export spells it out as "Tk" instead. The WhatsApp message
 * uses formatTaka's ৳ normally — that's just UTF-8 text WhatsApp renders
 * natively, no font involved.
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
  return [order.address.district, order.address.thana].filter((v) => v.trim() !== '').join(', ');
}

/** Pre-filled WhatsApp message text for OrderSuccessPage's "Send on WhatsApp". */
export function buildOrderWhatsAppText(order: OrderSnapshot): string {
  const lines: string[] = [];
  lines.push("New order from Naeem's");
  lines.push('');
  lines.push(`Name: ${order.address.fullName}`);
  lines.push(`Phone: ${order.address.phone}`);
  const area = areaLine(order);
  if (area !== '') lines.push(`Area: ${area}`);
  lines.push(`Address: ${order.address.fullAddress}`);
  lines.push('');
  lines.push('Items:');
  for (const item of order.items) {
    const variant = item.variantLabel ? ` (${item.variantLabel})` : '';
    lines.push(
      `- ${item.product.name}${variant} x${item.quantity} - ${formatTaka(item.unitPrice * item.quantity)}`
    );
  }
  lines.push('');
  lines.push(`Delivery: ${order.zone.label} (${formatTaka(order.zone.fee)})`);
  if (order.promo) {
    lines.push(`Promo applied: ${order.promo.code} (-${formatTaka(order.discount)})`);
  }
  lines.push(`Total: ${formatTaka(order.total)}`);
  return lines.join('\n');
}

/**
 * Renders the order into a one-page PDF for OrderSuccessPage's "Save as PDF".
 * jsPDF pulls in html2canvas (~230kB) as a hard dependency of its .html()
 * plugin even though this file never calls it, so the import is deferred
 * here — the cost is only paid when a customer actually taps the button,
 * not on every page load.
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

  writeLine('Order Summary', true, 18);
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
  }
  y += lineHeight * 0.5;

  writeLine(`Delivery (${order.zone.label}): ${formatTakaAscii(order.zone.fee)}`);
  writeLine(`Subtotal: ${formatTakaAscii(order.subtotal)}`);
  if (order.promo) {
    writeLine(`Promo (${order.promo.code}): -${formatTakaAscii(order.discount)}`);
  }
  writeLine(`Total: ${formatTakaAscii(order.total)}`, true);

  return doc;
}
