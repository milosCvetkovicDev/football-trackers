import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Dev runs SAME-ORIGIN with the server (ADR-0015): the app, its API, and the /live WebSocket all
// share the Vite dev origin (http://localhost:5173) — there is no cross-origin WS anymore. Vite's
// dev server proxies /live (WebSocket), /auth, and /sessions through to the Bun/Elysia server
// (VITE_PROXY_TARGET, default http://localhost:3000). In production the same shape is served behind
// Caddy. Because everything is same-origin, the CSP connect-src in index.html is simply 'self'.
//
// changeOrigin:false is deliberate and load-bearing: the upstream server enforces a STRICT Origin
// allow-list (originOkStrict) on /auth and /live, and a missing/wrong Origin is rejected. Leaving
// changeOrigin false makes the proxy forward the REAL browser Origin (http://localhost:5173) so the
// server's allow-list check sees it, instead of rewriting it to the proxy target's host.
//
// CSP note (see index.html): the build stays self-hosted and CSP-clean. Vite's defaults already are —
// it emits a same-origin hashed JS bundle (script-src 'self') and same-origin/inlined CSS
// (style-src 'self' 'unsafe-inline'), fetches nothing from a CDN, and ships zero third-party/font
// assets. Vite may inline tiny assets as data: URIs; the CSP permits that for images
// (img-src 'self' data:) and no fonts are bundled (system fonts only). Don't add CDN/remote assets.
export default defineConfig(({ mode }) => {
  // Read VITE_PROXY_TARGET from both .env files and the process env the dev server was spawned with
  // (how the e2e fixtures pass it). It is NOT a VITE_-prefixed *client* var — the app never sees the
  // target; it only steers the dev proxy — so read it without the prefix filter and fall back to env.
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.VITE_PROXY_TARGET || process.env.VITE_PROXY_TARGET || 'http://localhost:3000';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        // /live is a WebSocket upgrade; ws:true proxies the upgrade. /auth + /sessions are HTTP.
        // changeOrigin:false on all three preserves the browser Origin for the server's allow-list.
        '/live': { target: proxyTarget, ws: true, changeOrigin: false },
        '/auth': { target: proxyTarget, changeOrigin: false },
        '/sessions': { target: proxyTarget, changeOrigin: false },
      },
    },
  };
});
