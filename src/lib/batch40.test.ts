import { describe, expect, it } from 'vitest';
import { productCardPath, smallCopyPath, uniqueImagePath } from './supabase';
import { isCardCopy, isSmallCopy, productNeedsCardCopies, smallImageFor } from './productImages';
import { isCompressedVideoUrl, videoBitrate, videoOutputSize, VIDEO_MAX_BYTES, VIDEO_TRIES } from './videoCompress';
import { judgeAnswer } from './backendStatus';
import { fallbackMessengerUrl, fallbackWhatsAppUrl } from './shopFallback';
import type { Product, ProductVariant } from '../types';

const base = 'https://x.supabase.co/storage/v1/object/public/product-images';

describe('Batch 40 Part 2: every upload has its own name', () => {
  it('a one-photo field stores each upload next to the old one, under a new name', () => {
    const a = uniqueImagePath('banners/slide-1.webp');
    const b = uniqueImagePath('banners/slide-1.webp');
    expect(a).toMatch(/^banners\/slide-1-[0-9a-z-]{8}\.webp$/);
    expect(a).not.toBe(b);
    expect(uniqueImagePath('expert-photo.webp')).toMatch(/^expert-photo-[0-9a-z-]{8}\.webp$/);
  });

  it("a photo's card copy sits in card/ with the photo's own (unique) name", () => {
    expect(productCardPath('products/abc.webp')).toBe('products/card/abc.webp');
    expect(smallCopyPath('categories/c-1234.webp', 'thumb')).toBe('categories/thumb/c-1234.webp');
    expect(productCardPath('x.webp')).toBe('card/x.webp');
  });
});

describe('Batch 40 Part 2: card copies', () => {
  const full = `${base}/products/a.webp`;
  const oldThumb = `${base}/products/thumb/a.webp?v=1`;
  const card = `${base}/products/card/a.webp`;

  it('an old thumb/ copy still counts as a small copy, but only card/ is the new 480 px one', () => {
    expect(isSmallCopy(full, oldThumb)).toBe(true);
    expect(isSmallCopy(full, card)).toBe(true);
    expect(isCardCopy(full, card)).toBe(true);
    expect(isCardCopy(full, oldThumb)).toBe(false);
    expect(isCardCopy(full, full)).toBe(false);
    expect(isCardCopy(full, null)).toBe(false);
  });

  it('a product needs card copies until every photo has one', () => {
    const product = { image_urls: [full, `${base}/products/b.webp`], image_url: full } as unknown as Product;
    expect(productNeedsCardCopies({ ...product, image_urls_thumb: [oldThumb, oldThumb] } as Product)).toBe(true);
    expect(productNeedsCardCopies({ ...product, image_urls_thumb: [card] } as Product)).toBe(true);
    expect(
      productNeedsCardCopies({ ...product, image_urls_thumb: [card, `${base}/products/card/b.webp`] } as Product)
    ).toBe(false);
  });

  it('small pictures use the small copy of the photo shown, else the photo itself', () => {
    const variantFull = `${base}/variants/v-1.webp`;
    const variantCard = `${base}/variants/card/v-1.webp`;
    const product = { image_urls: [full], image_url: full, image_urls_thumb: [card] } as unknown as Product;
    const variant = { image_url: variantFull, image_url_thumb: variantCard } as unknown as ProductVariant;
    expect(smallImageFor(full, product)).toBe(card);
    expect(smallImageFor(variantFull, product, [variant])).toBe(variantCard);
    expect(smallImageFor(variantFull, product, [{ ...variant, image_url_thumb: null }])).toBe(variantFull);
    expect(smallImageFor(full, { ...product, image_urls_thumb: [] } as Product)).toBe(full);
  });
});

describe('Batch 40 Part 2.5: brand videos are made small', () => {
  it('720p at most, never enlarged, aspect ratio kept, even sizes', () => {
    expect(videoOutputSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(videoOutputSize(3840, 2160)).toEqual({ width: 1280, height: 720 });
    expect(videoOutputSize(1080, 1920)).toEqual({ width: 720, height: 1280 });
    expect(videoOutputSize(640, 360)).toEqual({ width: 640, height: 360 });
    expect(videoOutputSize(1080, 1080)).toEqual({ width: 720, height: 720 });
    expect(videoOutputSize(1920, 1080, 540)).toEqual({ width: 960, height: 540 });
    const odd = videoOutputSize(1001, 563);
    expect(odd.width % 2).toBe(0);
    expect(odd.height % 2).toBe(0);
  });

  it('the bitrate keeps a 20-second clip under 1.5 MB, and short clips get more quality', () => {
    const twenty = videoBitrate(20);
    expect((twenty * 20) / 8).toBeLessThan(VIDEO_MAX_BYTES);
    expect(videoBitrate(5)).toBeGreaterThan(twenty);
    // Longer clips are cut to 20 s, so the budget never shrinks below that.
    expect(videoBitrate(60)).toBe(twenty);
    expect(videoBitrate(20, 0.7)).toBeLessThan(twenty);
    expect(videoBitrate(1)).toBeLessThanOrEqual(1_200_000);
  });

  it('later tries only ever get smaller, never larger than 720p', () => {
    for (const [i, t] of VIDEO_TRIES.entries()) {
      expect(t.maxShort).toBeLessThanOrEqual(720);
      if (i > 0) {
        const prev = VIDEO_TRIES[i - 1];
        expect(t.maxShort * t.fps * t.bitrateFactor).toBeLessThan(prev.maxShort * prev.fps * prev.bitrateFactor);
      }
    }
  });

  it('a made-small video is known by its name', () => {
    expect(isCompressedVideoUrl('https://x.supabase.co/storage/v1/object/public/brand-media/videos/abc-720p.mp4')).toBe(true);
    expect(isCompressedVideoUrl('https://x.supabase.co/storage/v1/object/public/brand-media/videos/abc.mp4')).toBe(false);
  });
});

describe('Batch 40 Part 3: when the shop counts Supabase as down', () => {
  it('402 (plan blocked) is always down; server errors and no answer only before the first data', () => {
    expect(judgeAnswer(402, true, false)).toBe('down');
    expect(judgeAnswer(503, true, true)).toBe('down');
    expect(judgeAnswer(500, true, false)).toBe('unknown');
    expect(judgeAnswer(null, true, true)).toBe('down');
    // The phone itself offline is not "the shop is down" (the offline banner covers it).
    expect(judgeAnswer(null, false, true)).toBe('unknown');
    expect(judgeAnswer(200, true, true)).toBe('up');
    expect(judgeAnswer(401, true, false)).toBe('up');
  });

  it('the fallback buttons work without the database, from the build settings or the defaults', () => {
    expect(fallbackWhatsAppUrl('')).toBe('https://wa.me/8801560040012');
    expect(fallbackWhatsAppUrl('01560040012')).toBe('https://wa.me/8801560040012');
    expect(fallbackWhatsAppUrl('+880 1711-000000')).toBe('https://wa.me/8801711000000');
    expect(fallbackWhatsAppUrl('https://wa.me/8801999999999')).toBe('https://wa.me/8801999999999');
    expect(fallbackMessengerUrl('')).toBe('https://m.me/naeems.skinscience');
    expect(fallbackMessengerUrl('https://m.me/other.page')).toBe('https://m.me/other.page');
    expect(fallbackMessengerUrl('not a link')).toBe('https://m.me/naeems.skinscience');
  });
});
