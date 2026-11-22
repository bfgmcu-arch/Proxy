import {
  HEALTH_PATH,
  RUNTIME_PATH,
  CLIENT_RUNTIME_SCRIPT,
  isStaticAssetUrl,
  resolveIncomingTargetUrl,
  extractProxiedTarget,
  rewriteUrl,
  rewriteSrcset,
  rewriteHtml,
  rewriteCss,
  rewriteSetCookie,
  computeUpstreamOrigin,
  stripInternalParams,
} from './rewriter.js';

const MAX_CSS_REWRITE_BYTES = 1_500_000;
const STATIC_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

function corsHeaders(request) {
  const reqOrigin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': reqOrigin || '*',
    'Access-Control-Allow-Credentials': reqOrigin ? 'true' : 'false',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * Rewrite an HTML Response using Cloudflare's native Rust streaming HTMLRewriter.
 * Uses <1ms CPU and near-zero memory (stays well within the 10ms Free Tier limit).
 */
function streamRewriteHtml(response, baseUrl, proxyBase) {
  const runtimeTag = `<script src="${proxyBase}${RUNTIME_PATH}"></script>`;
  let runtimeInjected = false;

  const rewriteAttr = (attrName, isSrcset = false) => ({
    element(el) {
      const val = el.getAttribute(attrName);
      if (!val) return;
      const next = isSrcset
        ? rewriteSrcset(val, baseUrl, proxyBase)
        : rewriteUrl(val, baseUrl, proxyBase);
      if (next !== val) el.setAttribute(attrName, next);
    },
  });

  let styleBuf = '';

  const rewriter = new HTMLRewriter()
    .on('head', {
      element(el) {
        if (!runtimeInjected) {
          runtimeInjected = true;
          el.prepend(runtimeTag, { html: true });
        }
      },
    })
    .on('body', {
      element(el) {
        if (!runtimeInjected) {
          runtimeInjected = true;
          el.prepend(runtimeTag, { html: true });
        }
      },
    })
    .on('meta[http-equiv]', {
      element(el) {
        const equiv = (el.getAttribute('http-equiv') || '').toLowerCase();
        if (equiv === 'content-security-policy') {
          el.remove();
        }
      },
    })
    .on('script[integrity], link[integrity]', {
      element(el) {
        el.removeAttribute('integrity');
      },
    })
    .on('a[href], link[href], area[href], base[href]', rewriteAttr('href'))
    .on(
      'script[src], img[src], iframe[src], source[src], audio[src], video[src], embed[src], track[src], input[src]',
      rewriteAttr('src')
    )
    .on('form[action]', rewriteAttr('action'))
    .on('video[poster]', rewriteAttr('poster'))
    .on('[data-src]', rewriteAttr('data-src'))
    .on('img[srcset], source[srcset]', rewriteAttr('srcset', true))
    .on('style', {
      element() {
        styleBuf = '';
      },
      text(chunk) {
        styleBuf += chunk.text;
        if (chunk.lastInTextNode) {
          if (styleBuf.indexOf('url(') !== -1 || styleBuf.indexOf('@import') !== -1) {
            chunk.replace(rewriteCss(styleBuf, baseUrl, proxyBase));
          }
          styleBuf = '';
        } else {
          chunk.remove();
        }
      },
    });

  return rewriter.transform(response);
}

export default {
  async fetch(request, env, ctx) {
    // 1. Optional IP allowlist
    if (env && env.ALLOWED_IPS) {
      const allowedIps = env.ALLOWED_IPS.split(',').map((ip) => ip.trim()).filter(Boolean);
      const clientIp = request.headers.get('cf-connecting-ip');
      if (allowedIps.length > 0 && clientIp && !allowedIps.includes(clientIp)) {
        return new Response('403 Forbidden: Your IP is not allowed to use this proxy.', {
          status: 403,
        });
      }
    }

    // 2. Fast path: CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const proxyBase = url.origin;
    const isHttpsProxy = url.protocol === 'https:';

    // 3. Fast path: Health check
    if (url.pathname === HEALTH_PATH) {
      return new Response(
        JSON.stringify({
          ok: true,
          runtime: 'cloudflare-worker',
          websockets: true,
          streamingHtml: typeof HTMLRewriter !== 'undefined',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(request),
          },
        }
      );
    }

    // 4. Fast path: Static cached client runtime (0 upstream fetch, browser-cached 24h)
    if (url.pathname === RUNTIME_PATH) {
      return new Response(CLIENT_RUNTIME_SCRIPT, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=86400, immutable',
          ...corsHeaders(request),
        },
      });
    }

    // 5. Root launcher UI
    if (url.pathname === '/' && !url.searchParams.has('url')) {
      return new Response(
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudflare Web Proxy</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #161512; color: #ecebe8; margin: 0; }
    .container { background: #262421; border: 1px solid #3a3733; padding: 2rem; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.45); width: min(460px, 92vw); }
    h2 { margin: 0 0 0.4rem; font-size: 1.35rem; }
    p { margin: 0 0 1rem; color: #a6a39e; font-size: 0.85rem; }
    form { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
    input[type="text"] { flex: 1; padding: 0.65rem 0.75rem; border: 1px solid #3a3733; border-radius: 6px; background: #161512; color: #fff; font-size: 0.92rem; }
    button, a.btn { padding: 0.65rem 1rem; background: #81b64c; color: #161512; border: none; border-radius: 6px; cursor: pointer; font-weight: 700; text-decoration: none; display: inline-block; text-align: center; }
    button:hover, a.btn:hover { background: #95cc5d; }
    .quick { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .quick a.btn { background: #33302c; color: #ecebe8; font-size: 0.84rem; font-weight: 600; border: 1px solid #3a3733; }
    .quick a.btn:hover { background: #403d38; }
  </style>
</head>
<body>
  <div class="container">
    <h2>🌐 Cloudflare Web Proxy</h2>
    <p>All Websites Allowed • Streaming HTMLRewriter • WebSockets • Edge Asset Cache</p>
    <form action="/" method="GET" id="proxy-form">
      <input type="text" name="url" placeholder="Enter any URL (e.g. https://www.chess.com/play)" required>
      <button type="submit">Go</button>
    </form>
    <div class="quick">
      <a class="btn" href="/https://www.chess.com/play">♟ Chess.com</a>
      <a class="btn" href="/https://www.chess.com/play/computer">🤖 Bots</a>
      <a class="btn" href="/https://www.chess.com/puzzles">🧩 Puzzles</a>
      <a class="btn" href="/https://www.wikipedia.org">📚 Wikipedia</a>
    </div>
    <script>
      document.getElementById('proxy-form').addEventListener('submit', function(e) {
        e.preventDefault();
        var targetUrl = document.querySelector('input[name="url"]').value.trim();
        if (!/^https?:\\/\\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;
        window.location.href = '/' + targetUrl;
      });
    </script>
  </div>
</body>
</html>`,
        {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
          },
        }
      );
    }

    // 6. Resolve target URL
    const refererHeader = request.headers.get('Referer');
    const resolved = resolveIncomingTargetUrl(url, refererHeader);
    if (resolved.error) {
      return new Response(resolved.error, { status: resolved.status || 400 });
    }

    const { cleanedUrl: targetUrl, explicitOrigin } = stripInternalParams(resolved.targetUrl);
    const isWebSocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    const fetchUrl = new URL(targetUrl.href);
    if (fetchUrl.protocol === 'ws:') fetchUrl.protocol = 'http:';
    if (fetchUrl.protocol === 'wss:') fetchUrl.protocol = 'https:';

    // 7. Check Cloudflare Edge Cache for GET static assets
    const isCacheableStatic =
      request.method === 'GET' && !isWebSocket && isStaticAssetUrl(fetchUrl);
    const edgeCache =
      isCacheableStatic && typeof caches !== 'undefined' && caches.default ? caches.default : null;
    const cacheKey = edgeCache ? new Request(url.href, { method: 'GET' }) : null;

    if (edgeCache && cacheKey) {
      try {
        const cached = await edgeCache.match(cacheKey);
        if (cached) return cached;
      } catch {
        // Ignore cache errors on workers.dev
      }
    }

    // 9. Build upstream request headers
    const newHeaders = new Headers(request.headers);
    newHeaders.set('Host', fetchUrl.host);

    const upstreamOrigin = computeUpstreamOrigin(fetchUrl, refererHeader, explicitOrigin);
    if (request.headers.has('Origin') || isWebSocket) {
      newHeaders.set('Origin', upstreamOrigin);
    }

    if (refererHeader) {
      const refTarget = extractProxiedTarget(refererHeader);
      newHeaders.set('Referer', refTarget ? refTarget.href : fetchUrl.origin + '/');
    }

    // Strip proxy/CF identifying headers
    newHeaders.delete('cf-connecting-ip');
    newHeaders.delete('cf-ipcountry');
    newHeaders.delete('cf-visitor');
    newHeaders.delete('cf-ray');
    newHeaders.delete('cf-worker');
    newHeaders.delete('x-forwarded-for');
    newHeaders.delete('x-forwarded-proto');
    newHeaders.delete('x-real-ip');

    // Strip cookies on static CDN assets to maximize edge cache hits & reduce upstream payload
    if (isCacheableStatic && fetchUrl.hostname.toLowerCase().endsWith('chesscomfiles.com')) {
      newHeaders.delete('cookie');
    }

    // 10. WebSocket passthrough (Chess.com live games)
    if (isWebSocket) {
      try {
        const wsResp = await fetch(fetchUrl.href, { headers: newHeaders });
        if (wsResp.webSocket) {
          return new Response(null, { status: 101, webSocket: wsResp.webSocket });
        }
        return wsResp;
      } catch (e) {
        return new Response('WebSocket proxy error: ' + e.message, { status: 502 });
      }
    }

    // 11. Fetch upstream (enable Cloudflare edge caching for static assets)
    const fetchInit = {
      method: request.method,
      headers: newHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
      redirect: 'manual',
    };
    if (isCacheableStatic) {
      fetchInit.cf = { cacheTtl: 86400, cacheEverything: true };
    }

    let response;
    try {
      response = await fetch(fetchUrl.href, fetchInit);
    } catch (e) {
      return new Response('Error fetching target URL: ' + e.message, { status: 502 });
    }

    const responseHeaders = new Headers(response.headers);

    // Strip restrictive security/frame headers
    responseHeaders.delete('x-frame-options');
    responseHeaders.delete('content-security-policy');
    responseHeaders.delete('content-security-policy-report-only');
    responseHeaders.delete('clear-site-data');
    responseHeaders.delete('cross-origin-embedder-policy');
    responseHeaders.delete('cross-origin-opener-policy');
    responseHeaders.delete('cross-origin-resource-policy');
    responseHeaders.delete('strict-transport-security');

    // Rewrite Set-Cookie headers
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : response.headers.has('set-cookie')
          ? [response.headers.get('set-cookie')]
          : [];

    if (setCookies.length > 0) {
      responseHeaders.delete('set-cookie');
      for (const cookie of setCookies) {
        responseHeaders.append('set-cookie', rewriteSetCookie(cookie, isHttpsProxy));
      }
    }

    // Rewrite redirects
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = responseHeaders.get('location');
      if (location) {
        try {
          const redirectUrl = new URL(location, fetchUrl.href);
          responseHeaders.set('location', `${proxyBase}/${redirectUrl.href}`);
        } catch {
          // ignore
        }
      }
    }

    // Apply CORS headers
    const cors = corsHeaders(request);
    for (const [k, v] of Object.entries(cors)) {
      responseHeaders.set(k, v);
    }

    // Encourage aggressive browser & edge caching on static assets without cookies
    const shouldCacheResponse =
      isCacheableStatic && response.status === 200 && setCookies.length === 0;
    if (shouldCacheResponse) {
      responseHeaders.set('Cache-Control', STATIC_CACHE_CONTROL);
    }

    const contentType = (responseHeaders.get('content-type') || '').toLowerCase();

    // 12. Streaming HTML rewriting via native Cloudflare HTMLRewriter
    if (contentType.includes('text/html')) {
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
      const baseResp = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });

      if (typeof HTMLRewriter !== 'undefined') {
        return streamRewriteHtml(baseResp, fetchUrl.href, proxyBase);
      }
      const html = await baseResp.text();
      return new Response(rewriteHtml(html, fetchUrl.href, proxyBase), {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    // 13. Size-guarded fast CSS rewriting (cached after first rewrite)
    if (contentType.includes('text/css')) {
      const contentLen = Number(responseHeaders.get('content-length') || '0');
      if (contentLen <= MAX_CSS_REWRITE_BYTES) {
        const css = await response.text();
        const rewritten = rewriteCss(css, fetchUrl.href, proxyBase);
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
        const outResp = new Response(rewritten, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
        if (shouldCacheResponse && edgeCache && cacheKey && ctx && ctx.waitUntil) {
          ctx.waitUntil(edgeCache.put(cacheKey, outResp.clone()).catch(() => {}));
        }
        return outResp;
      }
    }

    // 14. Zero-copy streaming for all other assets (JS, WASM, PNG, SVG, MP3, JSON, fonts)
    const outResp = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

    if (shouldCacheResponse && edgeCache && cacheKey && ctx && ctx.waitUntil) {
      ctx.waitUntil(edgeCache.put(cacheKey, outResp.clone()).catch(() => {}));
    }

    return outResp;
  },
};
