import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages では https://<user>.github.io/kiyora-regi/ 配下で公開されるため base を固定する。
const BASE = '/kiyora-regi/'

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '屋台レジ',
        short_name: '屋台レジ',
        description: 'お祭り屋台向け POS(会計・受け渡し・現金管理)',
        lang: 'ja',
        start_url: BASE,
        scope: BASE,
        id: BASE,
        display: 'standalone',
        background_color: '#FAF5EC',
        theme_color: '#B8792E',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['legacy/**'],
        navigateFallback: `${BASE}index.html`,
        navigateFallbackDenylist: [new RegExp(`^${BASE}legacy/`)],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
        ],
      },
    }),
  ],
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  build: { target: 'es2022', sourcemap: false },
})
