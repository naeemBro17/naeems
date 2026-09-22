import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { supabase } from '../lib/supabase';
import { saveCache, loadCache } from '../lib/cache';
import { useAuth } from './AuthContext';
import { parseBannerSlides, BANNER_SLIDES_KEY } from '../lib/bannerSlides';
import { sortVariants, VARIANT_SELECT, VARIANTS_VIEW } from '../lib/variants';
import type { Product, Category, AppSettings, ProductVariant } from '../types';

interface ProductContextValue {
  /** All fetched products. Admin sessions include inactive products. */
  products: Product[];
  categories: Category[];
  /** Single-value app settings (expert contact info). Never null — falls back to defaults. */
  settings: AppSettings;
  isLoading: boolean;
  /** True when showing cached data because the network fetch failed. */
  isOffline: boolean;
  /** True when the fetch failed AND there is no cache to fall back on. */
  loadFailed: boolean;
  /** Re-fetch everything from Supabase (call after any admin change). */
  refetch: () => Promise<void>;
  /** Optimistically patch one product in local state (no network call). */
  patchProductLocal: (id: string, patch: Partial<Product>) => void;
  /** Region/size variants of one product, in display order. Empty when none. */
  variantsFor: (productId: string) => ProductVariant[];
  /** Every variant row across every product — lets the admin editor offer
   *  existing Region/Size values instead of free text (see VariantEditor). */
  allVariants: ProductVariant[];
  /** Re-read product_variants_view only (after the admin edits a variant). */
  reloadVariants: () => Promise<void>;
}

const ProductContext = createContext<ProductContextValue | null>(null);

/**
 * The ONLY sanctioned product read source. products_view returns
 * wholesale_price only to approved wholesalers/admins (NULL otherwise) — the
 * base products table's wholesale_price column is REVOKEd from all API roles.
 */
export const PRODUCTS_VIEW = 'products_view';

/** Shared product select — reused by the single-product fetch on the detail page. */
export const PRODUCT_SELECT = '*, category:categories(id, name, slug)';

/** Stable empty list so consumers' memo deps don't churn for variant-less products. */
const EMPTY_VARIANTS: ProductVariant[] = [];

export const DEFAULT_SETTINGS: AppSettings = {
  messenger_link: '',
  expert_name: 'Naeem',
  expert_bio: '',
  expert_photo_url: '',
  banner_slides: [],

  expert_location: '',
  expert_title: '',
  expert_reply_time: '',
  expert_whatsapp_url: '',
  expert_instagram_url: '',
  expert_instagram_handle: '',
  expert_facebook_url: '',
  expert_threads_url: '',
  expert_threads_handle: '',
  expert_youtube_url: '',
  expert_appointment_url: '',
  expert_stat_1_value: '',
  expert_stat_1_label: '',
  expert_stat_2_value: '',
  expert_stat_2_label: '',
  expert_stat_3_value: '',
  expert_stat_3_label: '',

  bento_expert_subtitle: '',
  bento_left_order: '',
  bento_right_top_order: '',
  browse_categories_order: '',

  bento_tile_order: '',
  homepage_section_order: '',

  shop_whatsapp_number: '',
};

/**
 * Every plain-text setting key. Each falls back to its DEFAULT_SETTINGS value
 * when the row is absent, so a project that hasn't run the seed migration yet
 * still renders.
 */
const TEXT_SETTING_KEYS = [
  'messenger_link',
  'expert_name',
  'expert_bio',
  'expert_photo_url',
  'expert_location',
  'expert_title',
  'expert_reply_time',
  'expert_whatsapp_url',
  'expert_instagram_url',
  'expert_instagram_handle',
  'expert_facebook_url',
  'expert_threads_url',
  'expert_threads_handle',
  'expert_youtube_url',
  'expert_appointment_url',
  'expert_stat_1_value',
  'expert_stat_1_label',
  'expert_stat_2_value',
  'expert_stat_2_label',
  'expert_stat_3_value',
  'expert_stat_3_label',
  'bento_expert_subtitle',
  'bento_left_order',
  'bento_right_top_order',
  'browse_categories_order',
  'bento_tile_order',
  'homepage_section_order',
  'shop_whatsapp_number',
] as const satisfies readonly (keyof AppSettings)[];

export type TextSettingKey = (typeof TEXT_SETTING_KEYS)[number];

/** Fold app_settings key/value rows into a typed AppSettings object. */
function rowsToSettings(rows: { key: string; value: string | null }[]): AppSettings {
  const map = new Map(rows.map((r) => [r.key, r.value ?? '']));
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    banner_slides: parseBannerSlides(map.get(BANNER_SLIDES_KEY) ?? ''),
  };
  for (const key of TEXT_SETTING_KEYS) {
    const value = map.get(key);
    if (value !== undefined) settings[key] = value;
  }
  return settings;
}

/**
 * Ordering for the default "All" homepage view: featured products first
 * (most recently updated among them), then the rest in their existing order.
 * Array.sort is stable (ES2019+), so returning 0 preserves the incoming
 * name-ascending order for non-featured items.
 */
export function sortFeaturedFirst(products: Product[]): Product[] {
  return [...products].sort((a, b) => {
    if (a.is_featured && b.is_featured) {
      return b.updated_at.localeCompare(a.updated_at);
    }
    if (a.is_featured) return -1;
    if (b.is_featured) return 1;
    return 0;
  });
}

export function ProductProvider({ children }: { children: ReactNode }) {
  const { session, isAdmin, isLoading: authLoading } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [variantsByProduct, setVariantsByProduct] = useState<Map<string, ProductVariant[]>>(
    () => new Map()
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Only a real approved admin fetches inactive rows; a logged-in wholesaler
  // browses active-only like a customer (they just also get wholesale_price).
  const isAdminRef = useRef(isAdmin);
  isAdminRef.current = isAdmin;

  const fetchData = useCallback(async () => {
    setLoadFailed(false);
    try {
      // All product reads go through products_view (never the base table).
      // Viewers/wholesalers only see active products; admins need all of them.
      // The view runs with owner privileges and bypasses the base table's RLS
      // row filter, so the active-only filter is applied here in the query.
      let productQuery = supabase
        .from(PRODUCTS_VIEW)
        .select(PRODUCT_SELECT)
        .order('name', { ascending: true });
      if (!isAdminRef.current) {
        productQuery = productQuery.eq('is_active', true);
      }

      const [productRes, categoryRes, settingsRes] = await Promise.all([
        productQuery,
        supabase.from('categories').select('*').order('name', { ascending: true }),
        supabase.from('app_settings').select('key, value'),
      ]);

      if (productRes.error) throw productRes.error;
      if (categoryRes.error) throw categoryRes.error;

      const fetchedProducts = (productRes.data ?? []) as Product[];
      const fetchedCategories = (categoryRes.data ?? []) as Category[];
      // Settings are non-critical: a missing app_settings table (migration not
      // yet run) must not break the whole product load — fall back to defaults.
      const fetchedSettings = settingsRes.error
        ? DEFAULT_SETTINGS
        : rowsToSettings(settingsRes.data ?? []);

      setProducts(fetchedProducts);
      setCategories(fetchedCategories);
      setSettings(fetchedSettings);
      setIsOffline(false);
      saveCache({
        products: fetchedProducts,
        categories: fetchedCategories,
        settings: fetchedSettings,
      });
    } catch {
      const cached = loadCache();
      if (cached) {
        setProducts(cached.products);
        setCategories(cached.categories);
        setSettings({ ...DEFAULT_SETTINGS, ...(cached.settings ?? {}) });
        setIsOffline(true);
      } else {
        setLoadFailed(true);
      }
    }
  }, []);

  // Variants are non-critical and fetched apart from the product batch: a
  // missing view (migration-013 not run) must not take the catalog down.
  const reloadVariants = useCallback(async () => {
    const { data, error } = await supabase.from(VARIANTS_VIEW).select(VARIANT_SELECT);
    if (error) {
      console.warn('Product variants unavailable:', error.message);
      return;
    }
    const grouped = new Map<string, ProductVariant[]>();
    for (const row of (data ?? []) as ProductVariant[]) {
      const list = grouped.get(row.product_id) ?? [];
      list.push(row);
      grouped.set(row.product_id, list);
    }
    for (const [id, list] of grouped) grouped.set(id, sortVariants(list));
    setVariantsByProduct(grouped);
  }, []);

  const refetch = useCallback(async () => {
    await Promise.all([fetchData(), reloadVariants()]);
  }, [fetchData, reloadVariants]);

  // Initial load + reload whenever auth changes. Admins see inactive rows; any
  // login/logout also changes whether products_view returns wholesale_price, so
  // re-fetch on the signed-in user id and admin flag both.
  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    setIsLoading(true);
    Promise.all([fetchData(), reloadVariants()]).finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [authLoading, isAdmin, session?.user.id, fetchData, reloadVariants]);

  // Auto-dismiss the offline banner when connectivity restores.
  useEffect(() => {
    if (!isOffline) return;
    const handleOnline = () => {
      void fetchData();
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [isOffline, fetchData]);

  const patchProductLocal = useCallback((id: string, patch: Partial<Product>) => {
    setProducts((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const variantsFor = useCallback(
    (productId: string) => variantsByProduct.get(productId) ?? EMPTY_VARIANTS,
    [variantsByProduct]
  );

  const allVariants = useMemo(
    () => Array.from(variantsByProduct.values()).flat(),
    [variantsByProduct]
  );

  return (
    <ProductContext.Provider
      value={{
        products,
        categories,
        settings,
        isLoading,
        isOffline,
        loadFailed,
        refetch,
        patchProductLocal,
        variantsFor,
        allVariants,
        reloadVariants,
      }}
    >
      {children}
    </ProductContext.Provider>
  );
}

export function useProducts(): ProductContextValue {
  const ctx = useContext(ProductContext);
  if (!ctx) {
    throw new Error('useProducts must be used within a ProductProvider');
  }
  return ctx;
}
