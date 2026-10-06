// Batch 31 Part 2: Steadfast's customer check, GET /fraud_check/score/{phone}.
//
// Steadfast's guide: the figures come from every merchant's history with
// that number. `delivery_ratio` / `cancellation_ratio` are whole percents of
// FINISHED parcels (each rounded down, so they can add up to 99) and are
// null — not 0 — when nothing has finished for the number: "we do not
// know", never a clean record. `volume_range` is the parcel count as
// merchants see it ("7", then "10+", "25+", "50+", "100+"); exact totals
// are no longer given (the old /fraud_check/{phone} counts stopped on
// 27 September 2026). `score` / `level` are permanently null (scoring off),
// so they are not read.
//
// Shared by the steadfast Edge Function (Deno) and the website (src/lib/fraudCheck.ts).

export interface FraudCheckResult {
  /** 01XXXXXXXXX */
  phone: string;
  /** % of finished parcels delivered; null = no history. */
  deliveryRatio: number | null;
  /** % of finished parcels cancelled / returned; null = no history. */
  cancellationRatio: number | null;
  /** none | low | medium | high | very_high, as Steadfast sends it. */
  volumeBand: string | null;
  /** "7", "10+", "50+" … ; null = no history. */
  volumeRange: string | null;
  /** Reports other merchants filed against the number. */
  totalReports: number;
}

function percent(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(100, Math.floor(v)));
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return percent(Number(v));
  return null;
}

/** Steadfast's answer → our result, or null when it isn't a usable answer. */
export function parseFraudCheck(body: unknown, phone: string): FraudCheckResult | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.status === 'number' && b.status !== 200) return null;
  if (!('delivery_ratio' in b) && !('cancellation_ratio' in b) && !('volume_band' in b)) return null;
  const reports = typeof b.total_reports === 'number' && b.total_reports > 0 ? Math.floor(b.total_reports) : 0;
  return {
    phone,
    deliveryRatio: percent(b.delivery_ratio),
    cancellationRatio: percent(b.cancellation_ratio),
    volumeBand: typeof b.volume_band === 'string' ? b.volume_band : null,
    volumeRange: typeof b.volume_range === 'string' && b.volume_range.trim() !== '' ? b.volume_range.trim() : null,
    totalReports: reports,
  };
}
