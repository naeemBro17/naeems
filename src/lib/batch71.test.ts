import { afterEach, describe, expect, it } from 'vitest';
import { initAnalytics, isTestMachine } from './analytics';
import {
  DEFAULT_CONCERNS,
  DEFAULT_TIPS,
  LAST_TIP_KEY,
  VIDEO_TITLE_MAX,
  homeGreeting,
  isOn,
  nextTip,
  parseComboCodes,
  parseConcerns,
  parseTips,
  parseVideos,
  pickTip,
  readVideoLink,
  resetVisitTip,
  splitAccent,
  visitTip,
  type SkinTip,
} from './homeContent';
import { navAfterScroll, shopRedirectFor, showsBottomNav } from './bottomNav';
import { categoryPath } from './categoryFilter';
import { readSort } from '../pages/ViewerPage';

describe('tracking guard (Batch 71 Part 9)', () => {
  afterEach(() => {
    delete window.fbq;
    delete window.gtag;
  });

  it('treats localhost, 127.0.0.1, *.local and a test robot as a test machine', () => {
    expect(isTestMachine('localhost', false)).toBe(true);
    expect(isTestMachine('127.0.0.1', false)).toBe(true);
    expect(isTestMachine('naeems-pc.local', false)).toBe(true);
    expect(isTestMachine('LOCALHOST', false)).toBe(true);
    expect(isTestMachine('naeems.com.bd', true)).toBe(true);
  });

  it('lets the real shop track', () => {
    expect(isTestMachine('naeems.com.bd', false)).toBe(false);
    expect(isTestMachine('naeems.vercel.app', false)).toBe(false);
    expect(isTestMachine('localhost.example.com', false)).toBe(false);
  });

  it('is off only for the e2e tests that opt in', () => {
    expect(isTestMachine('localhost', true, true)).toBe(false);
    expect(isTestMachine('localhost', true, false)).toBe(true);
  });

  it('loads nothing on a test machine (jsdom runs on localhost)', () => {
    expect(window.location.hostname).toBe('localhost');
    initAnalytics('123456789', 'G-TEST123');
    expect(window.fbq).toBeUndefined();
    expect(window.gtag).toBeUndefined();
    expect(document.querySelector('script[src*="fbevents"], script[src*="googletagmanager"]')).toBeNull();
  });
});

const tip = (id: string, own = false, active = true): SkinTip => ({ id, text: `Tip ${id}`, accent: '', own, active });

describe('skin tips', () => {
  afterEach(() => {
    resetVisitTip();
    localStorage.clear();
  });

  it('has 40 default tips, the first three Naeem’s own, every orange part inside its text', () => {
    expect(DEFAULT_TIPS).toHaveLength(40);
    expect(DEFAULT_TIPS.slice(0, 3).every((t) => t.own)).toBe(true);
    expect(DEFAULT_TIPS.slice(3).some((t) => t.own)).toBe(false);
    for (const t of DEFAULT_TIPS) {
      expect(t.text.includes(t.accent)).toBe(true);
      expect(t.text.length).toBeLessThanOrEqual(90);
    }
    expect(new Set(DEFAULT_TIPS.map((t) => t.id)).size).toBe(40);
  });

  it('falls back to the defaults on a missing or broken row', () => {
    expect(parseTips(undefined)).toBe(DEFAULT_TIPS);
    expect(parseTips('')).toBe(DEFAULT_TIPS);
    expect(parseTips('{not json')).toBe(DEFAULT_TIPS);
    expect(parseTips('{"a":1}')).toBe(DEFAULT_TIPS);
    expect(parseTips('[{"id":"x","text":"Hello","accent":"ell","own":true,"active":false},{"bad":1}]')).toEqual([
      { id: 'x', text: 'Hello', accent: 'ell', own: true, active: false },
    ]);
  });

  it('splits the orange part, and shows no orange when it is not in the text', () => {
    expect(splitAccent('Wear sunscreen, even indoors.', 'sunscreen')).toEqual({ before: 'Wear ', accent: 'sunscreen', after: ', even indoors.' });
    expect(splitAccent('Wear sunscreen.', 'moisturizer')).toEqual({ before: 'Wear sunscreen.', accent: '', after: '' });
    expect(splitAccent('Wear sunscreen.', '')).toEqual({ before: 'Wear sunscreen.', accent: '', after: '' });
  });

  it('never picks the last tip, skips hidden ones, and weighs Naeem’s own three times', () => {
    const tips = [tip('a', true), tip('b'), tip('c', false, false)];
    for (let r = 0; r < 1; r += 0.05) {
      expect(pickTip(tips, 'a', r)?.id).toBe('b');
    }
    // a (weight 3) and b (weight 1): a covers the first three quarters.
    expect(pickTip(tips, null, 0.7)?.id).toBe('a');
    expect(pickTip(tips, null, 0.8)?.id).toBe('b');
    // The only active tip may repeat; none active gives nothing.
    expect(pickTip([tip('a')], 'a', 0.5)?.id).toBe('a');
    expect(pickTip([tip('a', false, false)], null, 0.5)).toBeNull();
  });

  it('keeps one tip for the visit, remembers it on the phone, and a tap changes it', () => {
    const first = visitTip(DEFAULT_TIPS);
    expect(first).not.toBeNull();
    expect(visitTip(DEFAULT_TIPS)?.id).toBe(first?.id);
    expect(localStorage.getItem(LAST_TIP_KEY)).toBe(first?.id);
    const next = nextTip(DEFAULT_TIPS, first?.id ?? null);
    expect(next?.id).not.toBe(first?.id);
    expect(visitTip(DEFAULT_TIPS)?.id).toBe(next?.id);
    // A new visit never repeats the last one shown.
    resetVisitTip();
    for (let i = 0; i < 20; i += 1) {
      const last = localStorage.getItem(LAST_TIP_KEY);
      resetVisitTip();
      expect(visitTip(DEFAULT_TIPS)?.id).not.toBe(last);
    }
  });
});

describe('Home settings', () => {
  it('reads the switches as "1" only', () => {
    expect(isOn('1')).toBe(true);
    expect(isOn('0')).toBe(false);
    expect(isOn('')).toBe(false);
    expect(isOn(undefined)).toBe(false);
  });

  it('reads concerns with the defaults when missing', () => {
    expect(parseConcerns(undefined)).toBe(DEFAULT_CONCERNS);
    expect(parseConcerns('[{"name":"Acne","line":"Clear","colour":"nope"}]')).toEqual([{ name: 'Acne', line: 'Clear', colour: 'rose' }]);
  });

  it('keeps at most 8 real combo codes, no repeats', () => {
    const codes = ['abcdefgh', 'abcdefgh', 'not a code', 'bcdefghj', 'cdefghjk', 'defghjkm', 'efghjkmn', 'fghjkmnp', 'ghjkmnpq', 'hjkmnpqr', 'jkmnpqrs'];
    expect(parseComboCodes(JSON.stringify(codes))).toEqual(['abcdefgh', 'bcdefghj', 'cdefghjk', 'defghjkm', 'efghjkmn', 'fghjkmnp', 'ghjkmnpq', 'hjkmnpqr']);
    expect(parseComboCodes('broken')).toEqual([]);
  });

  it('accepts watch, youtu.be and Shorts links only', () => {
    expect(readVideoLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({ id: 'dQw4w9WgXcQ', isShort: false });
    expect(readVideoLink('https://youtu.be/dQw4w9WgXcQ')).toEqual({ id: 'dQw4w9WgXcQ', isShort: false });
    expect(readVideoLink('https://youtube.com/shorts/dQw4w9WgXcQ?feature=share')).toEqual({ id: 'dQw4w9WgXcQ', isShort: true });
    expect(readVideoLink('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBeNull();
    expect(readVideoLink('https://vimeo.com/123')).toBeNull();
    expect(readVideoLink('not a link')).toBeNull();
    const long = 'x'.repeat(VIDEO_TITLE_MAX + 10);
    expect(parseVideos(JSON.stringify([{ url: 'https://youtu.be/dQw4w9WgXcQ', title: long }, { url: 'https://vimeo.com/1', title: 'no' }]))).toEqual([
      { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'x'.repeat(VIDEO_TITLE_MAX) },
    ]);
  });

  it('writes the greeting as "Good evening"', () => {
    expect(homeGreeting('Good Evening')).toBe('Good evening');
    expect(homeGreeting('Good Morning')).toBe('Good morning');
  });
});

describe('routes and the bottom bar', () => {
  it('sends an old grid link on / to /shop with the same query', () => {
    expect(shopRedirectFor('?cat=face-care')).toBe('/shop?cat=face-care');
    expect(shopRedirectFor('?brand=cerave&skin=oily')).toBe('/shop?brand=cerave&skin=oily');
    expect(shopRedirectFor('?q=acne&utm_source=fb')).toBe('/shop?q=acne&utm_source=fb');
    expect(shopRedirectFor('')).toBeNull();
    expect(shopRedirectFor('?utm_source=fb&fbclid=1')).toBeNull();
  });

  it('shows the bar on Home, Shop, Search, Brands and a brand page only', () => {
    expect(showsBottomNav('/')).toBe('home');
    expect(showsBottomNav('/shop')).toBe('shop');
    expect(showsBottomNav('/search')).toBe('search');
    expect(showsBottomNav('/brands')).toBe('shop');
    expect(showsBottomNav('/brand/cerave')).toBe('shop');
    for (const path of ['/product/x', '/cart', '/checkout/delivery', '/account', '/orders', '/admin', '/contact']) {
      expect(showsBottomNav(path)).toBeNull();
    }
  });

  it('hides after 24 px down and comes back after 12 px up or at the top', () => {
    let s = { visible: true, anchor: 0 };
    s = navAfterScroll(s, 20);
    expect(s.visible).toBe(true);
    s = navAfterScroll(s, 24);
    expect(s.visible).toBe(false);
    s = navAfterScroll(s, 400);
    s = navAfterScroll(s, 390);
    expect(s.visible).toBe(false);
    s = navAfterScroll(s, 388);
    expect(s.visible).toBe(true);
    s = navAfterScroll({ visible: false, anchor: 5 }, 0);
    expect(s.visible).toBe(true);
  });

  it('builds the category link and reads the sort', () => {
    expect(categoryPath('face-care')).toBe('/shop?cat=face-care');
    expect(categoryPath(null)).toBe('/shop');
    expect(readSort('price-low')).toBe('price-low');
    expect(readSort('junk')).toBe('featured');
    expect(readSort(null)).toBe('featured');
  });
});
