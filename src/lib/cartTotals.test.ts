import { describe, expect, it } from 'vitest';
import { cartYouSave, countPieces, summaryAddressLine } from './cartTotals';

describe('countPieces', () => {
  it('counts pieces, not lines', () => {
    expect(countPieces([{ quantity: 2 }, { quantity: 1 }])).toBe(3);
    expect(countPieces([])).toBe(0);
  });
});

describe('cartYouSave', () => {
  it('adds what each line saves against retail, times its quantity', () => {
    expect(
      cartYouSave([
        { quantity: 2, unitPrice: 1350, retail: 1600 },
        { quantity: 1, unitPrice: 800, retail: 1050 },
      ])
    ).toBe(750);
  });

  it('skips a line with no known retail price or no discount', () => {
    expect(
      cartYouSave([
        { quantity: 3, unitPrice: 500, retail: null },
        { quantity: 1, unitPrice: 900, retail: 900 },
        { quantity: 1, unitPrice: 1000, retail: 950 },
      ])
    ).toBe(0);
  });
});

describe('summaryAddressLine', () => {
  it('adds the thana and district after the typed address', () => {
    expect(summaryAddressLine({ fullAddress: 'House 32, Road 7', thana: 'Dhanmondi', district: 'Dhaka' })).toBe(
      'House 32, Road 7, Dhanmondi, Dhaka'
    );
  });

  it('leaves out a thana or district the address already says (any case)', () => {
    expect(summaryAddressLine({ fullAddress: 'House 32, Road 7, dhanmondi', thana: 'Dhanmondi', district: 'Dhaka' })).toBe(
      'House 32, Road 7, dhanmondi, Dhaka'
    );
    expect(summaryAddressLine({ fullAddress: 'Flat 4B, Gulshan 2, Dhaka', thana: 'Gulshan', district: 'Dhaka' })).toBe(
      'Flat 4B, Gulshan 2, Dhaka'
    );
  });

  it('says a district with the same name as the thana once, and skips empty parts', () => {
    expect(summaryAddressLine({ fullAddress: '12 Station Road', thana: 'Cumilla', district: 'Cumilla' })).toBe(
      '12 Station Road, Cumilla'
    );
    expect(summaryAddressLine({ fullAddress: '  12 Station Road ', thana: '', district: ' ' })).toBe('12 Station Road');
  });
});
