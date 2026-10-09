import { describe, expect, it } from 'vitest';
import {
  TRACK_STATUS,
  cleanCourierText,
  expectedDelivery,
  formatDayRange,
  formatDhakaDateTime,
  friendlyUpdates,
  latestRider,
  placeName,
  stepStates,
  trackOrder,
  trackingEventKey,
  trackingEventRows,
  translateCourierText,
  type TrackInput,
} from '../../supabase/functions/_shared/orderTracking';
import { greeting } from './adminNav';
import { paymentUpdates, customerPaymentPill } from './orderTracking';

// Batch 35 Part 1: one mapping, friendly courier words, the expected date.

const booked = (courierStatus: string | null, texts: string[] = []): TrackInput => ({
  status: 'shipped',
  booked: true,
  courierStatus,
  events: texts.map((text, i) => ({ text, at: `2026-10-0${i + 1}T08:00:00Z` })),
});

describe('every saved status + courier state → one of the seven statuses', () => {
  it('the order itself (not on Steadfast)', () => {
    expect(trackOrder({ status: 'pending', booked: false, courierStatus: null }).status).toBe('processing');
    expect(trackOrder({ status: 'confirmed', booked: false, courierStatus: null }).status).toBe('confirmed');
    expect(trackOrder({ status: 'shipped', booked: false, courierStatus: null }).status).toBe('in_transit');
    expect(trackOrder({ status: 'delivered', booked: false, courierStatus: null }).status).toBe('delivered');
    expect(trackOrder({ status: 'cancelled', booked: false, courierStatus: null }).status).toBe('cancelled');
  });

  it('every Steadfast delivery_status', () => {
    const cases: [string, string, string | null][] = [
      ['in_review', 'in_transit', null],
      ['pending', 'in_transit', null],
      ['hold', 'in_transit', 'on_hold'],
      ['exceptional', 'in_transit', 'needs_attention'],
      ['unknown', 'in_transit', 'needs_attention'],
      ['unknown_approval_pending', 'in_transit', 'needs_attention'],
      ['delivered', 'delivered', null],
      ['delivered_approval_pending', 'delivered', 'awaiting_confirmation'],
      ['partial_delivered', 'delivered', 'partly_delivered'],
      ['partial_delivered_approval_pending', 'delivered', 'partly_delivered'],
      ['cancelled', 'returned', null],
      ['cancelled_approval_pending', 'returned', null],
    ];
    for (const [courier, status, note] of cases) {
      const result = trackOrder(booked(courier));
      expect(result.status, courier).toBe(status);
      expect(result.note, courier).toBe(note);
    }
  });

  it('"Shipped" is never a name anywhere', () => {
    for (const info of Object.values(TRACK_STATUS)) {
      expect(info.admin).not.toMatch(/shipped/i);
      expect(info.customer).not.toMatch(/shipped/i);
    }
    expect(TRACK_STATUS.processing.customer).toBe('Order placed');
    expect(TRACK_STATUS.processing.admin).toBe('Processing');
  });

  it('pill colours: amber, blue, purple, teal, green, red, grey', () => {
    expect(Object.values(TRACK_STATUS).map((s) => s.tone)).toEqual(['amber', 'blue', 'purple', 'teal', 'green', 'red', 'grey']);
  });

  it('"Assigned to rider." → Out for delivery; back at a hub → In transit again', () => {
    expect(trackOrder(booked('pending', ['Consignment has been received at PALLABI.', 'Assigned to rider.'])).status).toBe(
      'out_for_delivery'
    );
    expect(
      trackOrder(booked('pending', ['Assigned to rider.', 'Consignment has been received at PALLABI.'])).status
    ).toBe('in_transit');
    expect(trackOrder(booked('pending', ['Assigned to rider by self-scan at the hub.'])).status).toBe('out_for_delivery');
  });

  it('a stored step fills Out for delivery on lists without the texts', () => {
    expect(trackOrder({ ...booked('pending'), storedStep: 'out_for_delivery' }).status).toBe('out_for_delivery');
  });
});

describe('earlier steps fill automatically', () => {
  it('Delivered without an Out for delivery event → every earlier step done', () => {
    const states = stepStates(trackOrder(booked('delivered', ['Consignment created by Sender(API).'])));
    expect(states).toEqual(['done', 'done', 'done', 'done', 'current']);
  });
  it('Confirmed → placed done, confirmed current, the rest upcoming', () => {
    expect(stepStates(trackOrder({ status: 'confirmed', booked: false, courierStatus: null }))).toEqual([
      'done',
      'current',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
  });
  it('Cancelled / Returned have no steps', () => {
    expect(trackOrder({ status: 'cancelled', booked: false, courierStatus: null }).stepIndex).toBe(-1);
    expect(trackOrder(booked('cancelled')).stepIndex).toBe(-1);
  });
});

describe("Steadfast's real texts in friendly English", () => {
  const friendly = (text: string) => translateCourierText(text).friendly;
  it('known messages', () => {
    expect(friendly('Consignment created by Sender(API).')).toBe('Handed to Steadfast');
    expect(friendly('Consignment status has been updated as Pending')).toBe('Picked up by Steadfast');
    expect(friendly('Consignment sent to MIRPUR WAREHOUSE.  Dispatch ID: 18085103')).toBe('On the way to the Mirpur sorting centre');
    expect(friendly('Consignment has been received at SAVAR WAREHOUSE. By Sorter No: 3.')).toBe('Reached the Savar sorting centre');
    expect(friendly('Consignment has been received at BARISHAL SHORTING CENTER.')).toBe('Reached the Barishal sorting centre');
    expect(friendly('Consignment sent to NIKUNJA.  Dispatch ID: 18084511')).toBe('On the way to Nikunja delivery hub');
    expect(friendly('Consignment has been received at PALLABI.')).toBe('Arrived at Pallabi delivery hub');
    expect(friendly('Consignment has been received at PALASH (NARSINGDI).')).toBe('Arrived at Palash (Narsingdi) delivery hub');
    expect(friendly('Consignment sent to BHANGA - FARIDPUR WAREHOUSE.  Dispatch ID: 17994522')).toBe(
      'On the way to the Bhanga - Faridpur sorting centre'
    );
    expect(friendly('Consignment has been received at RAJSHAHI SUB WAREHOUSE.')).toBe('Reached the Rajshahi sorting centre');
    expect(friendly('Assigned to rider.')).toBe('Out for delivery with a rider');
    expect(friendly('Consignment marked as delivered by rider.')).toBe('Delivered');
  });

  it('friendly words read back the same (the customer gets them already translated)', () => {
    const raw = [
      'Consignment created by Sender(API).',
      'Consignment status has been updated as Pending',
      'Consignment sent to MIRPUR WAREHOUSE.  Dispatch ID: 18085103',
      'Consignment has been received at SAVAR WAREHOUSE. By Sorter No: 3.',
      'Consignment sent to NIKUNJA.  Dispatch ID: 18084511',
      'Consignment has been received at PALLABI.',
      'Assigned to rider.',
      'Consignment marked as delivered by rider.',
      'Parcel received at Dhanmondi hub.',
    ];
    for (const text of raw) {
      const once = translateCourierText(text);
      const twice = translateCourierText(once.friendly ?? '');
      expect(twice.friendly, text).toBe(once.friendly);
      expect(twice.step, text).toBe(once.step);
      expect(twice.kind, text).toBe(once.kind);
    }
  });

  it("Naeem's own edits are never shown to a customer", () => {
    expect(friendly("Changes: COD '4079' to '0'. By User Naeem(1380201)")).toBeNull();
    expect(friendly("Changes: Note '-' to 'COD - 0'.")).toBeNull();
    expect(friendly('Address has been changed from "a" to "b".')).toBeNull();
    expect(friendly('Address change requested (#1551360) by the merchant. Awaiting approval.')).toBeNull();
    expect(friendly('Address change #1551360 approved by SOMEONE. Delivery charge unchanged at 115.')).toBeNull();
  });

  it('unknown text is cleaned: no phone numbers, IDs or rider names', () => {
    const out = friendly('Customer asked to call 01711-111111 or +8801722222222 later, ref 18085103');
    expect(out).not.toMatch(/\d{5,}/);
    expect(out).not.toMatch(/01711/);
    expect(friendly('Rider Karim called the customer')).toBe('Update from the delivery rider');
    expect(friendly('Returned to Mirpur hub by rider Karim')).toBe('Arrived at Mirpur delivery hub');
    expect(cleanCourierText('Hold (#1234) Dispatch ID: 99887766')).toBe('Hold');
  });

  it('the cleaned rider sentence from the older function still reads right', () => {
    expect(translateCourierText('Assigned to a rider — your parcel is out for delivery.').step).toBe('out_for_delivery');
    expect(friendly('Assigned to rider Md. Karim (01711111111)')).toBe('Out for delivery with a rider');
  });

  it('place names read naturally', () => {
    expect(placeName('MIRPUR WAREHOUSE')).toBe('Mirpur');
    expect(placeName('CHANDRIMA (RAJSHAHI).')).toBe('Chandrima (Rajshahi)');
  });

  it('the same update twice is listed once', () => {
    const events = [
      { text: 'Assigned to rider.', at: '2026-10-08T04:45:40Z' },
      { text: 'Assigned to rider.', at: '2026-10-08T04:45:40Z' },
      { text: "Changes: COD '1' to '0'.", at: '2026-10-08T04:00:00Z' },
    ];
    expect(friendlyUpdates(events)).toHaveLength(1);
    expect(trackingEventRows('o1', events, 'steadfast_refresh')).toHaveLength(2);
    expect(trackingEventKey('Assigned to rider.', '2026-10-08T04:45:40Z')).toBe(trackingEventKey('Assigned  to rider. ', '2026-10-08T04:45:40Z'));
    expect(trackingEventKey('Assigned to rider.', '2026-10-08T04:45:40Z')).not.toBe(trackingEventKey('Assigned to rider.', null));
  });

  it('a rider name and phone are only read when a text really gives both', () => {
    expect(latestRider([{ text: 'Assigned to rider.', at: null }])).toBeNull();
    expect(latestRider([{ text: 'Assigned to rider Md. Karim (01711-111111)', at: null }])).toEqual({ name: 'Md. Karim', phone: '01711111111' });
  });
});

describe('expected delivery (one rule)', () => {
  const now = new Date('2026-10-09T06:00:00Z');
  it('inside Dhaka 1–2 days, outside 2–4 days from the In transit date', () => {
    expect(formatDayRange(expectedDelivery({ zone: 'inside_dhaka', startAt: '2026-10-09T05:00:00Z', now }))).toBe('Sat 10 – Sun 11 Oct');
    expect(formatDayRange(expectedDelivery({ zone: 'outside_dhaka', startAt: '2026-10-09T05:00:00Z', now }))).toBe('Sun 11 – Tue 13 Oct');
  });
  it('the date is the Dhaka calendar day (1:30 AM Dhaka is already the next day)', () => {
    expect(formatDayRange(expectedDelivery({ zone: 'inside_dhaka', startAt: '2026-10-08T19:30:00Z', now }))).toBe('Sat 10 – Sun 11 Oct');
    expect(formatDayRange(expectedDelivery({ zone: 'inside_dhaka', startAt: '2026-10-08T17:30:00Z', now }))).toBe('Fri 9 – Sat 10 Oct');
  });
  it('across a month, and a late parcel never shows a date in the past', () => {
    expect(
      formatDayRange(expectedDelivery({ zone: 'outside_dhaka', startAt: '2026-10-30T05:00:00Z', now: new Date('2026-10-30T06:00:00Z') }))
    ).toBe('Sun 1 – Tue 3 Nov');
    const late = expectedDelivery({ zone: 'inside_dhaka', startAt: '2026-10-01T05:00:00Z', now });
    expect(formatDayRange(late)).toBe('Fri 9 – Sat 10 Oct');
  });
  it('times are shown in Dhaka time', () => {
    expect(formatDhakaDateTime('2026-10-08T07:32:00Z')).toBe('8 Oct, 1:32 PM');
    expect(formatDhakaDateTime('2026-10-08T18:05:00Z')).toBe('9 Oct, 12:05 AM');
  });
});

describe('payments are updates too', () => {
  it('each payment becomes "Payment received", never with a TrxID', () => {
    const updates = paymentUpdates([
      { kind: 'payment', amount: 1000, method: 'bkash', paid_at: '2026-10-08T07:00:00Z' },
      { kind: 'refund', amount: 200, method: 'cash', paid_at: '2026-10-08T08:00:00Z' },
    ]);
    expect(updates).toHaveLength(1);
    expect(updates[0].title).toBe('Payment received');
    expect(updates[0].text).toBe('৳1,000 with bKash. Thank you!');
  });
  it('payment pill: pay on delivery / paid in full / balance due', () => {
    expect(customerPaymentPill({ total: 4580, due: 3580, paid: 1000, payLater: false, fallbackPaid: false })).toEqual({
      tone: 'amber',
      text: 'Pay on delivery: ৳3,580',
    });
    expect(customerPaymentPill({ total: 4580, due: 0, paid: 4580, payLater: false, fallbackPaid: false })).toEqual({
      tone: 'green',
      text: 'Paid in full: ৳4,580',
    });
    expect(customerPaymentPill({ total: 4580, due: 4580, paid: 0, payLater: true, fallbackPaid: false })).toEqual({
      tone: 'neutral',
      text: 'Balance due: ৳4,580',
    });
    expect(customerPaymentPill({ total: 4580, due: 3580, paid: 1000, payLater: false, fallbackPaid: false, delivered: true })).toEqual({
      tone: 'neutral',
      text: 'Balance due: ৳3,580',
    });
  });
});

describe('Part 5: greeting in Bangladesh time', () => {
  it('04:00 Hello, 09:00 morning, 14:00 afternoon, 20:00 evening', () => {
    expect(greeting(new Date('2026-10-08T22:00:00Z'))).toBe('Hello'); // 04:00 Dhaka
    expect(greeting(new Date('2026-10-09T03:00:00Z'))).toBe('Good morning'); // 09:00
    expect(greeting(new Date('2026-10-09T08:00:00Z'))).toBe('Good afternoon'); // 14:00
    expect(greeting(new Date('2026-10-09T14:00:00Z'))).toBe('Good evening'); // 20:00
    expect(greeting(new Date('2026-10-08T18:00:00Z'))).toBe('Hello'); // 00:00
    expect(greeting(new Date('2026-10-08T23:00:00Z'))).toBe('Good morning'); // 05:00
  });
});
