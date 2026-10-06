// Steadfast's GET /police_stations answer → a plain thana list (Batch 30
// Part 6). The API guide documents the endpoint ("every thana we deliver
// to, with its district") but not the exact field names, so this reads the
// common shapes: a bare array or one wrapped in data / police_stations /
// result; each row naming the thana as name / police_station / thana /
// title and the district as a string or an object with a name; or —
// what the live API answers — one row per district with its thanas in a
// nested list. Pure code, shared by the steadfast function and the website.

export interface PoliceStation {
  name: string;
  district: string;
}

const NAME_KEYS = ['name', 'police_station', 'police_station_name', 'thana', 'thana_name', 'title'];
const DISTRICT_KEYS = ['district', 'district_name', 'zilla', 'city', 'city_name'];

function pickString(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
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

/** A nested list of objects inside a row (a district's thanas). */
function childList(row: Record<string, unknown>): Record<string, unknown>[] | null {
  for (const value of Object.values(row)) {
    if (Array.isArray(value) && value.length > 0 && value.every((v) => v && typeof v === 'object')) {
      return value as Record<string, unknown>[];
    }
  }
  return null;
}

/**
 * Batch 31 Part 3: Steadfast's live list contains a row "test thana"
 * (Bagerhat) — their own test data, not ours. Names like that are never
 * shown to customers. No real thana / upazila name contains these words.
 */
export function isPlaceholderPlaceName(name: string): boolean {
  return /\b(test|testing|dummy|demo|sample|e2e)\b/i.test(name);
}

export function parsePoliceStations(body: unknown): PoliceStation[] {
  const seen = new Set<string>();
  const out: PoliceStation[] = [];
  const add = (name: string, district: string) => {
    if (name === '' || isPlaceholderPlaceName(name)) return;
    const key = `${district.toLowerCase()}|${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, district });
  };
  for (const raw of findList(body)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const children = childList(row);
    if (children) {
      // One row per district, its thanas nested.
      const district = pickString(row, [...DISTRICT_KEYS, ...NAME_KEYS]);
      for (const child of children) {
        add(pickString(child, NAME_KEYS), pickString(child, DISTRICT_KEYS) || district);
      }
      continue;
    }
    add(pickString(row, NAME_KEYS), pickString(row, DISTRICT_KEYS));
  }
  return out;
}
