import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
      registerType: 'autoUpdate',
      includeAssets: ['offline.html', 'icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: "Naeem's",
        short_name: "Naeem's",
        description: 'Internal price lookup tool',
        theme_color: '#F2F2F7',
        background_color: '#F2F2F7',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
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
            // Supabase Storage images: CacheFirst, 150 entries, 30 days.
            urlPattern: /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'supabase-storage-images',
              expiration: { maxEntries: 150, maxAgeSeconds: 2592000 },
              cacheableResponse: { statuses: [0, 200] },
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
