import http from 'http';
import net from 'net';
import tls from 'tls';
import { URL } from 'url';
import {
  HEALTH_PATH,
  RUNTIME_PATH,
  CLIENT_RUNTIME_SCRIPT,
  resolveIncomingTargetUrl,
  extractProxiedTarget,
  rewriteHtml,
  rewriteCss,
  rewriteSetCookie,
  computeUpstreamOrigin,
  stripInternalParams,
} from './src/rewriter.js';

const PORT = process.env.PORT || 3000;

function isIpAllowed(req) {
  if (!process.env.ALLOWED_IPS) return true;
  const allowedIps = process.env.ALLOWED_IPS.split(',').map((ip) => ip.trim()).filter(Boolean);
  if (allowedIps.length === 0) return true;
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientIp = forwardedFor ? forwardedFor.split(',')[0].trim() : req.socket.remoteAddress;
  return !clientIp || allowedIps.includes(clientIp);
}

function getCorsHeaders(req) {
  const reqOrigin = req.headers.origin;
  return {
    'access-control-allow-origin': reqOrigin || '*',
    'access-control-allow-credentials': reqOrigin ? 'true' : 'false',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD',
    'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

export function createProxyServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (!isIpAllowed(req)) {
        res.writeHead(403);
        return res.end('403 Forbidden: Your IP is not allowed to use this proxy.');
      }

      // Fast path for OPTIONS requests (CORS preflight)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, getCorsHeaders(req));
        return res.end();
      }

      const host = req.headers.host;
      const protocol = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const proxyBase = `${protocol}://${host}`;
      const isHttpsProxy = protocol === 'https';

      const url = new URL(req.url, proxyBase);

      // Health check endpoint for GitHub Pages frontend
      if (url.pathname === HEALTH_PATH) {
        res.writeHead(200, {
          'content-type': 'application/json',
          ...getCorsHeaders(req),
        });
        return res.end(JSON.stringify({ ok: true, runtime: 'node', websockets: true }));
      }

      // Static browser-cacheable client runtime
      if (url.pathname === RUNTIME_PATH) {
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'public, max-age=86400, immutable',
          ...getCorsHeaders(req),
        });
        return res.end(CLIENT_RUNTIME_SCRIPT);
      }

      // If root is accessed, show a clean launcher UI with Chess.com quick-launch
      if (url.pathname === '/' && !url.searchParams.has('url')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Web Proxy</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #1e1d1b; color: #f5f5f5; margin: 0; }
    .container { background: #2b2926; padding: 2rem; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.4); width: min(440px, 92vw); }
    h2 { margin: 0 0 1rem; font-size: 1.4rem; }
    form { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
    input[type="text"] { flex: 1; padding: 0.65rem 0.75rem; border: 1px solid #444; border-radius: 6px; background: #1e1d1b; color: #fff; font-size: 0.95rem; }
    button, a.btn { padding: 0.65rem 1rem; background: #81b64c; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; text-decoration: none; display: inline-block; text-align: center; }
    button:hover, a.btn:hover { background: #6fa03f; }
    .quick { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .quick a.btn { background: #3c3a37; font-size: 0.85rem; }
    .quick a.btn:hover { background: #4c4a46; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Web Proxy</h2>
    <form action="/" method="GET" id="proxy-form">
      <input type="text" name="url" placeholder="Enter URL (e.g. https://www.chess.com/play)" required>
      <button type="submit">Go</button>
    </form>
    <div class="quick">
      <a class="btn" href="/https://www.chess.com/play">♟ Play Chess.com</a>
      <a class="btn" href="/https://www.chess.com/play/computer">🤖 Play Bots</a>
      <a class="btn" href="/https://www.chess.com/puzzles">🧩 Puzzles</a>
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
</html>`);
      }

      const refererHeader = req.headers.referer;
      const resolved = resolveIncomingTargetUrl(url, refererHeader);
      if (resolved.error) {
        res.writeHead(resolved.status || 400);
        return res.end(resolved.error);
      }

      const { cleanedUrl: targetUrl, explicitOrigin } = stripInternalParams(resolved.targetUrl);

      // Construct upstream request headers
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase();
        if (
          lower === 'host' ||
          lower === 'origin' ||
          lower === 'referer' ||
          lower === 'connection' ||
          lower === 'keep-alive' ||
          lower === 'transfer-encoding' ||
          lower === 'x-forwarded-for' ||
          lower === 'x-forwarded-proto' ||
          lower === 'x-forwarded-host' ||
          lower === 'x-real-ip' ||
          lower.startsWith('cf-')
        ) {
          continue;
        }
        headers[key] = value;
      }

      const upstreamOrigin = computeUpstreamOrigin(targetUrl, refererHeader, explicitOrigin);
      if (req.headers.origin) {
        headers['origin'] = upstreamOrigin;
      }
      if (refererHeader) {
        const refTarget = extractProxiedTarget(refererHeader);
        headers['referer'] = refTarget ? refTarget.href : targetUrl.origin + '/';
      }

      const fetchOptions = {
        method: req.method,
        headers,
        redirect: 'manual',
      };

      if (!['GET', 'HEAD'].includes(req.method)) {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        if (chunks.length > 0) {
          fetchOptions.body = Buffer.concat(chunks);
        }
      }

      let response;
      try {
        response = await fetch(targetUrl.href, fetchOptions);
      } catch (e) {
        res.writeHead(502);
        return res.end('Error fetching target URL: ' + e.message);
      }

      const responseHeaders = {};
      for (const [key, value] of response.headers.entries()) {
        const lower = key.toLowerCase();
        if (lower === 'set-cookie') continue; // handled separately via getSetCookie()
        responseHeaders[lower] = value;
      }

      // Preserve and rewrite ALL Set-Cookie headers
      const setCookies =
        typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : response.headers.has('set-cookie')
            ? [response.headers.get('set-cookie')]
            : [];

      if (setCookies.length > 0) {
        responseHeaders['set-cookie'] = setCookies.map((c) => rewriteSetCookie(c, isHttpsProxy));
      }

      // Strip restrictive security/frame headers
      delete responseHeaders['x-frame-options'];
      delete responseHeaders['content-security-policy'];
      delete responseHeaders['content-security-policy-report-only'];
      delete responseHeaders['clear-site-data'];
      delete responseHeaders['cross-origin-embedder-policy'];
      delete responseHeaders['cross-origin-opener-policy'];
      delete responseHeaders['cross-origin-resource-policy'];
      delete responseHeaders['strict-transport-security'];

      // Node fetch auto-decompresses responses; remove content-encoding/transfer-encoding to prevent ERR_CONTENT_DECODING_FAILED
      delete responseHeaders['content-encoding'];
      delete responseHeaders['transfer-encoding'];

      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = responseHeaders['location'];
        if (location) {
          try {
            const redirectUrl = new URL(location, targetUrl.href);
            responseHeaders['location'] = `${proxyBase}/${redirectUrl.href}`;
          } catch {
            // ignore
          }
        }
      }

      // Apply CORS headers
      Object.assign(responseHeaders, getCorsHeaders(req));

      const contentType = (responseHeaders['content-type'] || '').toLowerCase();

      if (contentType.includes('text/html')) {
        const html = await response.text();
        const rewritten = rewriteHtml(html, targetUrl.href, proxyBase);
        delete responseHeaders['content-length'];
        res.writeHead(response.status, responseHeaders);
        return res.end(rewritten);
      }

      if (contentType.includes('text/css')) {
        const css = await response.text();
        const rewritten = rewriteCss(css, targetUrl.href, proxyBase);
        delete responseHeaders['content-length'];
        res.writeHead(response.status, responseHeaders);
        return res.end(rewritten);
      }

      // Remove content-length since Node fetch decompressed the stream
      delete responseHeaders['content-length'];
      res.writeHead(response.status, responseHeaders);

      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } else {
        res.end();
      }
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end('Internal Server Error');
    }
  });

  // Zero-dependency WebSocket upgrade proxy (essential for Chess.com live games!)
  server.on('upgrade', (req, clientSocket, head) => {
    if (!isIpAllowed(req)) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return clientSocket.destroy();
    }

    const host = req.headers.host || 'localhost';
    const protocol = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const proxyBase = `${protocol}://${host}`;

    let reqUrl;
    try {
      reqUrl = new URL(req.url, proxyBase);
    } catch {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      return clientSocket.destroy();
    }

    const refererHeader = req.headers.referer;
    const resolved = resolveIncomingTargetUrl(reqUrl, refererHeader);
    if (resolved.error) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      return clientSocket.destroy();
    }

    const { cleanedUrl: targetUrl, explicitOrigin } = stripInternalParams(resolved.targetUrl);
    const isTls = targetUrl.protocol === 'wss:' || targetUrl.protocol === 'https:';
    const port = Number(targetUrl.port) || (isTls ? 443 : 80);

    const upstreamOrigin = computeUpstreamOrigin(targetUrl, refererHeader, explicitOrigin);

    const upstreamSocket = isTls
      ? tls.connect({ host: targetUrl.hostname, port, servername: targetUrl.hostname })
      : net.connect({ host: targetUrl.hostname, port });

    const onConnect = () => {
      const pathAndQuery = (targetUrl.pathname || '/') + (targetUrl.search || '');
      const headerLines = [`GET ${pathAndQuery} HTTP/1.1`, `Host: ${targetUrl.host}`, `Origin: ${upstreamOrigin}`];

      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase();
        if (
          lower === 'host' ||
          lower === 'origin' ||
          lower === 'referer' ||
          lower === 'x-forwarded-for' ||
          lower === 'x-forwarded-proto' ||
          lower === 'x-forwarded-host' ||
          lower === 'x-real-ip' ||
          lower.startsWith('cf-')
        ) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const v of value) headerLines.push(`${key}: ${v}`);
        } else if (value !== undefined) {
          headerLines.push(`${key}: ${value}`);
        }
      }

      upstreamSocket.write(headerLines.join('\r\n') + '\r\n\r\n');
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }

      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    };

    if (isTls) {
      upstreamSocket.once('secureConnect', onConnect);
    } else {
      upstreamSocket.once('connect', onConnect);
    }

    const cleanup = () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };

    upstreamSocket.on('error', (err) => {
      console.error('WebSocket upstream error:', err.message);
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      cleanup();
    });

    clientSocket.on('error', cleanup);
    upstreamSocket.on('close', cleanup);
    clientSocket.on('close', cleanup);
  });

  return server;
}

// Start listening only when run directly
const isMain = process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;
if (isMain) {
  const server = createProxyServer();
  server.listen(PORT, () => {
    console.log(`Proxy server listening on port ${PORT}`);
  });
}
