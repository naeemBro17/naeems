import { describe, expect, it } from 'vitest';
import {
  cleanTakaInput,
  noteCardAllowedOn,
  noteDateText,
  noteSeen,
  orderNoteGate,
  returnLoss,
  setOrderNoteGate,
  subscribeOrderNoteGate,
  walletNoteMayShow,
} from './orderNotes';
import {
  matchItems,
  readPayoutItem,
  returnPaidPaisa,
  type OrderForMatch,
} from '../../supabase/functions/_shared/steadfastPayouts';

// Batch 65: note to customer + "Customer paid delivery charge" on returns.

describe('note date text (Dhaka time)', () => {
  it('reads "24 Nov, 10:20 PM"', () => {
    expect(noteDateText('2026-11-24T16:20:00Z')).toBe('24 Nov, 10:20 PM');
  });
  it('crosses midnight in Dhaka, not in UTC', () => {
    expect(noteDateText('2026-11-24T18:05:00Z')).toBe('25 Nov, 12:05 AM');
  });
});

describe('admin card: Seen', () => {
  const sent = '2026-11-24T16:20:00.123+00:00';
  it('not seen when there is no seen time', () => {
    expect(noteSeen(sent, null)).toBe(false);
    expect(noteSeen(null, null)).toBe(false);
  });
  it('seen when opened after (or at) the time it was sent', () => {
    expect(noteSeen(sent, '2026-11-24T16:25:00+00:00')).toBe(true);
    expect(noteSeen(sent, sent)).toBe(true);
  });
  it('an edited note (sent after she saw the old one) is not seen', () => {
    expect(noteSeen('2026-11-24T17:00:00+00:00', '2026-11-24T16:25:00+00:00')).toBe(false);
  });
  it('compares times, not text (different decimals)', () => {
    expect(noteSeen('2026-11-24T16:20:00.1+00:00', '2026-11-24T16:20:00.0999+00:00')).toBe(false);
    expect(noteSeen('2026-11-24T16:20:00.1+00:00', '2026-11-24T16:20:00.15+00:00')).toBe(true);
  });
});

describe('Mark returned: loss on this return', () => {
  it('courier ৳120, customer paid ৳80 → loss ৳40', () => {
    expect(returnLoss(120, 80)).toEqual({ kind: 'loss', amount: 40 });
  });
  it('paid exactly the charge → loss ৳0', () => {
    expect(returnLoss(80, 80)).toEqual({ kind: 'loss', amount: 0 });
  });
  it('paid more than the charge → gain', () => {
    expect(returnLoss(60.8, 80)).toEqual({ kind: 'gain', amount: 19.2 });
  });
  it('nothing paid → the whole charge', () => {
    expect(returnLoss(130, 0)).toEqual({ kind: 'loss', amount: 130 });
  });
  it('the field keeps digits only, at most 6', () => {
    expect(cleanTakaInput('৳ 8,0a')).toBe('80');
    expect(cleanTakaInput('12345678')).toBe('123456');
    expect(cleanTakaInput('-5')).toBe('5');
  });
});

describe('floating card: where and when', () => {
  it('shows on Home, Account and My Orders only', () => {
    for (const p of ['/', '/account', '/orders', '/orders/']) expect(noteCardAllowedOn(p)).toBe(true);
    for (const p of ['/cart', '/checkout/summary', '/checkout/delivery', '/product/x', '/admin', '/admin-access', '/orders/abc', '/wallet'])
      expect(noteCardAllowedOn(p)).toBe(false);
  });
  it('the wallet card waits until the note check said "none"', () => {
    expect(walletNoteMayShow('off')).toBe(false);
    expect(walletNoteMayShow('waiting')).toBe(false);
    expect(walletNoteMayShow('shown')).toBe(false);
    expect(walletNoteMayShow('none')).toBe(true);
  });
  it('the gate tells listeners when it changes', () => {
    const seen: string[] = [];
    const stop = subscribeOrderNoteGate(() => seen.push(orderNoteGate()));
    setOrderNoteGate('waiting');
    setOrderNoteGate('waiting');
    setOrderNoteGate('shown');
    stop();
    setOrderNoteGate('none');
    expect(seen).toEqual(['waiting', 'shown']);
    setOrderNoteGate('off');
  });
});

/* ------------------------------------------------ Steadfast payout matching */

function order(over: Partial<OrderForMatch> = {}): OrderForMatch {
  return {
    id: 'o-1',
    order_number: 'NM-6501',
    status: 'returned',
    total: 1500,
    collect_mode: 'cod',
    steadfast_consignment_id: '6501',
    steadfast_cod_amount: 1500,
    paid_before_courier: 0,
    delivery_fee: 80,
    delivery_zone: 'inside_dhaka',
    steadfast_cod_paid: 0,
    return_delivery_paid: 0,
    ...over,
  };
}

/** A parcel where the rider collected only the delivery charge. */
const PARTIAL_80 = readPayoutItem({
  consignment_id: 6501,
  invoice: 'NM-6501',
  cod_amount: 80,
  delivery_charge: 60,
  cod_charge: 0.8,
  status: 'partial_delivered',
})!;
/** Steadfast returned it and collected nothing. */
const RETURNED_0 = readPayoutItem({ consignment_id: 6501, invoice: 'NM-6501', cod_amount: 1500, delivery_charge: 60, status: 'returned' })!;

describe('payout matching: a returned order whose customer paid the delivery charge', () => {
  it('knows the paid amount only for a returned order with more than ৳0', () => {
    expect(returnPaidPaisa(order({ return_delivery_paid: 80 }))).toBe(8000);
    expect(returnPaidPaisa(order({ return_delivery_paid: 0 }))).toBeNull();
    expect(returnPaidPaisa(order({ return_delivery_paid: null }))).toBeNull();
    expect(returnPaidPaisa(order({ status: 'delivered', return_delivery_paid: 80 }))).toBeNull();
  });

  it('matched when Steadfast collected exactly the ৳80 paid', () => {
    const [m] = matchItems([PARTIAL_80], [order({ return_delivery_paid: 80 })], new Set());
    expect(m.status).toBe('matched');
    expect(m.reason).toBeNull();
    expect(m.expectedCodPaisa).toBe(8000);
  });

  it('to check when Steadfast collected something else (e.g. ৳0 on a plain return)', () => {
    const [m] = matchItems([RETURNED_0], [order({ return_delivery_paid: 80 })], new Set());
    expect(m.status).toBe('to_check');
    expect(m.reason).toBe('cod_differs');
    expect(m.expectedCodPaisa).toBe(8000);
  });

  it('a returned order with ৳0 keeps today\'s rule: a plain return is matched, a ৳80 collection is "to check"', () => {
    expect(matchItems([RETURNED_0], [order()], new Set())[0].status).toBe('matched');
    const [m] = matchItems([PARTIAL_80], [order()], new Set());
    expect(m.status).toBe('to_check');
    expect(m.reason).toBe('cod_differs');
  });

  it('a duplicate stays a duplicate', () => {
    const [m] = matchItems([PARTIAL_80], [order({ return_delivery_paid: 80 })], new Set(['o-1']));
    expect(m.reason).toBe('duplicate');
  });
});
