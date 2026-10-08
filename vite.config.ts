import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/** Batch 31 Part 7: which version a phone runs, shown in Admin → Settings.
 *  Vercel gives the commit; a local build asks git. */
function buildCommit(): string {
  const fromVercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromVercel) return fromVercel.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'local';
  }
}

/** Batch 32 Part 2: the version lives in ONE place — package.json
 *  "version" (each batch N sets it to 1.N.0). */
function appVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

export default defineConfig({
  define: {
    __APP_COMMIT__: JSON.stringify(buildCommit()),
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  build: {
    // flag-icons ships ~540 country SVGs, nearly all under Vite's default 4kB
    // inline threshold. Left alone they get base64'd into the stylesheet and
    // push it past 480kB for the handful of flags a page actually shows, so
    // they stay as separate files fetched on demand.
    assetsInlineLimit: (filePath: string) =>
      filePath.includes('flag-icons') ? false : undefined,
  },
  plugins: [
    react(),
    VitePWA({
      // Batch 31 Part 7: a new version downloads in the background and waits;
      // src/lib/appUpdate.ts switches it on at a safe moment (never during
      // checkout or an open form) and checks for new versions on open, on
      // return to the app and every 30 minutes. It registers the worker
      // itself after the page has loaded, so it never holds up the first
      // paint (Batch 29 Part 7).
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: [
        'offline.html',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/icon-maskable-192.png',
        'icons/icon-maskable-512.png',
        'icons/icon-splash-192.png',
        'icons/icon-splash-512.png',
      ],
      manifest: {
        name: "NAEEM'S",
        short_name: "NAEEM'S",
        description: 'Authentic Australian skincare in Bangladesh',
        // The page background in light mode (--color-bg). A manifest can hold
        // one colour only; dark mode's bar colour comes from the theme-color
        // meta tags in index.html.
        theme_color: '#FFFFFF',
        background_color: '#FFFFFF',
        display: 'standalone',
        id: '/',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        // "any" (Batch 32 Part 6): the round orange logo alone on a fully
        // transparent square, sized to sit inside Android's round splash
        // crop — the opening screen shows just the logo on white, no square
        // behind it (scripts/make-splash-icons.mjs). "maskable": the same
        // logo on a full orange square, for the home-screen icon only, so
        // Android's icon shapes never cut it or leave a white ring.
        // A manifest has one opening-screen colour: white, in dark mode too.
        icons: [
          { src: '/icons/icon-splash-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-splash-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell (HTML/CSS/JS) is precached — served CacheFirst by Workbox.
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        // Precaching every country flag would bloat the install for no gain —
        // they're cached at runtime as reviewers' countries actually appear.
        // Every emitted assets/*.svg is a flag-icons country flag — the app's
        // own icons are inline JSX, and its PNG/ICO assets live in public/.
        globIgnores: ['**/assets/*.svg'],
        navigateFallback: '/index.html',
        // Old versions' precached files are removed when a new one switches on.
        // (Runtime caches — images, brand videos, fonts — are kept.)
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Supabase REST API: NetworkFirst — on fail, serve from cache.
            // The app itself also falls back to localStorage and shows the offline banner.
            urlPattern: /^https:\/\/[a-z0-9-]+\.supabase\.co\/rest\/v1\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api',
              networkTimeoutSeconds: 6,
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Brand banner videos (Batch 29 Part 6): the whole file is kept
            // once it has been downloaded in full (the shop pre-loads it),
            // and the video player's byte-range requests are answered from
            // that copy — a second visit starts at once, even offline. Must
            // stay above the general Storage rule (first match wins).
            urlPattern: /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/brand-media\/videos\/[^?]+\.(mp4|webm)(\?.*)?$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'brand-videos',
              rangeRequests: true,
              expiration: { maxEntries: 12, maxAgeSeconds: 2592000 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Supabase Storage images: CacheFirst, 150 entries, 30 days.
            // Batch 33: an <img> asks in "no-cors" mode, so the worker got an
            // opaque answer (status 0) it could not read — a missing file or
            // a passing error (Storage answers 400) looked the same as a real
            // photo and was kept for 30 days, showing a broken image. Storage
            // allows CORS, so the worker now asks in CORS mode, sees the real
            // status and keeps only real 200 photos. If a CORS request ever
            // fails it falls back to the original request. New cache name so
            // anything stored the old way is never served again (the app
            // deletes the old cache on start).
            urlPattern: /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'supabase-storage-images-v2',
              expiration: { maxEntries: 150, maxAgeSeconds: 2592000 },
              cacheableResponse: { statuses: [200] },
              plugins: [
                {
                  requestWillFetch: async ({ request }: { request: Request }) =>
                    request.mode === 'no-cors'
                      ? new Request(request.url, { mode: 'cors', credentials: 'omit' })
                      : request,
                  handlerDidError: async ({ request }: { request: Request }) =>
                    fetch(request.url, { mode: 'no-cors' }),
                },
              ],
            },
          },
          {
            // Country flags: CacheFirst — a flag never changes once emitted.
            urlPattern: /\/assets\/[^/]+\.svg$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'country-flags',
              expiration: { maxEntries: 60, maxAgeSeconds: 31536000 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Google Fonts stylesheets + font files: CacheFirst, long expiry.
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 31536000 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
