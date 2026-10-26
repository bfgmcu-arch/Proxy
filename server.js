import http from 'http';
import { URL } from 'url';

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  try {
    // Fast path for OPTIONS requests (CORS preflight)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    const host = req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const proxyBase = `${protocol}://${host}`;

    // We use a dummy base for parsing the incoming URL path
    const url = new URL(req.url, proxyBase);

    // If root is accessed, show a simple UI
    if (url.pathname === '/' && !url.searchParams.has('url')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Web Proxy</title>
          <style>
            body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f0f0f0; margin: 0; }
            .container { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            input[type="text"] { width: 300px; padding: 0.5rem; margin-right: 0.5rem; border: 1px solid #ccc; border-radius: 4px; }
            button { padding: 0.5rem 1rem; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
            button:hover { background-color: #0056b3; }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>Web Proxy</h2>
            <form action="/" method="GET" id="proxy-form">
              <input type="text" name="url" placeholder="Enter URL (e.g. https://google.com)" required>
              <button type="submit">Go</button>
            </form>
            <script>
              document.getElementById('proxy-form').addEventListener('submit', function(e) {
                e.preventDefault();
                let targetUrl = document.querySelector('input[name="url"]').value;
                if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
                  targetUrl = 'https://' + targetUrl;
                }
                window.location.href = '/' + targetUrl;
              });
            </script>
          </div>
        </body>
        </html>
      `);
    }

    let targetUrlStr = url.pathname.substring(1) + url.search;

    // Support ?url= fallback
    if (url.pathname === '/' && url.searchParams.has('url')) {
        targetUrlStr = url.searchParams.get('url');
    }

    if (!targetUrlStr) {
      res.writeHead(400);
      return res.end('Invalid URL');
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetUrlStr);
    } catch (e) {
      // Relative URL fallback via Referer
      const referer = req.headers.referer;
      if (referer) {
        try {
          const refererUrl = new URL(referer);
          let baseRefererTarget = refererUrl.pathname.substring(1);
          if (baseRefererTarget) {
            try {
              const baseTargetUrl = new URL(baseRefererTarget);
              targetUrl = new URL(targetUrlStr, baseTargetUrl.href);
            } catch (e2) {
              res.writeHead(400);
              return res.end('Invalid URL or unable to resolve relative path');
            }
          } else {
            res.writeHead(400);
            return res.end('Invalid URL or unable to resolve relative path');
          }
        } catch (e3) {
          res.writeHead(400);
          return res.end('Invalid URL or unable to resolve relative path');
        }
      } else {
        res.writeHead(400);
        return res.end('Invalid URL: ' + targetUrlStr);
      }
    }

    // Construct new request headers
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.origin;
    delete headers.referer;
    // Typical proxy headers to delete
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-proto'];
    delete headers['x-real-ip'];

    const fetchOptions = {
      method: req.method,
      headers: headers,
      redirect: 'manual' // Handle redirects manually
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      // Read the request body
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      fetchOptions.body = Buffer.concat(chunks);
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
      responseHeaders[key.toLowerCase()] = value;
    }

    // Strip restrictive headers
    delete responseHeaders['x-frame-options'];
    delete responseHeaders['content-security-policy'];
    delete responseHeaders['content-security-policy-report-only'];
    delete responseHeaders['clear-site-data'];

    // Handle redirects
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = responseHeaders['location'];
      if (location) {
        try {
          const redirectUrl = new URL(location, targetUrl.href);
          responseHeaders['location'] = `${proxyBase}/${redirectUrl.href}`;
        } catch (e) {
          // Ignore
        }
      }
    }

    responseHeaders['access-control-allow-origin'] = '*';

    // Remove chunked encoding header if present, let node http handle it
    delete responseHeaders['transfer-encoding'];
    // Content-encoding issues can occur if we pass through compression headers but node alters the stream,
    // however since we are streaming directly from fetch body, passing them is usually fine.

    res.writeHead(response.status, responseHeaders);

    // Stream the response directly using Node.js readable stream from Web Streams
    if (response.body) {
      // Convert web stream to node stream
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

server.listen(PORT, () => {
  console.log(`Proxy server listening on port ${PORT}`);
});
