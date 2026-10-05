import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { BD_DISTRICTS, BD_THANAS } from '../data/bangladeshGeo';
import { parsePoliceStations } from '../../supabase/functions/_shared/policeStations';

/* Batch 30 Part 6 — every thana, in checkout and admin.
   The list Steadfast delivers to (GET /police_stations through the
   steadfast function) is used once the function answers; until then, and
   whenever it can't be reached, the list bundled with the site (the
   snapshot: src/data/bangladeshGeo.ts) is used, so the picker always opens
   instantly. Steadfast's answer is kept on the phone for 7 days and
   refreshed in the background after that. */

export interface ThanaEntry {
  name: string;
  /** The district as the site's district list spells it, when it matches
   *  one; otherwise Steadfast's own spelling. */
  district: string;
}

export interface ThanaGroup {
  district: string;
  thanas: string[];
}

export type ThanaSource = 'steadfast' | 'snapshot';

const CACHE_KEY = 'steadfast-thanas-v1';
const CACHE_MS = 7 * 24 * 60 * 60 * 1000;

/** District spellings that differ by more than vowels/doubled letters. */
const DISTRICT_ALIASES: Record<string, string> = {
  chittagong: 'chattogram',
  chattagram: 'chattogram',
  ctg: 'chattogram',
  laxmipur: 'lakshmipur',
  nawabganj: 'chapainawabganj',
  chapainababganj: 'chapainawabganj',
  cumilla: 'comilla',
  // Steadfast's live list (checked after deploy) splits Dhaka in two.
  dhakacity: 'dhaka',
  dhakasuburban: 'dhaka',
  narshindi: 'narsingdi',
};

function letters(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '').replace(/gonj/g, 'ganj');
}

/** Spelling-tolerant key: "Jhalokati" = "Jhalakathi", "Bogra" = "Bogura". */
function skeleton(name: string): string {
  const base = letters(name);
  const aliased = DISTRICT_ALIASES[base] ?? base;
  return aliased.replace(/[aeiouhyw]/g, '').replace(/(.)\1+/g, '$1');
}

const DISTRICT_BY_SKELETON = new Map(BD_DISTRICTS.map((d) => [skeleton(d.name), d.name]));

/** The site's own district name for a district as Steadfast spells it. */
export function matchDistrict(name: string): string | null {
  if (name.trim() === '') return null;
  return DISTRICT_BY_SKELETON.get(skeleton(name)) ?? null;
}

/** The list bundled with the site (559 thanas in 64 districts). */
export function snapshotThanas(): ThanaEntry[] {
  const districtName = new Map(BD_DISTRICTS.map((d) => [d.id, d.name]));
  return BD_THANAS.map((t) => ({ name: t.name, district: districtName.get(t.districtId) ?? '' }));
}

/** Steadfast's rows → entries with the site's district spelling. */
export function toThanaEntries(rows: { name: string; district: string }[]): ThanaEntry[] {
  return rows.map((r) => ({ name: r.name, district: matchDistrict(r.district) ?? r.district }));
}

/**
 * Grouped by district, districts A–Z and thanas A–Z within each. The chosen
 * district comes first. A search matches thana or district names; without a
 * search only the chosen district is listed (all when none is chosen).
 */
export function groupThanas(list: ThanaEntry[], query: string, district: string | null): ThanaGroup[] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, Set<string>>();
  for (const t of list) {
    const d = t.district || 'Other areas';
    if (q === '') {
      if (district && d !== district) continue;
    } else if (!t.name.toLowerCase().includes(q) && !d.toLowerCase().includes(q)) {
      continue;
    }
    const set = groups.get(d) ?? new Set<string>();
    set.add(t.name);
    groups.set(d, set);
  }
  return [...groups.entries()]
    .map(([d, names]) => ({ district: d, thanas: [...names].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => {
      if (district && a.district === district) return -1;
      if (district && b.district === district) return 1;
      return a.district.localeCompare(b.district);
    });
}

function readCache(): { at: number; list: ThanaEntry[] } | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; list: ThanaEntry[] };
    return Array.isArray(parsed.list) && parsed.list.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(list: ThanaEntry[]): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), list }));
  } catch {
    // Storage full or blocked: the list is simply fetched again next time.
  }
}

/** Steadfast's list through the steadfast function; null when it isn't
 *  deployed with this action yet or can't be reached. */
export async function fetchSteadfastThanas(): Promise<ThanaEntry[] | null> {
  try {
    const { data, error } = await supabase.functions.invoke('steadfast', { body: { action: 'police_stations' } });
    if (error) return null;
    const body = data as { ok?: boolean; stations?: unknown };
    if (!body?.ok) return null;
    const rows = parsePoliceStations(body.stations);
    return rows.length > 0 ? toThanaEntries(rows) : null;
  } catch {
    return null;
  }
}

let inFlight: Promise<ThanaEntry[] | null> | null = null;

/**
 * The thana list for a picker: instant (cached Steadfast list, else the
 * snapshot), refreshed in the background when the cache is missing or
 * older than 7 days.
 */
export function useThanaList(enabled: boolean): { list: ThanaEntry[]; source: ThanaSource } {
  const [state, setState] = useState<{ list: ThanaEntry[]; source: ThanaSource }>(() => {
    const cached = typeof window === 'undefined' ? null : readCache();
    return cached ? { list: cached.list, source: 'steadfast' } : { list: snapshotThanas(), source: 'snapshot' };
  });

  useEffect(() => {
    if (!enabled) return;
    const cached = readCache();
    if (cached && Date.now() - cached.at < CACHE_MS) return;
    let alive = true;
    inFlight = inFlight ?? fetchSteadfastThanas();
    void inFlight.then((list) => {
      inFlight = null;
      if (!alive || !list) return;
      writeCache(list);
      setState({ list, source: 'steadfast' });
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return state;
}
