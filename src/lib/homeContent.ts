// Batch 71: what the new Home shows that Naeem edits in Admin → Banner,
// Expert page, Texts → HOME PAGE. Every list lives in one app_settings row
// as JSON (no migration); a missing or broken row falls back to the
// defaults below, so the Home never breaks on bad data.
import { extractYouTubeId } from './youtube';
import { isComboCode } from './combos';

/* ---------------------------------------------------------------- tips */

export interface SkinTip {
  id: string;
  text: string;
  /** The part of `text` shown in orange (must be inside `text`). */
  accent: string;
  /** Naeem's own line ("NAEEM'S RULE"); three times as likely. */
  own: boolean;
  active: boolean;
}

export const TIP_TEXT_MAX = 90;
export const LAST_TIP_KEY = 'naeems.lastTip';

export const DEFAULT_TIPS: SkinTip[] = [
  { id: 'csm', text: 'CSM first. Cleanser, Sunscreen, Moisturizer.', accent: 'Cleanser, Sunscreen, Moisturizer.', own: true, active: true },
  { id: 'cheap', text: "Your skin is expensive. Don't put cheap skincare on it.", accent: 'cheap skincare', own: true, active: true },
  { id: 'hard-way', text: 'Always choose the hard way to make skin soft.', accent: 'hard way', own: true, active: true },
  { id: 'indoors', text: 'Wear sunscreen, even indoors.', accent: 'sunscreen', own: false, active: true },
  { id: 'oily-moist', text: 'Oily skin still needs moisturizer.', accent: 'moisturizer', own: false, active: true },
  { id: 'time', text: 'Give your skin time to adjust.', accent: 'time', own: false, active: true },
  { id: 'barrier', text: 'Fix your skin barrier before you add actives.', accent: 'skin barrier', own: false, active: true },
  { id: 'one-new', text: 'Add one new product at a time.', accent: 'one', own: false, active: true },
  { id: 'patch', text: 'Patch test before you trust a new product.', accent: 'Patch test', own: false, active: true },
  { id: 'reapply', text: 'Reapply sunscreen every two to three hours outside.', accent: 'Reapply', own: false, active: true },
  { id: 'two-fingers', text: 'Use two finger lengths of sunscreen for face and neck.', accent: 'two finger lengths', own: false, active: true },
  { id: 'night-retinol', text: 'Retinol belongs to the night, not the day.', accent: 'night', own: false, active: true },
  { id: 'gentle', text: 'Gentle cleansers keep your skin calm.', accent: 'Gentle', own: false, active: true },
  { id: 'no-scrub', text: 'Scrubbing harder does not clean deeper.', accent: 'harder', own: false, active: true },
  { id: 'damp', text: 'Apply moisturizer on slightly damp skin.', accent: 'damp skin', own: false, active: true },
  { id: 'neck', text: 'Your neck ages too. Take care of it.', accent: 'neck', own: false, active: true },
  { id: 'consistency', text: 'Consistency beats an expensive routine.', accent: 'Consistency', own: false, active: true },
  { id: 'pillow', text: 'Change your pillow cover every week.', accent: 'pillow cover', own: false, active: true },
  { id: 'water', text: 'Drink water, but moisturize your skin too.', accent: 'moisturize', own: false, active: true },
  { id: 'pick', text: 'Picking pimples leaves marks that stay longer.', accent: 'marks', own: false, active: true },
  { id: 'cloudy', text: 'Cloudy days still have UV.', accent: 'UV', own: false, active: true },
  { id: 'vit-c', text: 'Vitamin C in the morning, sunscreen on top.', accent: 'Vitamin C', own: false, active: true },
  { id: 'less', text: 'Less is more when your skin is irritated.', accent: 'Less is more', own: false, active: true },
  { id: 'lips', text: 'Your lips need sunscreen as well.', accent: 'lips', own: false, active: true },
  { id: 'hands', text: 'Hands show age early. Moisturize them.', accent: 'Hands', own: false, active: true },
  { id: 'hot-water', text: 'Hot water dries your skin. Use lukewarm.', accent: 'lukewarm', own: false, active: true },
  { id: 'sleep', text: 'Good sleep is the cheapest skincare.', accent: 'sleep', own: false, active: true },
  { id: 'labels', text: 'Read the label, not the advertisement.', accent: 'label', own: false, active: true },
  { id: 'expiry', text: 'Check the expiry date before you apply.', accent: 'expiry date', own: false, active: true },
  { id: 'phone', text: 'Clean your phone screen. It touches your face.', accent: 'phone screen', own: false, active: true },
  { id: 'double', text: 'Double cleanse at night when you wear sunscreen.', accent: 'Double cleanse', own: false, active: true },
  { id: 'patience', text: 'Real results take six to eight weeks.', accent: 'six to eight weeks', own: false, active: true },
  { id: 'mix', text: 'Do not mix every active in one night.', accent: 'every active', own: false, active: true },
  { id: 'sensitive', text: 'Sensitive skin loves fewer ingredients.', accent: 'fewer ingredients', own: false, active: true },
  { id: 'towel', text: 'Pat your face dry. Do not rub.', accent: 'Pat', own: false, active: true },
  { id: 'authentic', text: 'Authentic products protect your skin and your money.', accent: 'Authentic', own: false, active: true },
  { id: 'eye', text: 'Be gentle around your eyes. The skin is thinner.', accent: 'gentle', own: false, active: true },
  { id: 'routine', text: 'A simple routine you follow beats a perfect one you skip.', accent: 'simple routine', own: false, active: true },
  { id: 'season', text: 'Change your moisturizer when the season changes.', accent: 'season', own: false, active: true },
  { id: 'ask', text: 'Not sure what suits you? Ask before you buy.', accent: 'Ask', own: false, active: true },
];

function parseJsonArray(raw: string | null | undefined): unknown[] | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The saved tips; the defaults when the row is missing or broken. */
export function parseTips(raw: string | null | undefined): SkinTip[] {
  const list = parseJsonArray(raw);
  if (list === null) return DEFAULT_TIPS;
  const tips: SkinTip[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string') continue;
    tips.push({
      id: item.id,
      text: item.text,
      accent: typeof item.accent === 'string' ? item.accent : '',
      own: item.own === true,
      active: item.active !== false,
    });
  }
  return tips;
}

/** The tip text split around its orange part (no orange when not found). */
export function splitAccent(text: string, accent: string): { before: string; accent: string; after: string } {
  const at = accent === '' ? -1 : text.indexOf(accent);
  if (at < 0) return { before: text, accent: '', after: '' };
  return { before: text.slice(0, at), accent, after: text.slice(at + accent.length) };
}

/**
 * One active tip at random, never `lastId` (unless it is the only one).
 * Naeem's own tips weigh 3, the others 1. `random` is 0..1.
 */
export function pickTip(tips: readonly SkinTip[], lastId: string | null, random: number = Math.random()): SkinTip | null {
  const active = tips.filter((t) => t.active && t.text.trim() !== '');
  if (active.length === 0) return null;
  const pool = active.length > 1 ? active.filter((t) => t.id !== lastId) : active;
  const weight = (t: SkinTip) => (t.own ? 3 : 1);
  const total = pool.reduce((sum, t) => sum + weight(t), 0);
  let at = Math.min(Math.max(random, 0), 0.999999) * total;
  for (const tip of pool) {
    at -= weight(tip);
    if (at < 0) return tip;
  }
  return pool[pool.length - 1];
}

export function readLastTip(): string | null {
  try {
    return localStorage.getItem(LAST_TIP_KEY);
  } catch {
    return null;
  }
}

export function writeLastTip(id: string): void {
  try {
    localStorage.setItem(LAST_TIP_KEY, id);
  } catch {
    // Private mode: the next visit may repeat it, nothing else.
  }
}

/** The tip of this visit (one page load of the app): returning to Home
 *  shows the same one. A tap replaces it for the rest of the visit. */
let visitTipId: string | null = null;
/** The last tip the previous visit showed, read once per visit (so a
 *  re-pick in this visit still avoids it). */
let previousVisitTip: string | null | undefined;

export function visitTip(tips: readonly SkinTip[]): SkinTip | null {
  const kept = visitTipId === null ? undefined : tips.find((t) => t.id === visitTipId && t.active);
  if (kept) return kept;
  if (previousVisitTip === undefined) previousVisitTip = readLastTip();
  const tip = pickTip(tips, visitTipId ?? previousVisitTip);
  if (tip) {
    visitTipId = tip.id;
    writeLastTip(tip.id);
  }
  return tip;
}

export function nextTip(tips: readonly SkinTip[], currentId: string | null): SkinTip | null {
  const tip = pickTip(tips, currentId);
  if (tip) {
    visitTipId = tip.id;
    writeLastTip(tip.id);
  }
  return tip;
}

/** Tests only: forget this visit's tip (a new page load). */
export function resetVisitTip(): void {
  visitTipId = null;
  previousVisitTip = undefined;
}

/* ------------------------------------------------------------ switches */

export function isOn(raw: string | null | undefined): boolean {
  return (raw ?? '').trim() === '1';
}

/* ------------------------------------------------------------ concerns */

export const CONCERN_NAME_MAX = 24;
export const CONCERN_LINE_MAX = 28;

export type ConcernColour = 'rose' | 'sand' | 'lilac' | 'sage' | 'sky';

export const CONCERN_COLOURS: Record<ConcernColour, { bg: string; ink: string; label: string }> = {
  rose: { bg: '#FBE9E7', ink: '#B4442F', label: 'Rose' },
  sand: { bg: '#F6EEDF', ink: '#8A6A2E', label: 'Sand' },
  lilac: { bg: '#ECE8F7', ink: '#5B4A9C', label: 'Lilac' },
  sage: { bg: '#E7F1EC', ink: '#2F6B4E', label: 'Sage' },
  sky: { bg: '#E6EEF7', ink: '#2E5A86', label: 'Sky' },
};

export interface HomeConcern {
  name: string;
  line: string;
  colour: ConcernColour;
}

export const DEFAULT_CONCERNS: HomeConcern[] = [
  { name: 'Acne', line: 'Clear and calm', colour: 'rose' },
  { name: 'Hyperpigmentation', line: 'Even tone', colour: 'sand' },
  { name: 'Anti aging', line: 'Firm and smooth', colour: 'lilac' },
  { name: 'Sensitive', line: 'Soothe and protect', colour: 'sage' },
  { name: 'Dehydrated', line: 'Plump and bouncy', colour: 'sky' },
];

function isColour(value: unknown): value is ConcernColour {
  return typeof value === 'string' && value in CONCERN_COLOURS;
}

export function parseConcerns(raw: string | null | undefined): HomeConcern[] {
  const list = parseJsonArray(raw);
  if (list === null) return DEFAULT_CONCERNS;
  const out: HomeConcern[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.name !== 'string' || item.name.trim() === '') continue;
    out.push({
      name: item.name.slice(0, CONCERN_NAME_MAX),
      line: typeof item.line === 'string' ? item.line.slice(0, CONCERN_LINE_MAX) : '',
      colour: isColour(item.colour) ? item.colour : 'rose',
    });
  }
  return out;
}

/* -------------------------------------------------------------- combos */

export const HOME_COMBOS_MAX = 8;

export function parseComboCodes(raw: string | null | undefined): string[] {
  const list = parseJsonArray(raw);
  if (list === null) return [];
  const codes = list.filter((v): v is string => typeof v === 'string' && isComboCode(v));
  return Array.from(new Set(codes)).slice(0, HOME_COMBOS_MAX);
}

/* -------------------------------------------------------------- videos */

export const VIDEO_TITLE_MAX = 70;
export const VIDEO_LINK_ERROR = 'Paste a YouTube or YouTube Shorts link.';

export interface HomeVideo {
  url: string;
  title: string;
}

export interface VideoLink {
  id: string;
  isShort: boolean;
}

/** A watch, youtu.be or Shorts link; null for anything else. */
export function readVideoLink(rawUrl: string): VideoLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const isShort = host === 'youtube.com' && url.pathname.startsWith('/shorts/');
  const accepted = host === 'youtu.be' || (host === 'youtube.com' && (url.pathname === '/watch' || isShort));
  if (!accepted) return null;
  const id = extractYouTubeId(rawUrl);
  return id ? { id, isShort } : null;
}

export function parseVideos(raw: string | null | undefined): HomeVideo[] {
  const list = parseJsonArray(raw);
  if (list === null) return [];
  const out: HomeVideo[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.url !== 'string' || readVideoLink(item.url) === null) continue;
    out.push({ url: item.url.trim(), title: typeof item.title === 'string' ? item.title.slice(0, VIDEO_TITLE_MAX) : '' });
  }
  return out;
}

/* ------------------------------------------------------------ greeting */

/** "Good Morning" (Batch 68's greetingFor) -> "Good morning". */
export function homeGreeting(text: string): string {
  const [first, ...rest] = text.split(' ');
  return [first, ...rest.map((w) => w.toLowerCase())].join(' ');
}
