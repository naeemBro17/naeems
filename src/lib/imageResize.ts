export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_IMAGE_WIDTH = 1200;
export const WEBP_QUALITY = 0.85;

/** Small "card" size — grid cards, bento tiles, search results, cart
 *  thumbnails never display wider than this, so there is no reason to ship
 *  the full 1200px photo to them (see Batch 15/19 performance notes). */
export const CARD_IMAGE_WIDTH = 400;
export const CARD_WEBP_QUALITY = 0.8;

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
 * max 1200px wide (aspect ratio preserved), WebP format, 0.85 quality.
 */
export function resizeImage(file: Blob): Promise<Blob> {
  return resizeToWidth(file, MAX_IMAGE_WIDTH, WEBP_QUALITY);
}

/** Small-card version of the same image — max 400px wide, WebP, 0.8 quality. */
export function resizeImageCard(file: Blob): Promise<Blob> {
  return resizeToWidth(file, CARD_IMAGE_WIDTH, CARD_WEBP_QUALITY);
}
