import {
  PREFIX,
  HEALTH_PATH,
  RUNTIME_PATH,
  SW_PATH,
  CLIENT_RUNTIME_SCRIPT,
  SERVICE_WORKER_SCRIPT,
  isStreamingMediaUrl,
  isCookieFreeCdn,
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
    'Access-Control-Expose-Headers': '*',
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
          const out =
            styleBuf.indexOf('url(') !== -1 || styleBuf.indexOf('@import') !== -1
              ? rewriteCss(styleBuf, baseUrl, proxyBase)
              : styleBuf;
          chunk.replace(out);
          styleBuf = '';
        } else {
          chunk.remove();
        }
      },
    });

  return rewriter.transform(response);
}

/**
 * Render a tiny bootstrapper page that ensures /__proxy_sw.js is registered & active
 * before navigating to the proxied site (jsproxy pattern).
 */
function renderSwBootstrapPage(targetUrl) {
  const safeTarget = JSON.stringify(PREFIX + targetUrl);
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Loading…</title>
  <style>body{background:#161512;color:#ecebe8;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;}</style>
</head>
<body>
  <p id="s">Starting proxy service worker…</p>
  <script>
    (async function () {
      var dest = ${safeTarget};
      try {
        if ('serviceWorker' in navigator) {
          await navigator.serviceWorker.register('${SW_PATH}', { scope: '/' });
          await navigator.serviceWorker.ready;
        }
      } catch (e) {}
      location.replace(dest);
    })();
  </script>
</body>
</html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }
  );
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
          serviceWorker: true,
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

    // 4. Fast path: Service Worker script (jsproxy-style full network interception)
    if (url.pathname === SW_PATH) {
      return new Response(SERVICE_WORKER_SCRIPT, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Service-Worker-Allowed': '/',
          'Cache-Control': 'public, max-age=3600',
          ...corsHeaders(request),
        },
      });
    }

    // 5. Fast path: Static cached client runtime
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

    // 6. Fast path: Service Worker bootstrapper (/ __proxy_go?url=...)
    if (url.pathname === '/__proxy_go' && url.searchParams.has('url')) {
      let dest = (url.searchParams.get('url') || '').trim();
      if (!/^https?:\/\//i.test(dest)) dest = 'https://' + dest;
      return renderSwBootstrapPage(dest);
    }

    // 7. Root launcher UI (registers Service Worker before navigating!)
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
    .sw-status { margin-top: 0.85rem; font-size: 0.78rem; color: #81b64c; }
  </style>
</head>
<body>
  <div class="container">
    <h2>🌐 Cloudflare Web Proxy</h2>
    <p>All Websites • Service Worker Engine • YouTube &amp; Chess.com Ready</p>
    <form action="/" method="GET" id="proxy-form">
      <input type="text" name="url" placeholder="Enter any URL (e.g. https://www.youtube.com)" required>
      <button type="submit">Go</button>
    </form>
    <div class="quick">
      <a class="btn" data-url="https://www.youtube.com" href="/__proxy_go?url=https%3A%2F%2Fwww.youtube.com">▶ YouTube</a>
      <a class="btn" data-url="https://www.chess.com/play" href="/__proxy_go?url=https%3A%2F%2Fwww.chess.com%2Fplay">♟ Chess.com</a>
      <a class="btn" data-url="https://www.wikipedia.org" href="/__proxy_go?url=https%3A%2F%2Fwww.wikipedia.org">📚 Wikipedia</a>
    </div>
    <div class="sw-status" id="sw-status">Initializing Service Worker…</div>
    <script>
      var swReady = (async function () {
        var el = document.getElementById('sw-status');
        try {
          if ('serviceWorker' in navigator) {
            await navigator.serviceWorker.register('${SW_PATH}', { scope: '/' });
            await navigator.serviceWorker.ready;
            el.textContent = '✓ Service Worker active — ready for YouTube & all sites';
          } else {
            el.textContent = 'Service Worker unavailable (using fallback mode)';
          }
        } catch (e) {
          el.textContent = 'Service Worker fallback mode';
        }
      })();

      async function go(targetUrl) {
        await swReady;
        targetUrl = targetUrl.trim();
        if (!/^https?:\\/\\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;
        window.location.href = '${PREFIX}' + targetUrl;
      }

      document.getElementById('proxy-form').addEventListener('submit', function(e) {
        e.preventDefault();
        go(document.querySelector('input[name="url"]').value);
      });

      document.querySelectorAll('.quick a[data-url]').forEach(function(a) {
        a.addEventListener('click', function(e) {
          e.preventDefault();
          go(a.getAttribute('data-url'));
        });
      });
    </script>
  </div>
</body>
</html>`,
        {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=600',
          },
        }
      );
    }

    // 8. Resolve target URL
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

    const isStreamingMedia = isStreamingMediaUrl(fetchUrl);

    // 9. Check Cloudflare Edge Cache for GET static assets (never cache videoplayback streams)
    const isCacheableStatic =
      request.method === 'GET' && !isWebSocket && !isStreamingMedia && isStaticAssetUrl(fetchUrl);
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

    // 10. Build upstream request headers
    const newHeaders = new Headers(request.headers);
    newHeaders.set('Host', fetchUrl.host);

    const hostLower = fetchUrl.hostname.toLowerCase();
    const isGoogleVideo =
      hostLower === 'googlevideo.com' || hostLower.endsWith('.googlevideo.com');
    const isYouTube =
      hostLower === 'youtube.com' || hostLower.endsWith('.youtube.com');

    const upstreamOrigin = isGoogleVideo
      ? 'https://www.youtube.com'
      : computeUpstreamOrigin(fetchUrl, refererHeader, explicitOrigin);

    if (request.headers.has('Origin') || isWebSocket || isGoogleVideo) {
      newHeaders.set('Origin', upstreamOrigin);
    }

    // Rewrite YouTube InnerTube X-Origin header so API requests match upstream origin
    if (newHeaders.has('x-origin')) {
      newHeaders.set('x-origin', upstreamOrigin);
    }

    if (isGoogleVideo) {
      newHeaders.set('Referer', 'https://www.youtube.com/');
    } else if (refererHeader) {
      const refTarget = extractProxiedTarget(refererHeader);
      newHeaders.set('Referer', refTarget ? refTarget.href : fetchUrl.origin + '/');
    }

    // Prevent YouTube GDPR consent wall on European/cloud Cloudflare PoPs
    if (isYouTube) {
      const existingCookie = newHeaders.get('cookie') || '';
      if (!existingCookie.includes('CONSENT=')) {
        newHeaders.set(
          'cookie',
          existingCookie ? `${existingCookie}; CONSENT=YES+cb` : 'CONSENT=YES+cb'
        );
      }
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

    // Strip cookies on public static CDNs (ytimg, ggpht, chesscomfiles, gstatic) for max edge cache hits
    if (isCacheableStatic && isCookieFreeCdn(fetchUrl.hostname)) {
      newHeaders.delete('cookie');
    }

    // 11. WebSocket passthrough
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

    // 12. Fetch upstream (enable Cloudflare edge caching for static assets only)
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

    // Rewrite redirects to stay on /-----<url>
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = responseHeaders.get('location');
      if (location) {
        try {
          const redirectUrl = new URL(location, fetchUrl.href);
          responseHeaders.set('location', `${proxyBase}${PREFIX}${redirectUrl.href}`);
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

    // 13. Streaming HTML rewriting via native Cloudflare HTMLRewriter
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

    // 14. Size-guarded fast CSS rewriting (cached after first rewrite)
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

    // 15. Zero-copy streaming for all other assets (googlevideo.com, JS, WASM, PNG, SVG, MP3, JSON, fonts)
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
