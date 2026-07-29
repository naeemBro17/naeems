export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_IMAGE_WIDTH = 1200;
export const WEBP_QUALITY = 0.85;

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function isAcceptedImageType(file: File): boolean {
  return ACCEPTED_TYPES.includes(file.type);
}

/**
 * Resize an image file client-side using an HTML Canvas:
 * max 600px wide (aspect ratio preserved), WebP format, 0.85 quality.
 */
export function resizeImage(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, MAX_IMAGE_WIDTH / img.naturalWidth);
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
        WEBP_QUALITY
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read the selected image.'));
    };

    img.src = objectUrl;
  });
}
