import { describe, expect, it } from 'vitest';
import { arrivalRange, arrivesByDay } from './sellRules';

// Fri 27 Nov 2026, 10:00 Dhaka time (UTC+6).
const NOW = '2026-11-27T04:00:00.000Z';
const SETTINGS = {
  delivery_time_dhaka: '1 to 2 days',
  delivery_time_outside: '2 to 3 days',
  delivery_time_buy_after: '3 to 5 days',
};

describe('Fix 72.1: arrivesByDay', () => {
  it('in hand: the last day of the outside-Dhaka range', () => {
    expect(arrivesByDay(SETTINGS, { available: true, inHand: true }, NOW)).toBe('Mon, 30 Nov');
  });

  it('matches the last chip the Order Placed page shows for an outside-Dhaka order', () => {
    const range = arrivalRange(NOW, 'outside_dhaka', false, SETTINGS);
    const last = range?.to ?? range?.from;
    expect(last).toEqual({ weekday: 'MON', day: 30, month: 'Nov' });
  });

  it('not in hand: the last day of the buy-after range', () => {
    expect(arrivesByDay(SETTINGS, { available: true, inHand: false }, NOW)).toBe('Wed, 2 Dec');
  });

  it('a one-day range gives that day', () => {
    expect(arrivesByDay({ ...SETTINGS, delivery_time_outside: '4 days' }, { available: true, inHand: true }, NOW)).toBe(
      'Tue, 1 Dec'
    );
  });

  it('sold out: null', () => {
    expect(arrivesByDay(SETTINGS, { available: false, inHand: true }, NOW)).toBeNull();
  });

  it('delivery times with no number: null', () => {
    expect(arrivesByDay({ ...SETTINGS, delivery_time_outside: 'soon' }, { available: true, inHand: true }, NOW)).toBeNull();
    expect(arrivesByDay({ ...SETTINGS, delivery_time_buy_after: 'ask us' }, { available: true, inHand: false }, NOW)).toBeNull();
  });
});
