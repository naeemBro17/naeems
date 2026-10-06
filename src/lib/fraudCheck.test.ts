import { describe, expect, it } from 'vitest';
import { parseFraudCheck } from '../../supabase/functions/_shared/fraudCheck';
import { fraudCheckPhone, fraudTone } from './fraudCheck';

const GUIDE_EXAMPLE = {
  status: 200,
  phone: '01712345678',
  delivery_ratio: 92,
  cancellation_ratio: 7,
  volume_band: 'high',
  volume_range: '50+',
  total_reports: 0,
  fraud_categories: [],
  score: null,
  level: null,
  reasons: [],
  scoring_disabled: true,
  doubtful_reports: false,
};

describe('Steadfast customer check (Batch 31 Part 2)', () => {
  it("reads the guide's example answer", () => {
    expect(parseFraudCheck(GUIDE_EXAMPLE, '01712345678')).toEqual({
      phone: '01712345678',
      deliveryRatio: 92,
      cancellationRatio: 7,
      volumeBand: 'high',
      volumeRange: '50+',
      totalReports: 0,
    });
  });

  it('keeps "no history" as null, never 0', () => {
    const r = parseFraudCheck({ ...GUIDE_EXAMPLE, delivery_ratio: null, cancellation_ratio: null, volume_band: 'none', volume_range: null }, '01712345678');
    expect(r?.deliveryRatio).toBeNull();
    expect(r?.cancellationRatio).toBeNull();
    expect(r && fraudTone(r)).toBe('none');
  });

  it('refuses answers that are not a check', () => {
    expect(parseFraudCheck(null, '01712345678')).toBeNull();
    expect(parseFraudCheck({ status: 429, message: 'Too many' }, '01712345678')).toBeNull();
    expect(parseFraudCheck({ message: 'hello' }, '01712345678')).toBeNull();
  });

  it('colours: ≥80 good, 50–79 warn, <50 risk', () => {
    const at = (n: number) => fraudTone({ phone: '0', deliveryRatio: n, cancellationRatio: 100 - n, volumeBand: 'low', volumeRange: '5', totalReports: 0 });
    expect(at(100)).toBe('good');
    expect(at(80)).toBe('good');
    expect(at(79)).toBe('warn');
    expect(at(50)).toBe('warn');
    expect(at(49)).toBe('risk');
    expect(at(0)).toBe('risk');
  });

  it('normalises the phone like Batch 30', () => {
    for (const raw of ['01712345678', '+880 1712-345678', '8801712345678', '1712345678', '0171 234 5678']) {
      expect(fraudCheckPhone(raw)).toBe('01712345678');
    }
    expect(fraudCheckPhone('0171234')).toBeNull();
    expect(fraudCheckPhone('02 9876543')).toBeNull();
  });
});
