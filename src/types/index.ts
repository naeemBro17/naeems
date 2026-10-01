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
  /**
   * The brand this product belongs to (Batch 26). The database keeps
   * `brand` (the name) in step with it. Absent (undefined) on rows cached
   * before migration-032.
   */
  brand_id?: string | null;
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
  /** Small ~400px WebP "card" version of each image_urls entry, same index
   *  order. Absent/shorter than image_urls for any product not yet through
   *  the thumbnail backfill (migration-024 / Batch 19) — use cardImage()
   *  from lib/productImages, never this field directly, so that fallback is
   *  never forgotten at a call site. */
  image_urls_thumb: string[] | null;
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

export type UserRole = 'customer' | 'wholesaler' | 'admin' | 'moderator';
export type ProfileStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

/** The current user's profile row (role + approval status). Customer-only
 *  fields (full_name, photo_url, division/district/thana/address_line) are
 *  null for admin/wholesaler rows, which don't use them. */
export interface Profile {
  id: string;
  role: UserRole;
  status: ProfileStatus;
  business_name: string | null;
  phone: string | null;
  created_at: string;
  approved_at: string | null;
  full_name: string | null;
  photo_url: string | null;
  division: string | null;
  district: string | null;
  thana: string | null;
  address_line: string | null;
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

  /* --- Orders (Batch 18) --- */
  /** Taka fee for each delivery zone — the authoritative copy place_order()
   *  reads lives in these same app_settings rows; DELIVERY_ZONES in
   *  features/checkout/types.ts is only the pre-login/offline fallback. */
  delivery_fee_inside_dhaka: string;
  delivery_fee_outside_dhaka: string;
  /** bKash number customers send advance payment to. Blank hides the bKash
   *  payment option entirely at checkout. */
  shop_bkash_number: string;

  /* --- Ad tracking (Batch 19) --- */
  /** Facebook Pixel ID. Blank = Pixel never loads, no errors. */
  fb_pixel_id: string;
  /** Google Analytics 4 Measurement ID (G-XXXXXXX). Blank = GA never loads. */
  ga_measurement_id: string;

  /* --- Admin (Batch 25) --- */
  /** At or below this many pieces a product counts as "low stock" in the
   *  admin (red stock dot, Low stock filter, Home). Default 5. */
  low_stock_threshold: string;

  /* --- Editable texts (Batch 24 Part 7) — blank means "use the default" --- */
  text_checkout_signin_title: string;
  text_checkout_signin_message: string;
  /** Product page trust boxes (Batch 27). */
  text_trust_authentic: string;
  text_trust_cod: string;
  text_trust_delivery: string;
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

/* ============================================================
   Orders (Batch 18)
   ============================================================ */

export type OrderPaymentMethod = 'cod' | 'bkash' | 'cash' | 'due';
export type OrderPaymentStatus = 'unpaid' | 'pending_verification' | 'paid';
export type OrderStatus = 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';

/** Where an order came from. 'web' is the only source the checkout flow
 *  itself ever writes; every other value is chosen by hand in the admin
 *  "New order" form (Batch 22) for an order Naeem typed in himself. */
export type OrderSource = 'web' | 'facebook' | 'whatsapp' | 'phone' | 'shop' | 'family' | 'other';

/** Why a line's price was cut below its real (list) price, or an order-level
 *  discount was given — chosen from a fixed chip list in the manual order
 *  form (Batch 22); never freeform, so the monthly summary can be trusted. */
export type DiscountReason = 'family' | 'gift' | 'free_sample' | 'personal_use' | 'promotion' | 'other';

/** One saved order. Address/customer fields are a snapshot taken at order
 *  time (place_order() / admin_create_order()) — a later profile edit never
 *  changes a past order. */
export interface Order {
  id: string;
  order_number: string;
  /** The online account this order is attached to, if any. NULL for most
   *  manual orders (Batch 22) — see CLAUDE.md's privacy rule: a manual
   *  order is only ever linked to an account Naeem explicitly picked
   *  himself, never inferred just because a typed phone number matched
   *  one, since phone numbers aren't verified. Always set for a real
   *  website order (place_order() requires a signed-in customer). */
  customer_id: string | null;
  customer_name: string;
  customer_phone: string;
  division: string;
  district: string;
  thana: string;
  address_line: string;
  /** 'hand_delivered' (Batch 22) is admin-only — "No delivery (hand delivered)",
   *  always ৳0, website checkout never offers it. */
  delivery_zone: 'inside_dhaka' | 'outside_dhaka' | 'hand_delivered';
  delivery_fee: number;
  subtotal: number;
  /** Flat ৳ discount off the whole order — a promo code's discount for a
   *  website order, or a manual flat discount Naeem typed in (Batch 22),
   *  never both on the same order. */
  discount: number;
  /** Why the order-level discount was given (Batch 22) — null for a promo
   *  code discount or when there's no order-level discount at all. */
  discount_reason: DiscountReason | null;
  discount_note: string | null;
  promo_code: string | null;
  /** Sum of every line's real list price × quantity — what this order would
   *  have cost at full price with no discounts (Batch 22). Equals subtotal
   *  for every order with no discounted/free lines, which is every website
   *  order and most manual ones. */
  list_value: number;
  /** Sum of list price × quantity for lines given away entirely free
   *  (Batch 22) — 0 unless a manual order line was marked "Free". */
  free_value: number;
  total: number;
  payment_method: OrderPaymentMethod;
  bkash_trx_id: string | null;
  bkash_sender: string | null;
  payment_status: OrderPaymentStatus;
  status: OrderStatus;
  source: OrderSource;
  tracking_number: string | null;
  customer_note: string | null;
  admin_note: string | null;
  /** Steadfast Courier booking (Batch 20) — all null until "Send to
   *  Steadfast" is used; see supabase/functions/steadfast. */
  steadfast_consignment_id: string | null;
  steadfast_tracking_code: string | null;
  /** Steadfast's own real per-parcel tracking page (consignment.tracking_link,
   *  confirmed from their API guide — migration-026/Batch 20 Part 2). Null on
   *  any order booked before this column existed; the UI falls back to the
   *  generic steadfast.com.bd/tracking page for those. */
  steadfast_tracking_link: string | null;
  /** Steadfast's own raw status text (e.g. "in_review", "delivered") — shown
   *  as-is to admin, never used to drive UI logic beyond that. */
  steadfast_status: string | null;
  /** When steadfast_status last changed (Batch 24, migration-030) — shown
   *  to the customer as "last update". Null before the first courier update
   *  or before migration-030 is run. */
  steadfast_status_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One line item of an order — also a snapshot (product_name/variant_label/
 *  unit_price as they were at order time), even if the product changes or
 *  is deleted afterwards. product_id/variant_id go null (not the row) if
 *  the underlying catalog row is later deleted — see migration-021. */
export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string | null;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  image_url: string | null;
  /** The product/variant's real price at order time (Batch 22) — equal to
   *  unit_price unless Naeem sold this line below (or above) its list price. */
  list_price: number;
  unit_price: number;
  quantity: number;
  line_total: number;
  /** Why unit_price is below list_price (Batch 22) — null when they're equal. */
  reason: DiscountReason | null;
  reason_note: string | null;
}

/** One row of an order's status timeline. */
export interface OrderStatusHistoryRow {
  id: string;
  order_id: string;
  old_status: OrderStatus | null;
  new_status: OrderStatus;
  changed_by: string | null;
  /** Who made the change, by username (Batch 24): a staff username,
   *  'naeem' for the Super Admin, 'customer', or 'system' for the
   *  automatic Steadfast refresh. Null only before migration-030. */
  changed_by_username: string | null;
  changed_at: string;
  note: string | null;
}

/** An order plus its items and timeline, as the detail screens need it. */
export interface OrderWithDetails extends Order {
  items: OrderItem[];
  history: OrderStatusHistoryRow[];
}

/* ============================================================
   Admin team (Batch 24)
   ============================================================ */

/** Everything a moderator can be allowed to do. The Super Admin can always
 *  do all of it and more; the database enforces these (staff_can()). */
export type StaffPermission =
  | 'view_orders'
  | 'change_order_status'
  | 'create_orders'
  | 'book_steadfast'
  | 'edit_products'
  | 'edit_categories'
  | 'view_customers'
  | 'delete_early_orders'
  | 'view_wholesalers'
  | 'see_sales'
  | 'edit_brands'
  | 'edit_customer_notes';

/** The signed-in staff member's own row (Super Admin or moderator). */
export interface StaffMember {
  id: string;
  username: string;
  full_name: string;
  phone: string;
  permissions: StaffPermission[];
  is_disabled: boolean;
}

/** One moderator on the Team page. */
export interface TeamMember extends StaffMember {
  created_at: string;
  last_login: string | null;
  /** Batch 25: the role their permissions come from (null = their own
   *  Batch 24 switches). */
  role_id: string | null;
  role_name: string | null;
}

/** A staff role on Team → Roles (Batch 25 Part 6). */
export interface StaffRole {
  id: string;
  name: string;
  permissions: StaffPermission[];
  member_count: number;
  created_at: string;
}

/** One Activity Log row. */
export interface ActivityLogEntry {
  id: number;
  created_at: string;
  actor_username: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_label: string | null;
  summary: string;
  details: Record<string, unknown>;
}

/* ============================================================
   Brands (Batch 26)
   ============================================================ */

/** One brand: its page at /brand/<slug>, its logo card on Home. */
export interface Brand {
  id: string;
  name: string;
  slug: string;
  /** Normal logo (a trimmed, transparent WebP). Null = the name as text. */
  logo_url: string | null;
  /** Optional white logo for dark mode. */
  logo_dark_url: string | null;
  banner_image_url: string | null;
  /** Uploaded MP4/WebM: plays muted, looping, inline on the brand page. */
  banner_video_url: string | null;
  /** Second choice to an uploaded video. */
  banner_youtube_url: string | null;
  show_on_home: boolean;
  display_order: number;
  updated_at: string;
  updated_by: string | null;
}
