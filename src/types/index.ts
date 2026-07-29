export interface Category {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  /** Longer free-text shown only on the detail page, under the name. */
  description: string | null;
  category_id: string | null;
  category: Pick<Category, 'id' | 'name' | 'slug'> | null;
  retail_price: number;
  /** Optional discounted price. When set (and < retail_price) it becomes the
   *  main displayed price and retail_price shows struck through. */
  offer_price: number | null;
  wholesale_price: number | null;
  stock_status: 'in_stock' | 'low_stock' | 'out_of_stock';
  stock_quantity: number | null;
  note: string | null;
  /** Featured products sort first in the default homepage view. */
  is_featured: boolean;
  /**
   * True when the product has a wholesale price set, regardless of whether the
   * current viewer is allowed to see the value. Comes from products_view and
   * lets the wholesale row tell "not approved" apart from "no wholesale price".
   */
  has_wholesale: boolean;
  /** Cover image — always the first entry of image_urls (kept for CSV export & cache compat). */
  image_url: string | null;
  /** All product images, in display order. May be absent in pre-migration cached data. */
  image_urls: string[] | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type StockStatus = Product['stock_status'];

export interface ProductFormData {
  sku: string;
  name: string;
  description: string;
  category_id: string;
  retail_price: string;
  offer_price: string;
  wholesale_price: string;
  stock_status: 'in_stock' | 'low_stock' | 'out_of_stock';
  stock_quantity: string;
  note: string;
  is_featured: boolean;
  is_active: boolean;
}

export type UserRole = 'wholesaler' | 'admin';
export type ProfileStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

/** The current user's profile row (role + approval status). */
export interface Profile {
  id: string;
  role: UserRole;
  status: ProfileStatus;
  business_name: string | null;
  phone: string | null;
  created_at: string;
  approved_at: string | null;
}

/** One row of the admin Wholesalers tab (profile joined with auth email). */
export interface WholesalerAccount {
  id: string;
  role: UserRole;
  status: ProfileStatus;
  business_name: string | null;
  phone: string | null;
  email: string | null;
  created_at: string;
  approved_at: string | null;
}

/** Single-value settings from the app_settings key/value table. */
export interface AppSettings {
  messenger_link: string;
  expert_name: string;
  expert_bio: string;
  expert_photo_url: string;
}

/** One image slot in the product form: an already-uploaded URL or a pending file. */
export interface FormImage {
  /** Stable key for list rendering and removal. */
  id: string;
  /** Public URL when already uploaded; null for files pending upload. */
  url: string | null;
  /** File chosen this session, not yet uploaded; null for existing images. */
  file: File | null;
}

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

export interface CachedData {
  products: Product[];
  categories: Category[];
}

/** One parsed row from an imported CSV file (all values as strings). */
export interface CSVRow {
  sku: string;
  name: string;
  description: string;
  category_name: string;
  retail_price: string;
  offer_price: string;
  wholesale_price: string;
  stock_status: string;
  stock_quantity: string;
  note: string;
  is_active: string;
}

/** Validation result attached to each CSV row before import. */
export interface CSVRowValidation {
  row: CSVRow;
  rowNumber: number;
  errors: string[];
}

export interface ImportSummary {
  added: number;
  updated: number;
  failed: { rowNumber: number; sku: string; reason: string }[];
}
