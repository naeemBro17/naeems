import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

import { knownTags, salesBars } from './brandAdmin';

describe('7-day sales bars', () => {
  const days = ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'];

  it('scales to the best day, today last', () => {
    const bars = salesBars(days.map((day, i) => ({ day, total: i === 2 ? 2000 : i === 6 ? 500 : 0, orderCount: 1 })));
    expect(bars[2].heightPct).toBe(100);
    expect(bars[6].heightPct).toBe(25);
    expect(bars[6].isToday).toBe(true);
    expect(bars.filter((b) => b.isToday)).toHaveLength(1);
    expect(bars[0].weekday).toBe('Fri');
    expect(bars[6].date).toBe('1 Oct');
  });

  it('an all-zero week is a flat baseline, no errors', () => {
    const bars = salesBars(days.map((day) => ({ day, total: 0, orderCount: 0 })));
    expect(bars.every((b) => b.heightPct === 0)).toBe(true);
  });
});

describe('customer tags', () => {
  it('lists every used tag, most used first', () => {
    const notes = new Map([
      ['a', { note: '', tags: ['VIP', 'Family'], updatedBy: null, updatedAt: null }],
      ['b', { note: '', tags: ['VIP'], updatedBy: null, updatedAt: null }],
    ]);
    expect(knownTags(notes)).toEqual(['VIP', 'Family']);
  });
});
