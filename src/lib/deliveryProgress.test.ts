import { describe, expect, it } from 'vitest';
import { deliveryProgress } from './deliveryProgress';

const base = {
  status: 'pending' as const,
  steadfast_status: null,
  steadfast_status_updated_at: null,
  created_at: '2026-10-01T08:00:00.000Z',
  updated_at: '2026-10-01T08:00:00.000Z',
};

describe('deliveryProgress', () => {
  it('follows the order status before the courier has it', () => {
    expect(deliveryProgress(base).label).toBe('Order placed');
    expect(deliveryProgress({ ...base, status: 'confirmed' }).label).toBe('Confirmed');
    expect(deliveryProgress({ ...base, status: 'shipped' }).label).toBe('Handed to courier');
  });

  it('turns Steadfast statuses into friendly steps', () => {
    const shipped = { ...base, status: 'shipped' as const, steadfast_status_updated_at: '2026-10-02T10:00:00.000Z' };
    expect(deliveryProgress({ ...shipped, steadfast_status: 'in_review' }).label).toBe('Handed to courier');
    expect(deliveryProgress({ ...shipped, steadfast_status: 'pending' }).label).toBe('On the way');
    expect(deliveryProgress({ ...shipped, steadfast_status: 'delivered_approval_pending' }).label).toBe('On the way');
    expect(deliveryProgress({ ...shipped, steadfast_status: 'delivered' }).label).toBe('Delivered');
    expect(deliveryProgress({ ...shipped, steadfast_status: 'partial_delivered' }).stepIndex).toBe(4);
    expect(deliveryProgress({ ...shipped, steadfast_status: 'hold' }).label).toBe('On hold');
    expect(deliveryProgress({ ...shipped, steadfast_status: 'exceptional' }).exception).toBe('on_hold');
    expect(deliveryProgress({ ...shipped, steadfast_status: 'cancelled' }).label).toBe('Returned');
    expect(deliveryProgress({ ...shipped, steadfast_status: 'pending' }).updatedAt).toBe('2026-10-02T10:00:00.000Z');
  });

  it('shows Cancelled for a cancelled order and Delivered for a delivered one', () => {
    expect(deliveryProgress({ ...base, status: 'cancelled' }).label).toBe('Cancelled');
    expect(deliveryProgress({ ...base, status: 'delivered' }).label).toBe('Delivered');
  });

  it('uses the latest history time when there is no courier update', () => {
    const progress = deliveryProgress({ ...base, status: 'confirmed' }, [
      { changed_at: '2026-10-01T08:00:00.000Z' },
      { changed_at: '2026-10-01T09:30:00.000Z' },
    ]);
    expect(progress.updatedAt).toBe('2026-10-01T09:30:00.000Z');
  });
});
