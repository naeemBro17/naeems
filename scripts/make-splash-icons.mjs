// Batch 32 Part 6: the app's opening-screen ("splash") icon.
// Android 12+ shows the "any" icon in the middle of the opening screen and
// crops it to a circle about two thirds of its width, on the manifest's
// background colour. This makes public/icons/icon-splash-{512,192}.png: the
// round orange logo (from icon-512.png) scaled to 62 % and centred on a fully
// transparent square, so nothing is cut and no square or ring shows behind it.
// The home-screen icon stays the full-bleed "maskable" one.
//   node scripts/make-splash-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const SOURCE = 'public/icons/icon-512.png';
const SCALE = 0.62;

const src = PNG.sync.read(readFileSync(SOURCE));

// The logo's own box (every pixel that isn't fully transparent).
let minX = src.width;
let minY = src.height;
let maxX = 0;
let maxY = 0;
for (let y = 0; y < src.height; y += 1) {
  for (let x = 0; x < src.width; x += 1) {
    if (src.data[(y * src.width + x) * 4 + 3] > 0) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
}
const logoW = maxX - minX + 1;
const logoH = maxY - minY + 1;

function render(size) {
  const out = new PNG({ width: size, height: size });
  out.data.fill(0);
  const target = Math.round(size * SCALE);
  const scale = Math.max(logoW, logoH) / target;
  const offX = Math.round((size - logoW / scale) / 2);
  const offY = Math.round((size - logoH / scale) / 2);
  // Area-average (box filter) with premultiplied alpha: clean edges, no dark fringe.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx0 = (x - offX) * scale + minX;
      const sy0 = (y - offY) * scale + minY;
      const sx1 = sx0 + scale;
      const sy1 = sy0 + scale;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy += 1) {
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx += 1) {
          const w = (Math.min(sx + 1, sx1) - Math.max(sx, sx0)) * (Math.min(sy + 1, sy1) - Math.max(sy, sy0));
          if (w <= 0) continue;
          area += w;
          if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
          const i = (sy * src.width + sx) * 4;
          const alpha = src.data[i + 3] / 255;
          r += src.data[i] * alpha * w;
          g += src.data[i + 1] * alpha * w;
          b += src.data[i + 2] * alpha * w;
          a += alpha * w;
        }
      }
      const o = (y * size + x) * 4;
      if (area === 0 || a === 0) continue;
      out.data[o] = Math.round(r / a);
      out.data[o + 1] = Math.round(g / a);
      out.data[o + 2] = Math.round(b / a);
      out.data[o + 3] = Math.round((a / area) * 255);
    }
  }
  return out;
}

for (const size of [512, 192]) {
  const file = `public/icons/icon-splash-${size}.png`;
  writeFileSync(file, PNG.sync.write(render(size), { colorType: 6 }));
  console.log(`wrote ${file}`);
}
