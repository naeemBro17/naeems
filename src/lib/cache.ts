import type { Product, Category, AppSettings } from '../types';

const CACHE_KEY = 'price_hub_v1';

export interface CachedData {
  products: Product[];
  categories: Category[];
  /** Optional for backward compatibility with caches written before Group 1. */
  settings?: AppSettings;
}

export function saveCache(data: CachedData): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    // localStorage full or unavailable — fail silently
  }
}

export function loadCache(): CachedData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CachedData) : null;
  } catch {
    return null;
  }
}

export function clearCache(): void {
  localStorage.removeItem(CACHE_KEY);
}
