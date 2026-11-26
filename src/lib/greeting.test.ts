import { describe, expect, it } from 'vitest';
import { greetingFor, greetingName, memberSince } from './greeting';

describe('greetingFor', () => {
  it.each([
    [0, 'Good Evening', 'moon'],
    [4, 'Good Evening', 'moon'],
    [5, 'Good Morning', 'sun'],
    [11, 'Good Morning', 'sun'],
    [12, 'Good Afternoon', 'sun'],
    [16, 'Good Afternoon', 'sun'],
    [17, 'Good Evening', 'moon'],
    [23, 'Good Evening', 'moon'],
  ])('hour %i is %s', (hour, text, icon) => {
    expect(greetingFor(hour)).toEqual({ text, icon });
  });
});

describe('greetingName', () => {
  it('takes the first name in capitals', () => {
    expect(greetingName('Sadia Rahman')).toBe('SADIA');
    expect(greetingName('  sadia ')).toBe('SADIA');
  });
  it('falls back to THERE', () => {
    expect(greetingName('')).toBe('THERE');
    expect(greetingName(null)).toBe('THERE');
  });
});

describe('memberSince', () => {
  it('shows the short month and year', () => {
    expect(memberSince('2026-10-15T12:00:00Z')).toBe('Oct 2026');
  });
  it('returns empty for a bad date', () => {
    expect(memberSince('not a date')).toBe('');
  });
});
