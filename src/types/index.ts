export interface Category {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export interface Product {
  id: string;
  /** Internal reference, auto-generated. Never shown in the public UI. */
  sku: string;
  /**
   * URL-friendly identifier for /product/:slug. Absent (undefined) on rows
   * cached before migration-008 — fall back to sku when resolving a route.
   */
  slug: string | null;
  name: string;
  /**
   * Manufacturer / brand name, shown above the product name. Optional, and
   * absent (undefined) in cached data written before migration-007.
   */
  brand: string | null;
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
  /** Detail-page accordion: application instructions. Hidden when empty. */
  how_to_use: string | null;
  /** Detail-page accordion: active ingredients. Hidden when empty. */
  key_ingredients: string | null;
  /** Detail-page accordion: link to a review video. Hidden when empty. */
  youtube_url: string | null;
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
  /** Read-only in edit mode; auto-generated on create. */
  sku: string;
  name: string;
  brand: string;
  description: string;
  how_to_use: string;
  key_ingredients: string;
  youtube_url: string;
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

/** What a hero banner slide's CTA button does when tapped. */
export type BannerCtaAction = 'scroll_to_products' | 'open_contact' | 'open_url';

/** One hero banner slide, stored in app_settings under the 'banner_slides' key. */
export interface BannerSlide {
  eyebrow_text: string;
  /** Headline — clamped to 2 lines in the banner. */
  title: string;
  cta_button_text: string;
  cta_action: BannerCtaAction;
  /** Destination for cta_action 'open_url'; ignored otherwise. */
  cta_url: string;
  /** Hex background reserved for future per-slide custom grounds. */
  background_color: string;
  is_active: boolean;
}

/** Settings from the app_settings key/value table. */
export interface AppSettings {
  messenger_link: string;
  expert_name: string;
  expert_bio: string;
  expert_photo_url: string;
  /** Parsed from the JSON array stored under the 'banner_slides' key. */
  banner_slides: BannerSlide[];

  /* --- Expert profile page (/contact) --- */
  expert_location: string;
  expert_title: string;
  expert_reply_time: string;
  /** Either a full URL or a bare phone number (turned into a wa.me link). */
  expert_whatsapp_url: string;
  expert_instagram_url: string;
  /** @handle shown as the Instagram button's sub-text. */
  expert_instagram_handle: string;
  expert_facebook_url: string;
  expert_threads_url: string;
  /** @handle shown as the Threads button's sub-text. */
  expert_threads_handle: string;
  expert_youtube_url: string;
  expert_appointment_url: string;
  expert_stat_1_value: string;
  expert_stat_1_label: string;
  expert_stat_2_value: string;
  expert_stat_2_label: string;
  expert_stat_3_value: string;
  expert_stat_3_label: string;
}

/** One admin-managed card in the homepage bento carousel. */
export interface BentoTile {
  id: string;
  title: string;
  subtitle: string | null;
  /** Background image for the card; a neutral ground is used when absent. */
  image_url: string | null;
  /** Internal route when it starts with '/', otherwise an external URL. */
  link_url: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}

/** The bento tile fields an admin edits. */
export interface BentoTileFormData {
  title: string;
  subtitle: string;
  image_url: string;
  link_url: string;
  sort_order: string;
  is_active: boolean;
}

/** One client review shown on the expert profile page. */
export interface Review {
  id: string;
  name: string;
  country: string | null;
  /** ISO 3166-1 alpha-2, lowercase — drives the flag-icons class. */
  country_code: string | null;
  star_rating: number | null;
  quote: string;
  photo_url: string | null;
  sort_order: number;
  /** Public submissions land as false and need an admin to approve them. */
  is_approved: boolean;
  is_visible: boolean;
  submitted_by: string | null;
  created_at: string;
}

/** The review fields an admin edits (everything except id/created_at). */
export interface ReviewFormData {
  name: string;
  country: string;
  country_code: string;
  star_rating: number;
  quote: string;
  sort_order: string;
  is_approved: boolean;
  is_visible: boolean;
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
