export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
/** Batch 40: the "large" photo — the product page and its zoom. 1400 px
 *  (was 1200) so it stays sharp on a 3× phone screen; a smaller original is
 *  never enlarged. */
export const MAX_IMAGE_WIDTH = 1400;
export const WEBP_QUALITY = 0.85;

/** Small "card" size — grid cards, bento tiles, search results, cart
 *  thumbnails. A card is at most ~180 px wide on a phone, 480 px covers a
 *  2.6× screen (Batch 40: was 400 px). */
export const CARD_IMAGE_WIDTH = 480;
export const CARD_WEBP_QUALITY = 0.82;

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function isAcceptedImageType(file: File): boolean {
  return ACCEPTED_TYPES.includes(file.type);
}

/** Shared resize core — draws `source` onto a canvas capped at `maxWidth`
 *  (aspect ratio preserved) and encodes it as WebP at `quality`. Accepts any
 *  Blob, not just a file picker's File, so the same code path resizes a
 *  freshly chosen photo AND an existing photo re-fetched over the network
 *  (see generateCardThumb, used by the one-time thumbnail backfill). */
function resizeToWidth(source: Blob, maxWidth: number, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(source);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxWidth / img.naturalWidth);
      const width = Math.round(img.naturalWidth * scale);
      const height = Math.round(img.naturalHeight * scale);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas is not supported in this browser.'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Could not convert image to WebP.'));
          }
        },
        'image/webp',
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read the selected image.'));
    };

    img.src = objectUrl;
  });
}

/**
 * Resize an image file client-side using an HTML Canvas:
 * max 1400px wide (aspect ratio preserved), WebP format, 0.85 quality.
 */
export function resizeImage(file: Blob): Promise<Blob> {
  return resizeToWidth(file, MAX_IMAGE_WIDTH, WEBP_QUALITY);
}

/** Small-card version of the same image — max 480px wide, WebP, 0.82 quality. */
export function resizeImageCard(file: Blob): Promise<Blob> {
  return resizeToWidth(file, CARD_IMAGE_WIDTH, CARD_WEBP_QUALITY);
}

/** Batch 31 Part 8: Browse circle version — max 160px wide, WebP, 0.8 quality. */
export const CIRCLE_IMAGE_WIDTH = 160;
export function resizeImageCircle(file: Blob): Promise<Blob> {
  return resizeToWidth(file, CIRCLE_IMAGE_WIDTH, CARD_WEBP_QUALITY);
}
