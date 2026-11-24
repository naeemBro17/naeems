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
import { isFresh, readSwr, writeSwr } from '../lib/swrCache';
import { useAuth } from './AuthContext';
import { parseBannerSlides, BANNER_SLIDES_KEY } from '../lib/bannerSlides';
import { shopVisibleVariants, sortVariants } from '../lib/variants';
import { fetchVariantRows } from '../lib/variantRows';
import { BRANDS_TABLE, BRAND_SELECT } from '../lib/brands';
import { markFirstLoadDone, useBackendDown } from '../lib/backendStatus';
import type { Product, Category, AppSettings, ProductVariant, Brand } from '../types';

interface ProductContextValue {
  /** All fetched products. Admin sessions include inactive products. */
  products: Product[];
  categories: Category[];
  /** Every brand (Batch 26), in no particular order — see lib/brands.ts for
   *  the Home row and brand pages. Empty until migration-032 is run. */
  brands: Brand[];
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
  /** Region/size variants of one product the SHOP shows, in display order
   *  (Batch 62: a size hidden from the shop is left out). Empty when none. */
  variantsFor: (productId: string) => ProductVariant[];
  /** Batch 62: every variant of one product, hidden ones too (admin
   *  screens: the editor, New order / Edit order, Restock). */
  adminVariantsFor: (productId: string) => ProductVariant[];
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

/** Variant rows grouped per product, each list in display order. */
function groupVariants(rows: ProductVariant[]): Map<string, ProductVariant[]> {
  const grouped = new Map<string, ProductVariant[]>();
  for (const row of rows) {
    const list = grouped.get(row.product_id) ?? [];
    list.push(row);
    grouped.set(row.product_id, list);
  }
  for (const [id, list] of grouped) grouped.set(id, sortVariants(list));
  return grouped;
}

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

  delivery_fee_inside_dhaka: '70',
  delivery_fee_outside_dhaka: '130',
  shop_bkash_number: '',
  advance_discount_enabled: 'false',
  advance_discount_type: '',
  advance_discount_value: '0',
  show_rider_phone: 'false',
  inventory_mode: 'false',
  due_reminder_template: '',

  fb_pixel_id: '',
  ga_measurement_id: '',
  text_checkout_signin_title: '',
  text_checkout_signin_message: '',
  text_trust_authentic: '',
  text_trust_cod: '',
  text_trust_delivery: '',
  low_stock_threshold: '5',

  invoice_shop_phone: '',
  invoice_shop_city: '',
  invoice_community_link: '',
  invoice_community_title: '',
  invoice_community_line1: '',
  invoice_community_line2: '',
  invoice_show_community: 'true',

  order_limit_per_item: '4',
  delivery_time_dhaka: '1–2 days',
  delivery_time_outside: '2–3 days',
  delivery_time_buy_after: '3–5 days',
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
  'delivery_fee_inside_dhaka',
  'delivery_fee_outside_dhaka',
  'shop_bkash_number',
  'advance_discount_enabled',
  'advance_discount_type',
  'advance_discount_value',
  'show_rider_phone',
  'inventory_mode',
  'due_reminder_template',
  'fb_pixel_id',
  'ga_measurement_id',
  'text_checkout_signin_title',
  'text_checkout_signin_message',
  'text_trust_authentic',
  'text_trust_cod',
  'text_trust_delivery',
  'low_stock_threshold',
  'invoice_shop_phone',
  'invoice_shop_city',
  'invoice_community_link',
  'invoice_community_title',
  'invoice_community_line1',
  'invoice_community_line2',
  'invoice_show_community',
  'order_limit_per_item',
  'delivery_time_dhaka',
  'delivery_time_outside',
  'delivery_time_buy_after',
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

/** Batch 62: the shop's last good copy (shown at once, refreshed quietly). */
interface ShopCopy {
  products: Product[];
  categories: Category[];
  settings: AppSettings;
  brands: Brand[];
}

export function ProductProvider({ children }: { children: ReactNode }) {
  const { session, can, isLoading: authLoading } = useAuth();
  // The Super Admin, and moderators with "Edit products and stock" (Batch
  // 24), manage inactive products too.
  const isAdmin = can('edit_products');
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
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
  // Batch 62: whose copy this is (an admin's copy has hidden products and
  // wholesale prices, so it is never shown to anyone else).
  const copyKey = `${isAdmin ? 'admin' : 'shop'}:${session?.user.id ?? 'anon'}`;
  const copyKeyRef = useRef(copyKey);
  copyKeyRef.current = copyKey;
  /** When the products / the variants were last read fresh (ms). */
  const fetchedAtRef = useRef(0);

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

      const [productRes, categoryRes, settingsRes, brandRes] = await Promise.all([
        productQuery,
        supabase.from('categories').select('*').order('name', { ascending: true }),
        supabase.from('app_settings').select('key, value'),
        supabase.from(BRANDS_TABLE).select(BRAND_SELECT),
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
      // Brands are non-critical too (no brands table before migration-032).
      const fetchedBrands = brandRes.error ? [] : ((brandRes.data ?? []) as Brand[]);

      setProducts(fetchedProducts);
      setCategories(fetchedCategories);
      setSettings(fetchedSettings);
      setBrands(fetchedBrands);
      setIsOffline(false);
      markFirstLoadDone();
      fetchedAtRef.current = Date.now();
      writeSwr<ShopCopy>(`shop:${copyKeyRef.current}`, {
        products: fetchedProducts,
        categories: fetchedCategories,
        settings: fetchedSettings,
        brands: fetchedBrands,
      });
    } catch {
      const cached = readSwr<ShopCopy>(`shop:${copyKeyRef.current}`)?.data;
      if (cached) {
        setProducts(cached.products);
        setCategories(cached.categories);
        setSettings({ ...DEFAULT_SETTINGS, ...(cached.settings ?? {}) });
        setBrands(cached.brands ?? []);
        setIsOffline(true);
      } else {
        setLoadFailed(true);
      }
    }
  }, []);

  // Variants are non-critical and fetched apart from the product batch: a
  // missing view (migration-013 not run) must not take the catalog down.
  const reloadVariants = useCallback(async () => {
    const { rows, error } = await fetchVariantRows(null);
    if (error) {
      console.warn('Product variants unavailable:', error);
      return;
    }
    const grouped = new Map<string, ProductVariant[]>();
    for (const row of rows) {
      const list = grouped.get(row.product_id) ?? [];
      list.push(row);
      grouped.set(row.product_id, list);
    }
    for (const [id, list] of grouped) grouped.set(id, sortVariants(list));
    setVariantsByProduct(grouped);
    writeSwr<ProductVariant[]>(`variants:${copyKeyRef.current}`, rows);
  }, []);

  const refetch = useCallback(async () => {
    await Promise.all([fetchData(), reloadVariants()]);
  }, [fetchData, reloadVariants]);

  // Initial load + reload whenever auth changes. Admins see inactive rows; any
  // login/logout also changes whether products_view returns wholesale_price, so
  // re-fetch on the signed-in user id and admin flag both.
  //
  // Batch 62: the last good copy for this visitor shows at once (no
  // spinner), and the fresh one replaces it quietly when it arrives.
  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    const copy = readSwr<ShopCopy>(`shop:${copyKey}`);
    const variantsCopy = readSwr<ProductVariant[]>(`variants:${copyKey}`);
    if (copy) {
      setProducts(copy.data.products);
      setCategories(copy.data.categories);
      setSettings({ ...DEFAULT_SETTINGS, ...copy.data.settings });
      setBrands(copy.data.brands ?? []);
      if (variantsCopy) setVariantsByProduct(groupVariants(variantsCopy.data));
      setIsLoading(false);
    } else {
      setIsLoading(true);
    }
    Promise.all([fetchData(), reloadVariants()]).finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [authLoading, isAdmin, session?.user.id, copyKey, fetchData, reloadVariants]);

  // Batch 62: back in the app after a while (the copy is older than 60 s):
  // read the shop again, quietly. Sooner than that nothing is asked again
  // (protects the Supabase bandwidth).
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible' || fetchedAtRef.current === 0) return;
      if (isFresh(fetchedAtRef.current)) return;
      fetchedAtRef.current = Date.now();
      void Promise.all([fetchData(), reloadVariants()]);
    };
    document.addEventListener('visibilitychange', onReturn);
    return () => document.removeEventListener('visibilitychange', onReturn);
  }, [fetchData, reloadVariants]);

  // Batch 40 Part 3: Supabase is reachable again after being blocked or
  // down — load the shop's data again.
  const backendDown = useBackendDown();
  const wasDown = useRef(false);
  useEffect(() => {
    if (backendDown) {
      wasDown.current = true;
      return;
    }
    if (!wasDown.current) return;
    wasDown.current = false;
    void Promise.all([fetchData(), reloadVariants()]);
  }, [backendDown, fetchData, reloadVariants]);

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

  const visibleByProduct = useMemo(() => {
    const out = new Map<string, ProductVariant[]>();
    for (const [id, list] of variantsByProduct) out.set(id, shopVisibleVariants(list));
    return out;
  }, [variantsByProduct]);

  const variantsFor = useCallback(
    (productId: string) => visibleByProduct.get(productId) ?? EMPTY_VARIANTS,
    [visibleByProduct]
  );

  const adminVariantsFor = useCallback(
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
        brands,
        settings,
        isLoading,
        isOffline,
        loadFailed,
        refetch,
        patchProductLocal,
        variantsFor,
        adminVariantsFor,
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
