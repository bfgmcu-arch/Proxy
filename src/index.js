export default {
  async fetch(request, env, ctx) {
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
                // Redirect to /<url>
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
              // Try to find the original target URL that the referer points to
              // For example, referer is https://proxy.com/https://example.com/page
              // baseRefererTarget is https://example.com/page
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

    let response = await fetch(proxyRequest);
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
          // If we can't parse it, leave it or remove it
        }
      }
    }

    let finalResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });

    // Check if the response is HTML, if so, we can rewrite links
    const contentType = responseHeaders.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const rewriteAttribute = (element, attributeName) => {
        const val = element.getAttribute(attributeName);
        if (val && !val.startsWith('data:') && !val.startsWith('javascript:') && !val.startsWith('#')) {
          try {
            const resolvedUrl = new URL(val, targetUrl.href);
            element.setAttribute(attributeName, `${proxyBase}/${resolvedUrl.href}`);
          } catch (e) {
            // Ignore invalid URLs
          }
        }
      };

      class AttributeRewriter {
        element(element) {
          if (element.tagName === 'a' || element.tagName === 'link') {
            rewriteAttribute(element, 'href');
          } else if (element.tagName === 'img' || element.tagName === 'script' || element.tagName === 'iframe') {
            rewriteAttribute(element, 'src');
          } else if (element.tagName === 'form') {
            rewriteAttribute(element, 'action');
          }
        }
      }

      // Inject base tag so that relative links that weren't caught (e.g. by JS) also point to our proxy
      class HeadRewriter {
        element(element) {
            // We use JS to dynamically change base for the document so it knows its "base" is the target URL.
            // Wait, actually setting `<base href="...proxy.../target">` might break relative paths for things.
            // The simplest approach is to rewrite links. Let's just append a base tag for the proxy+target
            element.append(`<base href="${proxyBase}/${targetUrl.href}">`, { html: true });
        }
      }

      finalResponse = new HTMLRewriter()
        .on('a, link, img, script, iframe, form', new AttributeRewriter())
        .on('head', new HeadRewriter())
        .transform(finalResponse);
    }

    return finalResponse;
  }
};
