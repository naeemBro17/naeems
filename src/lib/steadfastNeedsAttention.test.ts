import { describe, expect, it } from 'vitest';
import { steadfastNeedsAttention } from './orders';

describe('steadfastNeedsAttention', () => {
  it('flags cancelled, hold, and exceptional', () => {
    expect(steadfastNeedsAttention('cancelled')).toBe(true);
    expect(steadfastNeedsAttention('hold')).toBe(true);
    expect(steadfastNeedsAttention('exceptional')).toBe(true);
  });

  it('does not flag routine progress statuses', () => {
    expect(steadfastNeedsAttention('pending')).toBe(false);
    expect(steadfastNeedsAttention('in_review')).toBe(false);
    expect(steadfastNeedsAttention('delivered')).toBe(false);
    expect(steadfastNeedsAttention('partial_delivered')).toBe(false);
  });

  it('does not flag the "_approval_pending" variants — the rider\'s word, not confirmed yet', () => {
    expect(steadfastNeedsAttention('cancelled_approval_pending')).toBe(false);
    expect(steadfastNeedsAttention('delivered_approval_pending')).toBe(false);
  });

  it('does not flag null (not booked / no status yet)', () => {
    expect(steadfastNeedsAttention(null)).toBe(false);
  });
});
