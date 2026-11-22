# Cloudflare Workers Web Proxy

An ultra-lightweight web proxy engineered for the **Cloudflare Workers Free Tier** (10ms CPU / 128MB RAM / 100k req/day), allowing **all websites** (including [Chess.com](https://www.chess.com) with live WebSockets), paired with an optional **GitHub Pages** frontend (`docs/index.html`).

## Free-Tier Cloudflare Optimizations

- **All Websites Allowed**: No domain or host blocklist — proxies any `http://`, `https://`, `ws://`, or `wss://` website.
- **Native Rust Streaming `HTMLRewriter`**: Rewrites HTML URLs, strips CSP/`integrity`, and injects the runtime in streaming C++/Rust (<1ms JS CPU, zero full-page buffering).
- **Static Browser-Cached Client Runtime (`/__proxy_runtime.js`)**: Served once with `Cache-Control: public, max-age=86400, immutable` — zero per-request templating and zero repeat Worker hits.
- **Edge + Browser Caching for Static Assets**: Static assets (`.js`/`.css`/`.wasm`/`.png`/`.svg`/`.woff2`/`.mp3` and `*.chesscomfiles.com`) enable Cloudflare's `cf: { cacheTtl: 86400, cacheEverything: true }` + `caches.default`, and return `Cache-Control: public, max-age=86400` so assets load from cache on repeat visits.
- **Zero-Copy Streaming & Size-Guarded CSS**: Large binary assets (like Stockfish `.wasm`, videos, images) stream directly without buffering; CSS rewriting exits early when no `url()`/`@import` is present and skips files >1.5MB.
- **Native WebSocket Passthrough**: Proxies `wss://` connections with rewritten `Origin` and `Host` for real-time apps and live games.

## Deploy to Cloudflare Workers

```bash
npx wrangler deploy
```

Then open your deployed `https://web-proxy.<your-subdomain>.workers.dev` URL directly, or connect it to the GitHub Pages shell (`docs/index.html`) via **Settings → Pages → GitHub Actions** (or `main / docs`).

## Tests

```bash
npm test
```