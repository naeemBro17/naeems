import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PRODUCT_DESCRIPTION,
  SHOP_DESCRIPTION,
  SHOP_TITLE,
  comboPreview,
  escapeHtml,
  isComboCode as isComboCodeServer,
  productPreview,
  renderPreviewHtml,
  shopPreview,
} from '../../api/_og';
import {
  COMBO_CODE_ALPHABET,
  addedToastText,
  comboChatMessage,
  comboPath,
  comboTotals,
  isComboCode,
  messengerShareUrl,
  newComboCode,
  unitsToAdd,
  whatsAppShareUrl,
} from './combos';
import { androidChromeIntentUrl, detectInAppBrowser } from './inAppBrowser';
import { COLLAGE_HEIGHT, COLLAGE_WIDTH, collageTiles, fitInside } from './comboCollage';
import { sectionPath } from './adminNav';

const URL_BASE = 'https://naeems-all.vercel.app';
/** Any taka amount or bare price-looking number in a preview. */
const PRICE = /৳|\bTk\b|\b\d[\d,]{2,}\b(?!%)/;

function metaContent(html: string, key: string): string | null {
  const re = new RegExp(`<meta (?:property|name)="${key.replace(/[:]/g, '\\:')}" content="([^"]*)"`);
  return re.exec(html)?.[1] ?? null;
}

describe('Part 1 — link previews', () => {
  it('product: "{name} — NAEEM\'S", the fixed description, the square photo, no price', () => {
    const f = productPreview('Avène Thermal Spring Water 300 ml', 'https://x.supabase.co/a.webp', `${URL_BASE}/product/avene`);
    expect(f.title).toBe("Avène Thermal Spring Water 300 ml | NAEEM'S");
    expect(f.description).toBe('100% authentic. Imported for you.');
    expect(f.description).toBe(PRODUCT_DESCRIPTION);
    expect(f.image).toBe('https://x.supabase.co/a.webp');
    expect([f.imageWidth, f.imageHeight]).toEqual([1200, 1200]);
    expect(f.type).toBe('product');
    const html = renderPreviewHtml(f);
    expect(html).not.toMatch(/৳/);
    expect(metaContent(html, 'og:site_name')).toBe('NAEEM&#39;S');
    expect(metaContent(html, 'og:image:width')).toBe('1200');
    expect(metaContent(html, 'og:image:height')).toBe('1200');
    expect(metaContent(html, 'og:image:type')).toBe('image/webp');
  });

  it('product without a photo falls back to the shop banner (wide)', () => {
    const f = productPreview('Bio Oil', null, `${URL_BASE}/product/bio-oil`);
    expect(f.title).toBe("Bio Oil | NAEEM'S");
    expect(f.image).toBe(`${URL_BASE}/og-shop.jpg`);
    expect([f.imageWidth, f.imageHeight]).toEqual([1200, 630]);
  });

  it('shop: exact title and description, the 1200 × 630 banner', () => {
    const f = shopPreview();
    expect(f.title).toBe("NAEEM'S | 100% Authentic Skincare");
    expect(f.description).toBe(
      'Imported from Australia, USA, Canada, Korea, Japan, India & UK. Cash on delivery all over Bangladesh.'
    );
    expect(f.title).toBe(SHOP_TITLE);
    expect(f.description).toBe(SHOP_DESCRIPTION);
    expect([f.imageWidth, f.imageHeight]).toEqual([1200, 630]);
    expect(f.url).toBe(`${URL_BASE}/`);
  });

  it('combo: "{name} — picked for you by NAEEM\'S", "{n} products, hand-picked by Naeem. 100% authentic."', () => {
    const f = comboPreview("Sadia's glow routine", 3, 'https://x.supabase.co/combos/abc.jpg', `${URL_BASE}/c/abcdefgh`);
    expect(f.title).toBe("Sadia's glow routine, picked for you by NAEEM'S");
    expect(f.description).toBe('3 products, hand-picked by Naeem. 100% authentic.');
    expect([f.imageWidth, f.imageHeight]).toEqual([1200, 630]);
    expect(comboPreview('One', 1, null, '').description).toBe('1 product, hand-picked by Naeem. 100% authentic.');
    expect(comboPreview('One', 1, null, '').image).toBe(`${URL_BASE}/og-shop.jpg`);
  });

  it('no price in any preview (product, shop, combo)', () => {
    for (const f of [
      productPreview('CeraVe Foaming Cleanser 236 ml', 'https://x/a.webp', `${URL_BASE}/product/c`),
      shopPreview(),
      comboPreview('Glow', 4, null, `${URL_BASE}/c/abcdefgh`),
    ]) {
      expect(f.description).not.toMatch(PRICE);
      expect(renderPreviewHtml(f)).not.toMatch(/৳/);
    }
  });

  it('every required tag is there; summary_large_image; text is escaped', () => {
    const html = renderPreviewHtml(comboPreview('Rumi\'s "best" <combo>', 2, 'https://x/a.jpg', `${URL_BASE}/c/abcdefgh`));
    for (const key of ['og:title', 'og:description', 'og:image', 'og:image:width', 'og:image:height', 'og:url', 'og:type', 'og:site_name', 'twitter:card']) {
      expect(metaContent(html, key), key).not.toBeNull();
    }
    expect(metaContent(html, 'twitter:card')).toBe('summary_large_image');
    expect(metaContent(html, 'og:url')).toBe(`${URL_BASE}/c/abcdefgh`);
    expect(html).not.toContain('<combo>');
    expect(html).toContain(escapeHtml('Rumi\'s "best" <combo>'));
  });

  it('index.html (home and every page without its own preview) has the shop tags', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(metaContent(html, 'og:title')).toBe("NAEEM'S | 100% Authentic Skincare");
    expect(metaContent(html, 'og:description')).toBe(
      'Imported from Australia, USA, Canada, Korea, Japan, India &amp; UK. Cash on delivery all over Bangladesh.'
    );
    expect(metaContent(html, 'og:image')).toBe(`${URL_BASE}/og-shop.jpg`);
    expect(metaContent(html, 'og:image:width')).toBe('1200');
    expect(metaContent(html, 'og:image:height')).toBe('630');
    expect(metaContent(html, 'twitter:card')).toBe('summary_large_image');
    expect(html).not.toMatch(/৳/);
  });

  it('vercel.json sends only link-preview robots to the combo preview', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      rewrites: { source: string; destination: string; has?: { value: string }[] }[];
    };
    const combo = config.rewrites.find((r) => r.source === '/c/:code');
    expect(combo?.destination).toBe('/api/combo-og?code=:code');
    expect(combo?.has?.[0].value).toContain('facebookexternalhit');
    // The app's catch-all stays last.
    expect(config.rewrites[config.rewrites.length - 1].source).toBe('/(.*)');
  });
});

describe('Part 3 — combos', () => {
  it('code: 8 characters from the clear alphabet; the server accepts the same shape', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = newComboCode();
      expect(code).toMatch(/^[a-z2-9]{8}$/);
      expect([...code].every((ch) => COMBO_CODE_ALPHABET.includes(ch))).toBe(true);
      expect(isComboCode(code)).toBe(true);
      expect(isComboCodeServer(code)).toBe(true);
    }
    expect(COMBO_CODE_ALPHABET).not.toMatch(/[01ilo]/);
  });

  it('code: skips bytes that would make some letters likelier', () => {
    // 248+ is thrown away (256 % 31 = 8), so 255 never becomes a letter.
    let call = 0;
    const code = newComboCode((n) => {
      call += 1;
      return Uint8Array.from({ length: n }, (_, i) => (call === 1 && i % 2 === 0 ? 255 : 0));
    });
    expect(code).toBe('aaaaaaaa');
  });

  it('isComboCode refuses anything else', () => {
    for (const bad of ['', 'ABCDEFGH', 'abc', 'abcdefghi', 'abcd-fgh', 'abcdefg1', null, undefined]) {
      expect(isComboCode(bad)).toBe(false);
    }
    expect(comboPath('abcdefgh')).toBe('/c/abcdefgh');
  });

  it('total and savings: today\'s prices × quantities; sold-out lines not counted', () => {
    const totals = comboTotals([
      { available: true, price: 2499, retail: 2749, quantity: 1 },
      { available: true, price: 2990, retail: 3050, quantity: 2 },
      { available: false, price: 1599, retail: 1800, quantity: 1 },
      { available: true, price: 500, retail: 500, quantity: 1 },
    ]);
    expect(totals.total).toBe(2499 + 2990 * 2 + 500);
    expect(totals.retailTotal).toBe(2749 + 3050 * 2 + 500);
    expect(totals.savings).toBe(250 + 60 * 2);
    expect(totals.availableCount).toBe(3);
    expect(totals.soldOutCount).toBe(1);
  });

  it('no savings when nothing is on offer; never negative', () => {
    expect(comboTotals([{ available: true, price: 900, retail: 900, quantity: 3 }]).savings).toBe(0);
    expect(comboTotals([{ available: true, price: 900, retail: 800, quantity: 1 }]).savings).toBe(0);
    expect(comboTotals([]).total).toBe(0);
  });

  it('Add all to cart respects the order limit and what is already in the cart', () => {
    expect(unitsToAdd(2, 0, 4)).toBe(2);
    expect(unitsToAdd(3, 2, 4)).toBe(2);
    expect(unitsToAdd(1, 4, 4)).toBe(0);
    expect(unitsToAdd(5, 0, 2)).toBe(2); // "the last 2" in stock
    expect(unitsToAdd(6, 3, Number.POSITIVE_INFINITY)).toBe(6); // wholesaler, keep selling
  });

  it('toast and chat wording', () => {
    expect(addedToastText(3, 1)).toBe('Added 3 items. 1 sold out.');
    expect(addedToastText(1, 0)).toBe('Added 1 item');
    expect(comboChatMessage(" Sadia's glow routine ")).toBe("Hi! About my combo: Sadia's glow routine");
    expect(whatsAppShareUrl('https://naeems-all.vercel.app/c/abcdefgh')).toBe(
      'https://wa.me/?text=https%3A%2F%2Fnaeems-all.vercel.app%2Fc%2Fabcdefgh'
    );
    expect(messengerShareUrl('https://n.app/c/abcdefgh')).toBe('fb-messenger://share/?link=https%3A%2F%2Fn.app%2Fc%2Fabcdefgh');
  });

  it('collage: 1–4 tiles inside the picture, never overlapping; more than 4 → 4', () => {
    for (let n = 1; n <= 6; n += 1) {
      const tiles = collageTiles(n);
      expect(tiles.length).toBe(Math.min(n, 4));
      for (const t of tiles) {
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.x + t.w).toBeLessThanOrEqual(COLLAGE_WIDTH);
        expect(t.y + t.h).toBeLessThanOrEqual(COLLAGE_HEIGHT);
      }
      for (let i = 0; i < tiles.length; i += 1) {
        for (let j = i + 1; j < tiles.length; j += 1) {
          const a = tiles[i];
          const b = tiles[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap).toBe(false);
        }
      }
    }
    expect(collageTiles(0)).toEqual([]);
  });

  it('collage: each photo is shown whole (fitted, never cropped), centred', () => {
    const box = { x: 0, y: 0, w: 400, h: 600 };
    const tall = fitInside(1000, 2000, box);
    expect(tall.w).toBeLessThanOrEqual(400);
    expect(tall.h).toBeLessThanOrEqual(600);
    expect(tall.h / tall.w).toBeCloseTo(2);
    const wide = fitInside(1400, 1400, box, 10);
    expect(wide.w).toBeCloseTo(380);
    expect(wide.y).toBeCloseTo(110);
  });
});

describe('Part 4 — Facebook / Messenger / Instagram in-app browser', () => {
  const samples: [string, string, boolean, string][] = [
    [
      'Facebook Android',
      'Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/484.0.0.53.109;]',
      true,
      'android',
    ],
    [
      'Facebook iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/478.0.0.41.105;FBBV/641035718;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.6;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]',
      true,
      'ios',
    ],
    [
      'Messenger Android',
      'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/468.0.0.40.110;]',
      true,
      'android',
    ],
    [
      'Messenger iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 LightSpeed [FBAN/MessengerLiteForiOS;FBAV/462.0.0.36.106;FBBV/617418283;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/0]',
      true,
      'ios',
    ],
    [
      'Instagram Android',
      'Mozilla/5.0 (Linux; Android 14; 2201117TG Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.70 Mobile Safari/537.36 Instagram 349.0.0.39.106 Android (34/14; 440dpi; 1080x2209; Xiaomi; 2201117TG; spes; qcom; en_US; 641123490)',
      true,
      'android',
    ],
    [
      'Instagram iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 346.0.0.20.88 (iPhone14,7; iOS 17_6_1; en_US; en; scale=3.00; 1170x2532; 637478546)',
      true,
      'ios',
    ],
    [
      'Chrome Android',
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
      false,
      'android',
    ],
    [
      'Safari iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
      false,
      'ios',
    ],
    [
      'Chrome desktop',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      false,
      'other',
    ],
  ];

  it.each(samples)('%s', (_name, ua, inApp, platform) => {
    expect(detectInAppBrowser(ua)).toEqual({ inApp, platform });
  });

  it('Android intent link: the same address in Chrome, with the normal address as fallback', () => {
    const href = 'https://naeems-all.vercel.app/c/abcdefgh?ref=fb#top';
    const intent = androidChromeIntentUrl(href);
    expect(intent).toBe(
      'intent://naeems-all.vercel.app/c/abcdefgh?ref=fb#Intent;scheme=https;package=com.android.chrome;' +
        `S.browser_fallback_url=${encodeURIComponent(href)};end`
    );
    expect(androidChromeIntentUrl('http://localhost:4173/')).toBe(
      `intent://localhost:4173/#Intent;scheme=http;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent('http://localhost:4173/')};end`
    );
  });
});

describe('Part 2 — real links', () => {
  it('every admin section has its own address', () => {
    expect(sectionPath('home')).toBe('/admin');
    expect(sectionPath('combos')).toBe('/admin?tab=combos');
    expect(sectionPath('orders', { ostatus: 'pending' })).toBe('/admin?tab=orders&ostatus=pending');
  });
});
