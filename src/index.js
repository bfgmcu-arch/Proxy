export default {
  async fetch(request, env, ctx) {
    // Fast path for OPTIONS requests (CORS preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    const url = new URL(request.url);
    const proxyBase = url.origin;

    // If root is accessed, show a simple UI
    if (url.pathname === '/' && !url.searchParams.has('url')) {
      return new Response(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Cloudflare Web Proxy</title>
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
      `, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    let targetUrlStr = url.pathname.substring(1) + url.search;

    // Support ?url= fallback
    if (url.pathname === '/' && url.searchParams.has('url')) {
        targetUrlStr = url.searchParams.get('url');
    }

    if (!targetUrlStr) {
      return new Response('Invalid URL', { status: 400 });
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetUrlStr);
    } catch (e) {
      // Relative URL fallback via Referer
      const referer = request.headers.get('Referer');
      if (referer) {
        try {
          const refererUrl = new URL(referer);
          let baseRefererTarget = refererUrl.pathname.substring(1);
          if (baseRefererTarget) {
            try {
              const baseTargetUrl = new URL(baseRefererTarget);
              targetUrl = new URL(targetUrlStr, baseTargetUrl.href);
            } catch (e2) {
               return new Response('Invalid URL or unable to resolve relative path', { status: 400 });
            }
          } else {
             return new Response('Invalid URL or unable to resolve relative path', { status: 400 });
          }
        } catch (e3) {
          return new Response('Invalid URL or unable to resolve relative path', { status: 400 });
        }
      } else {
        return new Response('Invalid URL: ' + targetUrlStr, { status: 400 });
      }
    }

    // Construct new request headers
    const newHeaders = new Headers(request.headers);
    newHeaders.delete('Origin');
    newHeaders.delete('Referer');
    newHeaders.set('Host', targetUrl.host);

    // Some sites check CF headers
    newHeaders.delete('cf-connecting-ip');
    newHeaders.delete('cf-ipcountry');
    newHeaders.delete('cf-visitor');
    newHeaders.delete('cf-ray');
    newHeaders.delete('x-forwarded-for');
    newHeaders.delete('x-forwarded-proto');
    newHeaders.delete('x-real-ip');

    // Make the fetch request to the target URL
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: newHeaders,
      body: request.body,
      redirect: 'manual' // We handle redirects manually to rewrite them
    });

    let response;
    try {
      response = await fetch(proxyRequest);
    } catch (e) {
      return new Response('Error fetching target URL: ' + e.message, { status: 502 });
    }

    let responseHeaders = new Headers(response.headers);

    // Strip restrictive headers
    responseHeaders.delete('x-frame-options');
    responseHeaders.delete('content-security-policy');
    responseHeaders.delete('content-security-policy-report-only');
    responseHeaders.delete('clear-site-data');

    // Handle redirects
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = responseHeaders.get('location');
      if (location) {
        try {
          // Resolve relative redirects
          const redirectUrl = new URL(location, targetUrl.href);
          // Rewrite the location to point back to our proxy
          responseHeaders.set('location', `${proxyBase}/${redirectUrl.href}`);
        } catch (e) {
          // Ignore
        }
      }
    }

    // Inject base tag for HTML responses without using HTMLRewriter (using streaming)
    // Wait, the prompt says "removes HTMLRewriter". We should remove HTMLRewriter entirely and just pass through.
    // If we just pass through, relative links will hit our proxy and use the Referer fallback.
    // This is super lightweight.

    responseHeaders.set('Access-Control-Allow-Origin', '*');

    // Return direct stream
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  }
};
