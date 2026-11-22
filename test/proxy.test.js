import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import worker from '../src/index.js';
import { createProxyServer } from '../server.js';
import {
  RUNTIME_PATH,
  isStaticAssetUrl,
  normalizeTargetUrl,
  resolveIncomingTargetUrl,
  rewriteHtml,
  rewriteCss,
  rewriteSetCookie,
  stripInternalParams,
  computeUpstreamOrigin,
} from '../src/rewriter.js';

test('normalizeTargetUrl fixes collapsed protocol slashes', () => {
  assert.equal(normalizeTargetUrl('https:/www.chess.com/play'), 'https://www.chess.com/play');
  assert.equal(normalizeTargetUrl('wss:/live1.chess.com/cometd'), 'wss://live1.chess.com/cometd');
  assert.equal(normalizeTargetUrl('https://www.chess.com/play'), 'https://www.chess.com/play');
});

test('isStaticAssetUrl detects Chess.com CDN and static file extensions', () => {
  assert.equal(isStaticAssetUrl(new URL('https://images.chesscomfiles.com/chess-themes/pieces/neo/150/wk.png')), true);
  assert.equal(isStaticAssetUrl(new URL('https://www.chess.com/bundles/stockfish.wasm')), true);
  assert.equal(isStaticAssetUrl(new URL('https://www.chess.com/play/online')), false);
  assert.equal(isStaticAssetUrl(new URL('https://www.chess.com/callback/user/popup')), false);
});

test('resolveIncomingTargetUrl resolves root-relative paths via Referer against origin', () => {
  const reqUrl = new URL('https://proxy.example/callback/user/popup?v=1');
  const referer = 'https://proxy.example/https://www.chess.com/play/online';
  const res = resolveIncomingTargetUrl(reqUrl, referer);
  assert.equal(res.targetUrl.href, 'https://www.chess.com/callback/user/popup?v=1');
});

test('rewriteSetCookie strips Domain, normalizes Path, and sets SameSite=None; Secure for HTTPS', () => {
  const raw = 'PHPSESSID=abc123; Domain=.chess.com; Path=/play; HttpOnly; SameSite=Lax';
  const rewritten = rewriteSetCookie(raw, true);
  assert.doesNotMatch(rewritten, /Domain=/i);
  assert.match(rewritten, /Path=\//);
  assert.match(rewritten, /SameSite=None/);
  assert.match(rewritten, /\bSecure\b/);
  assert.match(rewritten, /HttpOnly/);
});

test('rewriteHtml rewrites URLs, strips CSP/integrity, and injects static cached runtime script', () => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'">
  <link rel="stylesheet" href="/bundles/app.css" integrity="sha384-abc">
  <style>.board { background: url('/img/board.png'); }</style>
</head>
<body>
  <img src="https://images.chesscomfiles.com/piece.png" srcset="/a.png 1x, https://cdn.chess.com/b.png 2x">
  <script src="//betacssjs.chesscomfiles.com/app.js" integrity="sha384-xyz"></script>
</body>
</html>`;

  const out = rewriteHtml(html, 'https://www.chess.com/play', 'https://proxy.example');
  assert.doesNotMatch(out, /Content-Security-Policy/i);
  assert.doesNotMatch(out, /integrity=/i);
  assert.match(out, /<script src="https:\/\/proxy\.example\/__proxy_runtime\.js"><\/script>/);
  assert.match(out, /href="https:\/\/proxy\.example\/https:\/\/www\.chess\.com\/bundles\/app\.css"/);
  assert.match(out, /url\('https:\/\/proxy\.example\/https:\/\/www\.chess\.com\/img\/board\.png'\)/);
  assert.match(out, /src="https:\/\/proxy\.example\/https:\/\/images\.chesscomfiles\.com\/piece\.png"/);
  assert.match(out, /src="https:\/\/proxy\.example\/https:\/\/betacssjs\.chesscomfiles\.com\/app\.js"/);
  assert.match(out, /srcset="https:\/\/proxy\.example\/https:\/\/www\.chess\.com\/a\.png 1x, https:\/\/proxy\.example\/https:\/\/cdn\.chess\.com\/b\.png 2x"/);
});

test('rewriteCss rewrites url() and @import rules and fast-exits when none present', () => {
  const plain = 'body { color: #fff; margin: 0; }';
  assert.equal(rewriteCss(plain, 'https://www.chess.com/a.css', 'https://proxy.example'), plain);

  const css = `@import "/fonts.css"; .k { background: url('../pieces/wk.svg'); }`;
  const out = rewriteCss(css, 'https://www.chess.com/css/theme.css', 'https://proxy.example');
  assert.match(out, /@import "https:\/\/proxy\.example\/https:\/\/www\.chess\.com\/fonts\.css"/);
  assert.match(out, /url\('https:\/\/proxy\.example\/https:\/\/www\.chess\.com\/pieces\/wk\.svg'\)/);
});

test('stripInternalParams extracts __proxy_origin cleanly', () => {
  const u = new URL('wss://live1.chess.com/cometd?foo=1&__proxy_origin=https%3A%2F%2Fwww.chess.com');
  const { cleanedUrl, explicitOrigin } = stripInternalParams(u);
  assert.equal(cleanedUrl.href, 'wss://live1.chess.com/cometd?foo=1');
  assert.equal(explicitOrigin, 'https://www.chess.com');
  assert.equal(computeUpstreamOrigin(cleanedUrl, null, explicitOrigin), 'https://www.chess.com');
});

test('Cloudflare Worker fast paths: health, immutable runtime, all websites allowed, static asset caching', async () => {
  // 1. Health check
  const health = await worker.fetch(new Request('https://my-proxy.workers.dev/__proxy_health'), {}, {});
  assert.equal(health.status, 200);
  const hJson = await health.json();
  assert.equal(hJson.ok, true);
  assert.equal(hJson.runtime, 'cloudflare-worker');

  // 2. Static immutable runtime script
  const rt = await worker.fetch(new Request(`https://my-proxy.workers.dev${RUNTIME_PATH}`), {}, {});
  assert.equal(rt.status, 200);
  assert.match(rt.headers.get('cache-control'), /immutable/);
  assert.match(rt.headers.get('content-type'), /javascript/);
  const rtBody = await rt.text();
  assert.match(rtBody, /__PROXY_RT__/);

  // 3. Arbitrary websites & static assets are all allowed; static assets set cf cache + Cache-Control
  const origFetch = globalThis.fetch;
  let capturedUrl = null;
  let capturedInit = null;
  globalThis.fetch = async (u, init) => {
    capturedUrl = u;
    capturedInit = init;
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    });
  };
  try {
    const anyResp = await worker.fetch(
      new Request('https://my-proxy.workers.dev/https://example.org/hello'),
      {},
      { waitUntil() {} }
    );
    assert.equal(anyResp.status, 200);
    assert.equal(capturedUrl, 'https://example.org/hello');

    const assetResp = await worker.fetch(
      new Request('https://my-proxy.workers.dev/https://images.chesscomfiles.com/wk.png', {
        headers: { Cookie: 'secret=123' },
      }),
      {},
      { waitUntil() {} }
    );
    assert.equal(assetResp.status, 200);
    assert.equal(capturedUrl, 'https://images.chesscomfiles.com/wk.png');
    assert.equal(capturedInit.headers.get('cookie'), null);
    assert.equal(capturedInit.cf.cacheEverything, true);
    assert.equal(capturedInit.cf.cacheTtl, 86400);
    assert.match(assetResp.headers.get('cache-control'), /max-age=86400/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('end-to-end HTTP, gzip, multi-Set-Cookie, redirect, and WebSocket proxying', async () => {
  let lastUpstreamWsOrigin = null;
  let lastUpstreamWsPath = null;
  let lastUpstreamHttpOrigin = null;

  const upstream = http.createServer((req, res) => {
    lastUpstreamHttpOrigin = req.headers.origin || null;

    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/play' });
      return res.end();
    }

    if (req.url === '/play') {
      const body = zlib.gzipSync(
        Buffer.from('<html><head></head><body><a href="/game">Game</a></body></html>')
      );
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Encoding': 'gzip',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
        'Set-Cookie': [
          'session_id=s1; Domain=.chess.com; Path=/; HttpOnly',
          'csrf_token=c2; Domain=.chess.com; Path=/play; SameSite=Strict',
        ],
      });
      return res.end(body);
    }

    res.writeHead(404);
    res.end('Not found');
  });

  upstream.on('upgrade', (req, socket) => {
    lastUpstreamWsOrigin = req.headers.origin || null;
    lastUpstreamWsPath = req.url;

    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n')
    );

    socket.on('data', (buf) => {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      if (opcode === 0x08) return socket.end();
      const masked = (buf[1] & 0x80) !== 0;
      const len = buf[1] & 0x7f;
      let offset = 2;
      let maskKey = null;
      if (masked) {
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    });
  });

  const proxy = createProxyServer();
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));

  const upstreamPort = upstream.address().port;
  const proxyPort = proxy.address().port;
  const proxyBase = `http://127.0.0.1:${proxyPort}`;
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

  try {
    const pageResp = await fetch(`${proxyBase}/${upstreamBase}/play`, {
      headers: {
        Origin: 'https://bfgmcu-arch.github.io',
        'X-Forwarded-Proto': 'https',
      },
    });
    assert.equal(pageResp.status, 200);
    assert.equal(pageResp.headers.get('x-frame-options'), null);
    assert.equal(pageResp.headers.get('content-security-policy'), null);
    assert.equal(pageResp.headers.get('content-encoding'), null);
    assert.equal(lastUpstreamHttpOrigin, upstreamBase);

    const cookies = pageResp.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.ok(cookies.every((c) => !/Domain=/i.test(c) && /SameSite=None/.test(c) && /Secure/.test(c)));

    const pageHtml = await pageResp.text();
    assert.match(pageHtml, /__proxy_runtime\.js/);
    assert.match(pageHtml, new RegExp(`href="https://127\\.0\\.0\\.1:${proxyPort}/${upstreamBase}/game"`));

    const redirResp = await fetch(`${proxyBase}/${upstreamBase}/redirect`, { redirect: 'manual' });
    assert.equal(redirResp.status, 302);
    assert.equal(redirResp.headers.get('location'), `${proxyBase}/${upstreamBase}/play`);

    const wsUrl = `ws://127.0.0.1:${proxyPort}/ws://127.0.0.1:${upstreamPort}/cometd?__proxy_origin=${encodeURIComponent('https://www.chess.com')}`;
    const echoed = await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error('WebSocket timeout')), 5000);
      ws.addEventListener('open', () => ws.send('e2e4'));
      ws.addEventListener('message', (ev) => {
        clearTimeout(timer);
        ws.close();
        resolve(ev.data);
      });
      ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.equal(echoed, 'e2e4');
    assert.equal(lastUpstreamWsOrigin, 'https://www.chess.com');
    assert.equal(lastUpstreamWsPath, '/cometd');
  } finally {
    proxy.close();
    upstream.close();
  }
});
