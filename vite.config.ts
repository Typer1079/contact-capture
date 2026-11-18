import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Content Security Policy for production builds.
// GitHub Pages cannot set HTTP headers, so the policy is injected as a <meta> tag.
// It is applied only to builds because the dev server relies on inline scripts.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'", // wasm needed by the on-device barcode reader
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      )
    },
  }
}

export default defineConfig({
  // For a GitHub Pages project site this is "/<repo-name>/" (set by the deploy workflow).
  base: process.env.VITE_BASE ?? '/',
  plugins: [
    react(),
    tailwindcss(),
    cspPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Contact Capture',
        short_name: 'Contacts',
        description: 'Capture contacts quickly and export them.',
        theme_color: '#0f172a',
        background_color: '#f8fafc',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,wasm}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Never cache API traffic: contact data stays out of the service worker cache.
        navigateFallbackDenylist: [/^\/auth/, /^\/rest/],
      },
    }),
  ],
})
