import { afterEach, describe, expect, it, vi } from 'vitest';
import { arrivalRange, arrivalText } from './sellRules';
import { isPlacedSoundOn, playTing, playVroom, setPlacedSoundOn } from './placedSound';

const settings = {
  delivery_time_dhaka: '1 to 2 days',
  delivery_time_outside: '2 to 3 days',
  delivery_time_buy_after: '3 to 5 days',
};
// Thursday 19 November 2026, 10:00 in Dhaka.
const placed = '2026-11-19T04:00:00Z';

describe('Fix 69.1 Part A: the arrival days as chips', () => {
  it('a two-day range gives two chips with the same days as the text', () => {
    expect(arrivalText(placed, 'inside_dhaka', true, settings)).toBe('Arriving Sun, 22 to Tue, 24 Nov');
    expect(arrivalRange(placed, 'inside_dhaka', true, settings)).toEqual({
      from: { weekday: 'SUN', day: 22, month: 'Nov' },
      to: { weekday: 'TUE', day: 24, month: 'Nov' },
    });
    expect(arrivalRange(placed, 'inside_dhaka', false, settings)).toEqual({
      from: { weekday: 'FRI', day: 20, month: 'Nov' },
      to: { weekday: 'SAT', day: 21, month: 'Nov' },
    });
  });

  it('a same-day setting gives one chip', () => {
    expect(arrivalRange(placed, 'inside_dhaka', false, { ...settings, delivery_time_dhaka: '2 days' })).toEqual({
      from: { weekday: 'SAT', day: 21, month: 'Nov' },
      to: null,
    });
  });

  it('a range across a month end has the right month on each chip', () => {
    expect(arrivalRange('2026-11-26T06:00:00Z', 'inside_dhaka', true, settings)).toEqual({
      from: { weekday: 'SUN', day: 29, month: 'Nov' },
      to: { weekday: 'TUE', day: 1, month: 'Dec' },
    });
  });

  it('no number in the setting gives null', () => {
    expect(arrivalRange(placed, 'outside_dhaka', false, { ...settings, delivery_time_outside: 'soon' })).toBeNull();
  });
});

describe('Fix 69.1 Part B: the sound switch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('is on by default and remembers the choice', () => {
    window.localStorage.clear();
    expect(isPlacedSoundOn()).toBe(true);
    setPlacedSoundOn(false);
    expect(isPlacedSoundOn()).toBe(false);
    setPlacedSoundOn(true);
    expect(isPlacedSoundOn()).toBe(true);
  });

  it('is on when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(isPlacedSoundOn()).toBe(true);
  });

  it('stays silent without throwing when the browser has no audio', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    expect(() => playTing()).not.toThrow();
    expect(() => playVroom()).not.toThrow();
  });
});
