import { describe, expect, it } from 'vitest';
import {
  customerSafeText,
  deriveOrderStep,
  parseTrackingResponse,
  stepFromTrackingText,
  stepLabel,
  type StepInput,
} from '../../supabase/functions/_shared/steadfastSteps';

// Batch 30 Part 5: every Steadfast status / tracking text → the right step.

const booked = (courierStatus: string | null, events: StepInput['events'] = []): StepInput => ({
  status: 'shipped',
  booked: true,
  courierStatus,
  events,
});
const label = (input: StepInput, audience: 'customer' | 'admin' = 'customer') => stepLabel(deriveOrderStep(input), audience);

describe('order steps from the order itself (not on Steadfast)', () => {
  it('pending → Order Placed, confirmed → Processing', () => {
    expect(label({ status: 'pending', booked: false, courierStatus: null })).toBe('Order Placed');
    expect(label({ status: 'confirmed', booked: false, courierStatus: null })).toBe('Processing');
  });
  it('delivered by hand → Delivered; cancelled → Cancelled', () => {
    expect(label({ status: 'delivered', booked: false, courierStatus: null })).toBe('Delivered');
    expect(label({ status: 'cancelled', booked: false, courierStatus: null })).toBe('Cancelled');
  });
  it('shipped by hand with another courier → In Transit', () => {
    expect(label({ status: 'shipped', booked: false, courierStatus: null })).toBe('In Transit');
  });
});

describe('Steadfast statuses', () => {
  it('in_review, or booked with no status yet → Booked (never "Shipped")', () => {
    expect(label(booked('in_review'))).toBe('Booked');
    expect(label(booked(null))).toBe('Booked');
  });
  it('pending → In Transit', () => {
    expect(label(booked('pending'))).toBe('In Transit');
  });
  it('delivered → Delivered for both', () => {
    expect(label(booked('delivered'))).toBe('Delivered');
    expect(label(booked('delivered'), 'admin')).toBe('Delivered');
  });
  it('delivered_approval_pending → Delivered for the customer, awaiting confirmation for admin', () => {
    expect(label(booked('delivered_approval_pending'))).toBe('Delivered');
    expect(label(booked('delivered_approval_pending'), 'admin')).toBe('Delivered — awaiting Steadfast confirmation');
    expect(deriveOrderStep(booked('delivered_approval_pending')).awaitingConfirmation).toBe(true);
  });
  it('partial_delivered (and its approval / return states) → Partly delivered', () => {
    for (const s of ['partial_delivered', 'partial_delivered_approval_pending', 'partial_delivered_return_received']) {
      expect(label(booked(s))).toBe('Partly delivered');
    }
  });
  it('cancelled and every return status → Cancelled / Returning', () => {
    for (const s of ['cancelled', 'cancelled_approval_pending', 'cancelled_return_proccessing', 'cancelled_return_rider_assigned', 'cancelled_return_received']) {
      expect(label(booked(s))).toBe('Cancelled / Returning');
    }
  });
  it('hold → On hold', () => {
    expect(label(booked('hold'))).toBe('On hold');
  });
  it('exceptional / unknown → Needs attention (admin), a calm message for the customer', () => {
    for (const s of ['exceptional', 'unknown', 'unknown_approval_pending']) {
      expect(label(booked(s), 'admin')).toBe('Needs attention');
      expect(label(booked(s))).toBe("Delayed — we're checking");
    }
  });
});

describe('tracking texts', () => {
  it('"sent to / received at … hub / warehouse" → In Transit (any case, any hub)', () => {
    expect(stepFromTrackingText('Parcel received at Dhanmondi hub.')).toBe('in_transit');
    expect(stepFromTrackingText('SENT TO MIRPUR HUB')).toBe('in_transit');
    expect(stepFromTrackingText('Received at Sorting Warehouse')).toBe('in_transit');
  });
  it('"Assigned to rider" → Out for Delivery', () => {
    expect(stepFromTrackingText('Assigned to rider Md. Karim (01711111111)')).toBe('out_for_delivery');
    expect(stepFromTrackingText('Rider assigned for delivery')).toBe('out_for_delivery');
  });
  it('a hub movement wins over a rider mention (the parcel is back at the hub)', () => {
    expect(stepFromTrackingText('Returned to Mirpur hub by rider')).toBe('in_transit');
  });
  it('"Consignment created" → Booked; anything else → nothing', () => {
    expect(stepFromTrackingText('Consignment created by Sender(API).')).toBe('booked');
    expect(stepFromTrackingText('Customer requested a call')).toBeNull();
    expect(stepFromTrackingText('')).toBeNull();
  });
  it('in_review + hub text → In Transit; pending + rider text → Out for Delivery', () => {
    expect(label(booked('in_review', [{ text: 'Parcel received at Dhanmondi hub.', at: '2026-10-01T10:00:00Z' }]))).toBe('In Transit');
    expect(
      label(
        booked('pending', [
          { text: 'Parcel received at Dhanmondi hub.', at: '2026-10-01T10:00:00Z' },
          { text: 'Assigned to rider Karim', at: '2026-10-02T09:00:00Z' },
        ])
      )
    ).toBe('Out for Delivery');
  });
  it('unknown text never moves the order forward — the last known step stays', () => {
    const step = deriveOrderStep(
      booked('pending', [
        { text: 'Parcel received at Dhanmondi hub.', at: '2026-10-01T10:00:00Z' },
        { text: 'Customer asked to deliver tomorrow', at: '2026-10-02T09:00:00Z' },
      ])
    );
    expect(stepLabel(step, 'customer')).toBe('In Transit');
    expect(step.latest?.text).toBe('Customer asked to deliver tomorrow');
    expect(label(booked('in_review', [{ text: 'Something new happened', at: null }]))).toBe('Booked');
  });
  it('the status is a floor: a "consignment created" text does not pull In Transit back', () => {
    expect(label(booked('pending', [{ text: 'Consignment created by Sender(API).', at: '2026-10-01T07:00:00Z' }]))).toBe('In Transit');
  });
  it('a failed attempt (back at the hub after a rider) goes back to In Transit', () => {
    expect(
      label(
        booked('pending', [
          { text: 'Assigned to rider Karim', at: '2026-10-02T09:00:00Z' },
          { text: 'Parcel received at Dhanmondi hub.', at: '2026-10-02T18:00:00Z' },
        ])
      )
    ).toBe('In Transit');
  });
});

describe('customer-safe text (no rider name or phone)', () => {
  it('a rider assignment becomes one plain sentence', () => {
    expect(customerSafeText('Assigned to rider Md. Karim (01711111111)')).toBe('Assigned to a rider — your parcel is out for delivery.');
  });
  it('phone numbers are removed from any other text', () => {
    const out = customerSafeText('Call 01711-111111 or +8801722222222 before delivery');
    expect(out).not.toMatch(/\d{5,}/);
    expect(out).toContain('before delivery');
  });
  it('plain hub text stays as it is', () => {
    expect(customerSafeText('Parcel received at Dhanmondi hub.')).toBe('Parcel received at Dhanmondi hub.');
  });
});

describe('parseTrackingResponse', () => {
  it('reads the API guide shape, oldest first', () => {
    const events = parseTrackingResponse({
      status: 200,
      tracking: [
        { consignment_id: 1, tracking_type: 2, text: 'Parcel received at Dhanmondi hub.', created_at: '2026-09-20T11:22:04.000000Z' },
        { consignment_id: 1, tracking_type: 1, text: 'Consignment created by Sender(API).', created_at: '2026-09-20T07:05:31.000000Z' },
      ],
    });
    expect(events.map((e) => e.text)).toEqual(['Consignment created by Sender(API).', 'Parcel received at Dhanmondi hub.']);
  });
  it('anything else → no steps', () => {
    expect(parseTrackingResponse(null)).toEqual([]);
    expect(parseTrackingResponse({ status: 404, message: 'Not found' })).toEqual([]);
  });
});

describe('cleaned customer text keeps the same step', () => {
  it('a cleaned rider text still means Out for Delivery; a cleaned hub return still In Transit', () => {
    expect(stepFromTrackingText(customerSafeText('Assigned to rider Md. Karim (01711111111)'))).toBe('out_for_delivery');
    expect(stepFromTrackingText(customerSafeText('Returned to Mirpur hub by rider Karim'))).toBe('in_transit');
  });
});
