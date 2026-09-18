export interface Category {
  id: string;
  name: string;
  slug: string;
  /** Optional photo for the homepage Browse circle; null (or absent/undefined
   *  on rows cached before migration-015) falls back to the curated/generic
   *  SVG icon exactly as before this column existed. */
  image_url: string | null;
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
  /**
   * Admin-only tags for a future smart filter; never shown to customers.
   * Absent (undefined) on rows cached before migration-012.
   */
  skin_types: string[] | null;
  skin_conditions: string[] | null;
  /**
   * Optional Region/Size label for the product itself — shown as plain text
   * on the detail page when the product has no real variant rows, or
   * becomes the label of the first selectable option once it does (see
   * ProductVariant/VariantOption). Absent (undefined) on rows cached before
   * migration-016.
   */
  region: string | null;
  size: string | null;
  /**
   * Set only on a product created by the "Combine into Variants" flow —
   * points at whichever originally-selected product supplied this
   * product's shared content and base price/stock (the one that became
   * option zero, not a separate variant row). Null for every ordinary
   * product. Used to reactivate that original when this combined product
   * is deleted. Absent (undefined) on rows cached before migration-017.
   */
  combined_from_product_id: string | null;
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
  region: string;
  size: string;
  is_featured: boolean;
  is_active: boolean;
  skin_types: string[];
  skin_conditions: string[];
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
  /** Stable id, generated client-side — doubles as the slide's image storage
   *  path (banners/{id}.webp) so replacing the photo overwrites in place
   *  rather than leaving the old upload orphaned in Storage. */
  id: string;
  eyebrow_text: string;
  /** Headline — clamped to 2 lines in the banner. */
  title: string;
  cta_button_text: string;
  cta_action: BannerCtaAction;
  /** Destination for cta_action 'open_url'; ignored otherwise. */
  cta_url: string;
  /** Hex background reserved for future per-slide custom grounds. */
  background_color: string;
  /** Optional photo behind the slide's text; null shows the plain default
   *  background exactly as before this field existed. */
  image_url: string | null;
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

  /* --- Inline admin editing (Session 5) --- */
  /** Second line of the bento expert card ("Skincare Expert"). */
  bento_expert_subtitle: string;
  /** JSON array of product ids: slide order of the swipeable left tile. */
  bento_left_order: string;
  /** JSON array of product ids: faces of the auto-flip right-top tile. */
  bento_right_top_order: string;
  /** JSON array of category ids: visible Browse circles, left to right. */
  browse_categories_order: string;

  /* --- Bento & section reorder (Session 6) --- */
  /** JSON array of bento tile ids: which grid position each tile occupies. */
  bento_tile_order: string;
  /** JSON array of homepage section ids, top to bottom; 'products' is always last. */
  homepage_section_order: string;

  /* --- Cart & checkout (Session 11) --- */
  /** Bare phone number or full wa.me link the checkout flow sends orders to. */
  shop_whatsapp_number: string;
}

/**
 * One Region+Size combination of a product, with its own prices and stock.
 * Read from product_variants_view: wholesale_price is present only for an
 * approved wholesaler or admin, NULL otherwise, exactly like Product.
 */
export interface ProductVariant {
  id: string;
  product_id: string;
  region: string;
  size: string;
  retail_price: number;
  offer_price: number | null;
  wholesale_price: number | null;
  has_wholesale: boolean;
  in_stock: boolean;
  /** Tracked count; null means "not tracking exact quantity" — same
   *  convention as Product.stock_quantity. When set, it overrides in_stock
   *  (see isVariantInStock). Absent (undefined) on rows cached before
   *  migration-016. */
  stock_quantity: number | null;
  /** Optional photo replacing the product's own cover image wherever this
   *  variant is selected; null falls back to the product's image exactly as
   *  before this field existed. */
  image_url: string | null;
  /** Optional short text, same purpose as Product.note but variant-specific
   *  (e.g. "USA batch, slightly different box"). Falls back to the
   *  product's own note when null. */
  note: string | null;
  /** Set only on a variant row created by the "Combine into Variants" flow
   *  — points at the original standalone product it was copied from. Null
   *  for every hand-added variant. Used to reactivate that original when
   *  the parent product is deleted. Absent (undefined) on rows cached
   *  before migration-017. */
  source_product_id: string | null;
  sort_order: number;
  created_at: string;
}

/** The variant fields the admin edits in the inline sub-form. */
export interface VariantFormData {
  region: string;
  size: string;
  retail_price: string;
  offer_price: string;
  wholesale_price: string;
  in_stock: boolean;
  stock_quantity: string;
  image_url: string | null;
  note: string;
}

/**
 * One selectable option on a product's detail page: either a real
 * product_variants row, or the product's own base data synthesized into the
 * same shape (isBase: true) so it can sit alongside real variants as the
 * first option — see src/lib/variants.ts variantOptionsFor(). The product's
 * own row is never duplicated as a separate database record; this is a
 * read-time projection only.
 */
export interface VariantOption extends ProductVariant {
  isBase: boolean;
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

export type PromoDiscountType = 'fixed' | 'percent';

/** One admin-managed promo code (migration-014). Customers redeem these on
 *  the checkout Order Summary screen; usage is capped by max_uses. */
export interface PromoCode {
  id: string;
  code: string;
  discount_amount: number;
  discount_type: PromoDiscountType;
  /** Total redemptions ever allowed; null = unlimited. */
  max_uses: number | null;
  times_used: number;
  expires_at: string | null;
  active: boolean;
  created_at: string;
}

/** The promo code fields an admin edits. */
export interface PromoCodeFormData {
  code: string;
  discount_amount: string;
  discount_type: PromoDiscountType;
  /** Blank = unlimited; the "Add code" form defaults this to '50'. */
  max_uses: string;
  /** datetime-local input value, or '' for no expiry. */
  expires_at: string;
  active: boolean;
}
