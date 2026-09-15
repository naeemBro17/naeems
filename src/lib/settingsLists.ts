import type { PostgrestError } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { AppSettings } from '../types';

/**
 * Several app_settings rows hold an ordered list of ids as a JSON array
 * (bento slide order, visible Browse categories). A malformed or empty value
 * reads as "no preference" — an empty list — so the consumer falls back to
 * its default ordering instead of failing.
 */
export function parseIdList(raw: string): string[] {
  if (raw.trim() === '') return [];
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) return [];
    return decoded.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

export function serializeIdList(ids: string[]): string {
  return JSON.stringify(ids);
}

/**
 * Apply a saved id order to a list of items. Items named in the order come
 * first in that order; anything not named is dropped when `strict`, or
 * appended in its existing order otherwise. Ids that no longer match an item
 * are ignored, so a deleted product doesn't leave a hole.
 */
export function applyIdOrder<T extends { id: string }>(
  items: T[],
  order: string[],
  strict: boolean
): T[] {
  if (order.length === 0) return items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered: T[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item) {
      ordered.push(item);
      byId.delete(id);
    }
  }
  return strict ? ordered : [...ordered, ...items.filter((item) => byId.has(item.id))];
}

/** Write one or more app_settings rows in a single upsert. */
export async function saveSettings(
  values: Partial<Record<keyof AppSettings, string>>
): Promise<PostgrestError | null> {
  const rows = Object.entries(values).map(([key, value]) => ({ key, value }));
  if (rows.length === 0) return null;
  const { error } = await supabase.from('app_settings').upsert(rows, { onConflict: 'key' });
  return error;
}
