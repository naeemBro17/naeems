import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
