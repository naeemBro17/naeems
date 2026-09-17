import type { BannerSlide, BannerCtaAction } from '../types';

/** The app_settings key the slide array is stored under. */
export const BANNER_SLIDES_KEY = 'banner_slides';

const CTA_ACTIONS: BannerCtaAction[] = [
  'scroll_to_products',
  'open_contact',
  'open_url',
];

export const CTA_ACTION_LABELS: Record<BannerCtaAction, string> = {
  scroll_to_products: 'Scroll to products',
  open_contact: 'Open contact page',
  open_url: 'Open a link',
};

/** A blank slide for the admin "add new" form. The id is generated once
 *  here and kept for the slide's lifetime — see BannerSlide's doc comment. */
export function emptyBannerSlide(): BannerSlide {
  return {
    id: crypto.randomUUID(),
    eyebrow_text: '',
    title: '',
    cta_button_text: 'Shop Now →',
    cta_action: 'scroll_to_products',
    cta_url: '',
    background_color: '#FFF3EE',
    image_url: null,
    is_active: true,
  };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asCtaAction(value: unknown): BannerCtaAction {
  return CTA_ACTIONS.find((a) => a === value) ?? 'scroll_to_products';
}

/**
 * Parse the JSON array stored in app_settings. Every field is validated
 * individually so a hand-edited or partial row degrades into a usable slide
 * instead of throwing and taking the whole homepage down.
 */
export function parseBannerSlides(raw: string): BannerSlide[] {
  if (raw.trim() === '') return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];

  return decoded.filter(isRecord).map((entry) => ({
    // Older saved slides predate this field — give them a fresh id so they
    // at least have one from here on; it only becomes their real image
    // path once an admin uploads a photo and the slide is saved again.
    id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : crypto.randomUUID(),
    eyebrow_text: asString(entry.eyebrow_text, ''),
    title: asString(entry.title, ''),
    cta_button_text: asString(entry.cta_button_text, 'Shop Now →'),
    cta_action: asCtaAction(entry.cta_action),
    cta_url: asString(entry.cta_url, ''),
    background_color: asString(entry.background_color, '#FFF3EE'),
    image_url: typeof entry.image_url === 'string' && entry.image_url !== '' ? entry.image_url : null,
    is_active: entry.is_active !== false,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Serialize slides back into the app_settings text column. */
export function serializeBannerSlides(slides: BannerSlide[]): string {
  return JSON.stringify(slides);
}
