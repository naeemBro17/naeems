import { describe, expect, it } from 'vitest';
import { isPlaceholderPlaceName, parsePoliceStations } from '../../supabase/functions/_shared/policeStations';
import { groupThanas } from './thanas';
import { isTestCustomer, isTestViewer } from './testData';

describe('Batch 31 Part 3: test data never reaches customers or staff lists', () => {
  it("drops Steadfast's own \"test thana\" from their list", () => {
    const live = [{ name: 'Bagerhat', police_stations: [{ name: 'Bagerhat Sadar' }, { name: 'test thana' }, { name: 'Mongla' }] }];
    expect(parsePoliceStations(live).map((s) => s.name)).toEqual(['Bagerhat Sadar', 'Mongla']);
  });

  it('a list already cached on a phone is cleaned when shown', () => {
    const cached = [
      { name: 'Bagerhat Sadar', district: 'Bagerhat' },
      { name: 'test thana', district: 'Bagerhat' },
    ];
    expect(groupThanas(cached, '', 'Bagerhat')).toEqual([{ district: 'Bagerhat', thanas: ['Bagerhat Sadar'] }]);
    expect(groupThanas(cached, 'te', null)).toEqual([]);
  });

  it('never drops a real place name', () => {
    for (const real of ['Kotwali', 'Demra', 'Sadar', 'Contai', 'Latest', 'Tejgaon', 'Teknaf', 'Samplatoli']) {
      expect(isPlaceholderPlaceName(real)).toBe(false);
    }
    expect(isPlaceholderPlaceName('Demo Area')).toBe(true);
    expect(isPlaceholderPlaceName('E2E thana')).toBe(true);
  });

  it('test customers are hidden from real staff, not from the test logins', () => {
    expect(isTestCustomer({ name: 'E2E Test Customer' })).toBe(true);
    expect(isTestCustomer({ name: 'e2e B30 Phone Customer' })).toBe(true);
    expect(isTestCustomer({ name: 'Real Person', email: 'e2e.customer@example.com' })).toBe(true);
    expect(isTestCustomer({ name: 'Ehsan', email: 'ehsan@example.com' })).toBe(false);
    expect(isTestViewer({ username: 'e2e.admin' })).toBe(true);
    expect(isTestViewer({ username: 'naeem' })).toBe(false);
    expect(isTestViewer(null)).toBe(false);
  });
});
