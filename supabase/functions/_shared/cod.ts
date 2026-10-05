// The COD amount a parcel is booked with (Batch 30 Part 3): what is still
// due on the order — total minus every payment recorded — never the full
// total once money was paid. `due` is null before migration-033 (no
// payments table yet); then the Batch 22 rule stays: 0 when the order is
// marked paid, otherwise the total. Shared by the steadfast function and
// the admin "Book with Steadfast?" confirmation so both always agree.
export function codAmountFor(order: { payment_status: string; total: number }, due: number | null): number {
  if (due !== null && Number.isFinite(due)) {
    return Math.max(0, Math.round(due * 100) / 100);
  }
  return order.payment_status === 'paid' ? 0 : Number(order.total);
}
