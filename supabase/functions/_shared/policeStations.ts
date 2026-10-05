// Steadfast's GET /police_stations answer → a plain thana list (Batch 30
// Part 6). The API guide documents the endpoint ("every thana we deliver
// to, with its district") but not the exact field names, so this reads the
// common shapes: a bare array or one wrapped in data / police_stations /
// result, each row naming the thana as name / police_station / thana /
// title, and the district as a string or an object with a name. Pure code,
// shared by the steadfast function and the website.

export interface PoliceStation {
  name: string;
  district: string;
}

function pickString(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (value && typeof value === 'object') {
      const nested = (value as { name?: unknown }).name;
      if (typeof nested === 'string' && nested.trim() !== '') return nested.trim();
    }
  }
  return '';
}

function findList(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const key of ['data', 'police_stations', 'policeStations', 'result', 'results']) {
    const value = (body as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const inner = findList(value);
      if (inner.length > 0) return inner;
    }
  }
  return [];
}

export function parsePoliceStations(body: unknown): PoliceStation[] {
  const seen = new Set<string>();
  const out: PoliceStation[] = [];
  for (const raw of findList(body)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const name = pickString(row, ['name', 'police_station', 'police_station_name', 'thana', 'thana_name', 'title']);
    if (name === '') continue;
    const district = pickString(row, ['district', 'district_name', 'zilla', 'city', 'city_name']);
    const key = `${district.toLowerCase()}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, district });
  }
  return out;
}
