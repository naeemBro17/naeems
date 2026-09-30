import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, rpc, select } from './helpers/api';

/**
 * Runs once after the whole e2e suite (Batch 24): deletes every order the
 * test customer still has that may be deleted without the Safety Lock —
 * Pending, or Cancelled and never booked on Steadfast. That is every order
 * the suite leaves behind (checkout.spec.ts places one and cancels it).
 * Uses the test Super Admin account; skipped if it isn't set up.
 */
export default async function globalTeardown(): Promise<void> {
  if (!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD) return;
  try {
    const customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
    const admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
    const orders = await select<{ id: string; status: string; steadfast_consignment_id: string | null }[]>(
      admin.accessToken,
      `orders?select=id,status,steadfast_consignment_id&customer_id=eq.${customer.userId}`
    );
    const early = (orders.data ?? [])
      .filter((o) => o.status === 'pending' || (o.status === 'cancelled' && !o.steadfast_consignment_id))
      .map((o) => o.id);
    if (early.length > 0) {
      await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: early });
    }
  } catch (err) {
    console.warn('e2e cleanup of test orders skipped:', err instanceof Error ? err.message : err);
  }
}
