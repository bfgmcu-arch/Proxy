# Cloudflare Workers Discord Proxy

A **100% Cloudflare Workers** proxy (single self-contained file: `src/index.js`, zero external dependencies) specifically built for **Discord** and optimized for the **Cloudflare Workers Free Tier** (10ms CPU / 128MB RAM / 100k req/day).

## Features

- **Discord-First Launcher (`/`)**: One-click **Sign In to Discord** (`/login`), **Open Discord App** (`/app`), **Direct Messages** (`/channels/@me`), **Discord PTB**, **Discord Canary**, and custom Discord invite/channel URLs.
- **Full Discord Sign-In Support**:
  - Proxies `discord.com/login`, `/api/v9/auth/login`, `/api/v9/auth/mfa/totp` (2FA), and `/api/v9/users/@me`.
  - Rewrites `Set-Cookie` headers (`__dcfduid`, `__sdcfduid`, `__cf_bm`) for both HTTPS (`SameSite=None; Secure`) and local HTTP (`SameSite=Lax`) proxies.
  - Enforces Discord `Origin` (`https://discord.com` / `ptb.discord.com` / `canary.discord.com`) and `Referer` headers while stripping `cf-*` and `sec-fetch-*` headers.
  - Supports CORS preflight with Discord auth/captcha headers (`Authorization`, `X-Super-Properties`, `X-Captcha-Key`, etc.).
- **Gateway & Remote Auth WebSockets**: Native WebSocket passthrough for `wss://gateway.discord.gg` and `wss://remote-auth-gateway.discord.gg` (QR code sign-in).
- **Direct Discord Path Resolution**: Requests to `/login`, `/app`, `/channels/*`, `/api/*`, `/assets/*`, `/invite/*`, etc. resolve automatically to `https://discord.com`.
- **Service Worker & Client Runtime (`/__proxy_sw.js`, `/__proxy_runtime.js`)**: Intercepts `fetch`, `XHR`, `WebSocket`, `Worker`, `History.pushState`/`replaceState`, and DOM URL attributes in the browser.
- **Cookie-Free Discord CDN Caching**: Strips cookies and caches static assets from `cdn.discordapp.com`, `media.discordapp.net`, `images-ext-1.discordapp.net`, and `images-ext-2.discordapp.net`.

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

## Test

```bash
npm test
```