import { describe, expect, it } from 'vitest';
import { STEADFAST_GENERIC_TRACKING_URL, hasOwnTrackingLink, steadfastTrackingUrl } from './steadfastLink';

describe('steadfastTrackingUrl', () => {
  it("uses the parcel's own saved link", () => {
    expect(steadfastTrackingUrl('https://steadfast.com.bd/tl/abc123XY')).toBe('https://steadfast.com.bd/tl/abc123XY');
    expect(hasOwnTrackingLink('https://steadfast.com.bd/tl/abc123XY')).toBe(true);
  });

  it('falls back to the generic page when nothing was saved', () => {
    expect(steadfastTrackingUrl(null)).toBe(STEADFAST_GENERIC_TRACKING_URL);
    expect(steadfastTrackingUrl('')).toBe(STEADFAST_GENERIC_TRACKING_URL);
    expect(hasOwnTrackingLink(undefined)).toBe(false);
  });

  it('never trusts a non-Steadfast or non-https link', () => {
    expect(steadfastTrackingUrl('http://steadfast.com.bd/tl/x')).toBe(STEADFAST_GENERIC_TRACKING_URL);
    expect(steadfastTrackingUrl('https://evil.example/tl/x')).toBe(STEADFAST_GENERIC_TRACKING_URL);
    expect(steadfastTrackingUrl('javascript:alert(1)')).toBe(STEADFAST_GENERIC_TRACKING_URL);
  });
});
