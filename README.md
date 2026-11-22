# Cloudflare Workers Chess.com Proxy

An ultra-lightweight web proxy engineered for the **Cloudflare Workers Free Tier** (10ms CPU / 128MB RAM / 100k req/day), paired with an optional **GitHub Pages** frontend (`docs/index.html`) for playing [Chess.com](https://www.chess.com).

## Free-Tier Cloudflare Optimizations

- **Native Rust Streaming `HTMLRewriter`**: Rewrites HTML URLs, strips CSP/`integrity`, removes ad `<script>`/`<iframe>` tags, and injects the runtime in streaming C++/Rust (<1ms JS CPU, zero full-page buffering).
- **Static Browser-Cached Client Runtime (`/__proxy_runtime.js`)**: Served once with `Cache-Control: public, max-age=86400, immutable` — zero per-request templating and zero repeat Worker hits.
- **Double-Layer Ad & Tracker Blocking**: Blocks 50+ ad/analytics/telemetry hosts both in the browser runtime (0 Worker requests!) and at the Worker edge (instant `204` / empty JS with 24h cache, 0 upstream fetch) — cutting 30–50% of Chess.com page requests.
- **Edge + Browser Caching for Static Assets**: `*.chesscomfiles.com` and `.js`/`.css`/`.wasm`/`.png`/`.svg`/`.woff2`/`.mp3` assets strip upstream cookies, enable Cloudflare's `cf: { cacheTtl: 86400, cacheEverything: true }` + `caches.default`, and return `Cache-Control: public, max-age=86400` so pieces, sounds, fonts, and Stockfish load from cache on repeat visits.
- **Zero-Copy Streaming & Size-Guarded CSS**: Large binary assets (like Stockfish `.wasm`) stream directly without buffering; CSS rewriting exits early when no `url()`/`@import` is present and skips files >1.5MB.
- **Native WebSocket Passthrough**: Proxies `wss://live*.chess.com` with rewritten `Origin` and `Host` for real-time games.

## Deploy to Cloudflare Workers

```bash
npx wrangler deploy
```

Then open your deployed `https://web-proxy.<your-subdomain>.workers.dev` URL directly, or connect it to the GitHub Pages shell (`docs/index.html`) via **Settings → Pages → GitHub Actions** (or `main / docs`).

## Tests

```bash
npm test
```