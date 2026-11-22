# Cloudflare Workers Web Proxy + Built-in YouTube Player

A **100% Cloudflare Workers** proxy (single self-contained file: `src/index.js`, zero external dependencies) optimized for the **Cloudflare Workers Free Tier** (10ms CPU / 128MB RAM / 100k req/day).

## Features

- **Built-in Fast YouTube Player (`/yt`)**: Uses YouTube's InnerTube API (`IOS` → `ANDROID` → `TVHTML5_SIMPLY_EMBEDDED_PLAYER` fallback chain) to search, browse, and play YouTube videos directly in a native HTML5 `<video>` player with quality switching, HLS `.m3u8` manifest rewriting, related videos, and zero-copy `googlevideo.com` `Range`/`206` streaming (no broken Polymer SPA!).
- **All Websites Proxy (`/-----https://...`)**: Proxies any `http://`, `https://`, `ws://`, or `wss://` website (including Chess.com live games via native WebSocket passthrough).
- **jsproxy Service Worker (`/__proxy_sw.js`)**: Intercepts `fetch`, `XHR`, ES `import()`, dynamic scripts, and media right in the browser for zero extra Worker CPU.
- **Cloudflare Free-Tier Optimized**: Native Rust streaming `HTMLRewriter`, immutable browser-cached client runtime (`/__proxy_runtime.js`), edge + browser static asset caching (`ytimg.com`, `ggpht.com`, `chesscomfiles.com`, `fonts.gstatic.com`), and zero-copy streaming for video/binary assets.

## Deploy to Cloudflare Workers

**Option 1 — Wrangler CLI**
```bash
npx wrangler deploy
```

**Option 2 — Cloudflare Dashboard (Copy & Paste)**
1. Open [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create Worker**.
2. Click **Edit Code**, paste the entire contents of `src/index.js`, and click **Deploy**.

**Option 3 — Cloudflare Workers Git Integration**
Connect this GitHub repository in Cloudflare Dashboard → **Workers & Pages** → **Create** → **Import a repository** (uses `wrangler.toml` automatically).

## Usage

- Open your Worker URL (`https://web-proxy.<your-subdomain>.workers.dev`).
- Click **▶ YouTube** (`/yt`) or **⚡ Shorts** (`/shorts`) to browse, search, and watch videos directly.
- Any `youtube.com`, `youtu.be`, `youtube.com/shorts/...`, or `youtube.com/embed/...` link automatically opens in the working player.
- Toggle between **Direct Proxy Stream** and **Official YT Player** right in the watch bar.

## Optional: Official YouTube Data API v3 & Signed-In Session

For the highest reliability without anonymous datacenter rate limits, you can configure optional Cloudflare Worker secrets (never committed to git):

```bash
# Official YouTube Data API v3 key (for reliable search, home feed, Shorts feed, and metadata)
npx wrangler secret put YT_API_KEY

# Optional: Your own signed-in YouTube session cookie (authenticates InnerTube as your account)
npx wrangler secret put YT_COOKIE
```

Check `/__proxy_health` to confirm `ytApiKeyConfigured` and `ytCookieConfigured` are `true`.

## Test

```bash
npm test
```