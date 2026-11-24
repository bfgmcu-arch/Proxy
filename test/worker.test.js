import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker, {
  getProxyConfig,
  isDiscordHost,
  isDiscordAppPath,
  isStreamingMediaUrl,
  isCookieFreeCdn,
  isStaticAssetUrl,
  normalizeTargetUrl,
  extractProxiedTarget,
  resolveIncomingTargetUrl,
  rewriteUrl,
  rewriteSrcset,
  rewriteCss,
  rewriteSetCookie,
  computeUpstreamOrigin,
  stripInternalParams,
} from '../src/index.js';

const {
  PREFIX,
  RUNTIME_PATH,
  SW_PATH,
  HEALTH_PATH,
  DISCORD_ORIGIN,
  SERVICE_WORKER_SCRIPT,
  CLIENT_RUNTIME_SCRIPT,
} = getProxyConfig();

// ============================================================================
// 1. Unit Tests: Discord Domains, Paths, CDNs, URL/CSS/Cookie Rewriting
// ============================================================================

test('isDiscordHost recognizes all Discord domains and rejects lookalikes', () => {
  const valid = [
    'discord.com',
    'ptb.discord.com',
    'canary.discord.com',
    'gateway.discord.gg',
    'remote-auth-gateway.discord.gg',
    'discord.gg',
    'cdn.discordapp.com',
    'media.discordapp.net',
    'images-ext-1.discordapp.net',
    'images-ext-2.discordapp.net',
    'us-east1.discord.media',
    'discordstatus.com',
    'dis.gd',
  ];
  for (const h of valid) {
    assert.equal(isDiscordHost(h), true, `Expected ${h} to be a Discord host`);
  }

  const invalid = [
    '',
    null,
    'example.com',
    'evil-discord.com',
    'discord.com.evil.com',
    'notdiscord.gg',
  ];
  for (const h of invalid) {
    assert.equal(isDiscordHost(h), false, `Expected ${h} NOT to be a Discord host`);
  }
});

test('isDiscordAppPath matches Discord app & auth routes and rejects proxy internals', () => {
  const valid = [
    '/login',
    '/register',
    '/app',
    '/channels/@me',
    '/channels/123456789/987654321',
    '/invite/my-server',
    '/oauth2/authorize',
    '/api/v9/auth/login',
    '/api/v9/auth/mfa/totp',
    '/api/v9/users/@me',
    '/assets/1234abcd.js',
    '/verify',
    '/reset',
    '/handoff',
  ];
  for (const p of valid) {
    assert.equal(isDiscordAppPath(p), true, `Expected ${p} to be a Discord app path`);
  }

  const invalid = ['/', '/__proxy_health', '/__proxy_sw.js', '/-----https://discord.com/login', '/random'];
  for (const p of invalid) {
    assert.equal(isDiscordAppPath(p), false, `Expected ${p} NOT to be a Discord app path`);
  }
});

test('CDN, static asset, and streaming classification helpers', () => {
  assert.equal(isCookieFreeCdn('cdn.discordapp.com'), true);
  assert.equal(isCookieFreeCdn('media.discordapp.net'), true);
  assert.equal(isCookieFreeCdn('images-ext-1.discordapp.net'), true);
  assert.equal(isCookieFreeCdn('discord.com'), false);

  assert.equal(isStaticAssetUrl(new URL('https://cdn.discordapp.com/avatars/1/abc.png')), true);
  assert.equal(isStaticAssetUrl(new URL('https://discord.com/assets/main.js')), true);
  assert.equal(isStaticAssetUrl(new URL('https://discord.com/api/v9/auth/login')), false);
  assert.equal(isStreamingMediaUrl(new URL('https://media.discordapp.net/stream/video.m3u8')), true);
});

test('resolveIncomingTargetUrl handles prefixed, query, referer-relative, and direct Discord paths', () => {
  const r1 = resolveIncomingTargetUrl(new URL('https://my.workers.dev/-----https://discord.com/login'), null);
  assert.equal(r1.targetUrl.href, 'https://discord.com/login');

  const r2 = resolveIncomingTargetUrl(new URL('https://my.workers.dev/?url=https://discord.com/app'), null);
  assert.equal(r2.targetUrl.href, 'https://discord.com/app');

  const r3 = resolveIncomingTargetUrl(
    new URL('https://my.workers.dev/api/v9/auth/login'),
    'https://my.workers.dev/-----https://ptb.discord.com/login'
  );
  assert.equal(r3.targetUrl.href, 'https://ptb.discord.com/api/v9/auth/login');

  const r4 = resolveIncomingTargetUrl(new URL('https://my.workers.dev/login'), null);
  assert.equal(r4.targetUrl.href, 'https://discord.com/login');

  const r5 = resolveIncomingTargetUrl(new URL('https://my.workers.dev/channels/@me'), null);
  assert.equal(r5.targetUrl.href, 'https://discord.com/channels/@me');

  const r6 = resolveIncomingTargetUrl(new URL('https://my.workers.dev/unknown-path'), null);
  assert.equal(r6.status, 400);
});

test('rewriteUrl, rewriteSrcset, rewriteCss, and normalizeTargetUrl handle Discord URLs', () => {
  const base = 'https://discord.com/login';
  const proxy = 'https://my.workers.dev';

  assert.equal(
    rewriteUrl('//discord.com/assets/app.js', base, proxy),
    'https://my.workers.dev/-----https://discord.com/assets/app.js'
  );
  assert.equal(
    rewriteUrl('/api/v9/auth/login', base, proxy),
    'https://my.workers.dev/-----https://discord.com/api/v9/auth/login'
  );
  assert.equal(
    rewriteUrl('wss://gateway.discord.gg/?v=9', base, proxy),
    'wss://my.workers.dev/-----wss://gateway.discord.gg/?v=9'
  );
  assert.equal(rewriteUrl('data:image/png;base64,AAA', base, proxy), 'data:image/png;base64,AAA');
  assert.equal(
    rewriteUrl('https://my.workers.dev/-----https://discord.com/app', base, proxy),
    'https://my.workers.dev/-----https://discord.com/app'
  );

  const srcset = rewriteSrcset(
    'https://cdn.discordapp.com/a.png 1x, https://cdn.discordapp.com/b.png 2x',
    base,
    proxy
  );
  assert.equal(
    srcset,
    'https://my.workers.dev/-----https://cdn.discordapp.com/a.png 1x, https://my.workers.dev/-----https://cdn.discordapp.com/b.png 2x'
  );

  const css = rewriteCss(
    '@import "/assets/theme.css"; .icon { background: url("https://cdn.discordapp.com/e.webp"); }',
    base,
    proxy
  );
  assert.match(css, /https:\/\/my\.workers\.dev\/-----https:\/\/discord\.com\/assets\/theme\.css/);
  assert.match(css, /https:\/\/my\.workers\.dev\/-----https:\/\/cdn\.discordapp\.com\/e\.webp/);

  assert.equal(normalizeTargetUrl('https:/discord.com/login'), 'https://discord.com/login');
  assert.equal(normalizeTargetUrl('wss:/gateway.discord.gg/'), 'wss://gateway.discord.gg/');
});

test('rewriteSetCookie strips Domain, normalizes Path, and adapts SameSite/Secure for HTTPS and HTTP', () => {
  const httpsCookie = rewriteSetCookie(
    '__sdcfduid=abc123; Domain=.discord.com; Path=/api; HttpOnly; SameSite=Lax; Secure',
    true
  );
  assert.doesNotMatch(httpsCookie, /Domain=/i);
  assert.match(httpsCookie, /^__sdcfduid=abc123;/);
  assert.match(httpsCookie, /\bPath=\//);
  assert.match(httpsCookie, /\bHttpOnly\b/);
  assert.match(httpsCookie, /\bSameSite=None\b/);
  assert.match(httpsCookie, /\bSecure\b/);

  const httpCookie = rewriteSetCookie(
    '__dcfduid=xyz789; Domain=.discord.com; Path=/; HttpOnly; Secure; SameSite=None; Partitioned',
    false
  );
  assert.doesNotMatch(httpCookie, /Domain=/i);
  assert.doesNotMatch(httpCookie, /\bSecure\b/i);
  assert.doesNotMatch(httpCookie, /\bPartitioned\b/i);
  assert.match(httpCookie, /\bSameSite=Lax\b/);
});

test('computeUpstreamOrigin and stripInternalParams enforce Discord origins', () => {
  const { cleanedUrl, explicitOrigin } = stripInternalParams(
    new URL('https://gateway.discord.gg/?v=9&__proxy_origin=https%3A%2F%2Fptb.discord.com')
  );
  assert.equal(cleanedUrl.href, 'https://gateway.discord.gg/?v=9');
  assert.equal(explicitOrigin, 'https://ptb.discord.com');

  assert.equal(
    computeUpstreamOrigin(cleanedUrl, null, explicitOrigin),
    'https://ptb.discord.com'
  );
  assert.equal(
    computeUpstreamOrigin(new URL('https://gateway.discord.gg/?v=9'), null, null),
    DISCORD_ORIGIN
  );
  assert.equal(
    computeUpstreamOrigin(new URL('https://canary.discord.com/login'), null, null),
    'https://canary.discord.com'
  );
});

// ============================================================================
// 2. Worker Infrastructure, Launcher, Health, SW, CORS, IP Allowlist
// ============================================================================

test('Worker serves Discord launcher, health check, SW, runtime, and bootstrap page', async () => {
  const root = await worker.fetch(new Request('https://my.workers.dev/'), {}, {});
  assert.equal(root.status, 200);
  const rootHtml = await root.text();
  assert.match(rootHtml, /Discord Proxy/);
  assert.match(rootHtml, /Sign In to Discord/);
  assert.match(rootHtml, /discord\.com\/login/);

  const health = await worker.fetch(new Request(`https://my.workers.dev${HEALTH_PATH}`), {}, {});
  assert.equal(health.status, 200);
  const hJson = await health.json();
  assert.equal(hJson.ok, true);
  assert.equal(hJson.discord, true);
  assert.equal(hJson.websockets, true);
  assert.equal(hJson.serviceWorker, true);

  const sw = await worker.fetch(new Request(`https://my.workers.dev${SW_PATH}`), {}, {});
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get('service-worker-allowed'), '/');

  const rt = await worker.fetch(new Request(`https://my.workers.dev${RUNTIME_PATH}`), {}, {});
  assert.equal(rt.status, 200);
  assert.match(rt.headers.get('cache-control'), /immutable/);

  const go = await worker.fetch(
    new Request('https://my.workers.dev/__proxy_go?url=discord.com/login'),
    {},
    {}
  );
  assert.equal(go.status, 200);
  assert.match(await go.text(), /var dest = "\/login";/);

  const goPtb = await worker.fetch(
    new Request('https://my.workers.dev/__proxy_go?url=ptb.discord.com/login'),
    {},
    {}
  );
  assert.equal(goPtb.status, 200);
  assert.match(await goPtb.text(), /\/-----https:\/\/ptb\.discord\.com\/login/);
});

test('Worker enforces ALLOWED_IPS and handles CORS preflight with Discord headers', async () => {
  const blocked = await worker.fetch(
    new Request('https://my.workers.dev/', { headers: { 'cf-connecting-ip': '1.2.3.4' } }),
    { ALLOWED_IPS: '5.6.7.8' },
    {}
  );
  assert.equal(blocked.status, 403);

  const allowed = await worker.fetch(
    new Request('https://my.workers.dev/', { headers: { 'cf-connecting-ip': '5.6.7.8' } }),
    { ALLOWED_IPS: '5.6.7.8' },
    {}
  );
  assert.equal(allowed.status, 200);

  const preflight = await worker.fetch(
    new Request('https://my.workers.dev/-----https://discord.com/api/v9/auth/login', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://my.workers.dev',
        'Access-Control-Request-Method': 'POST',
      },
    }),
    {},
    {}
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://my.workers.dev');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Super-Properties/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Captcha-Key/);
});

// ============================================================================
// 3. Rigorous End-to-End Discord Sign-In, MFA, Captcha, Gateway & CDN Tests
// ============================================================================

test('Discord Sign-In flow: /login page, cookies, POST /api/v9/auth/login, MFA TOTP, Captcha, and /users/@me', async () => {
  const origFetch = globalThis.fetch;
  const capturedCalls = [];

  globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    let bodyText = null;
    if (init && init.body) {
      bodyText = await new Response(init.body).text();
    }
    capturedCalls.push({
      url: urlStr,
      method: init?.method || 'GET',
      headers: new Headers(init?.headers || {}),
      bodyText,
    });

    if (urlStr === 'https://discord.com/login') {
      const headers = new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'",
        'Strict-Transport-Security': 'max-age=31536000',
      });
      headers.append('Set-Cookie', '__dcfduid=dcf123; Domain=.discord.com; Path=/; HttpOnly; Secure; SameSite=Lax');
      headers.append('Set-Cookie', '__sdcfduid=sdcf456; Domain=.discord.com; Path=/; HttpOnly; Secure; SameSite=Lax');
      return new Response('<html><head></head><body>Discord Login</body></html>', { status: 200, headers });
    }

    if (urlStr === 'https://discord.com/api/v9/auth/login') {
      const payload = JSON.parse(bodyText || '{}');
      if (payload.login === 'mfa@example.com') {
        return new Response(
          JSON.stringify({ user_id: '111', mfa: true, ticket: 'mfa-ticket-999', totp: true, sms: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (payload.login === 'captcha@example.com') {
        return new Response(
          JSON.stringify({ captcha_key: ['captcha-required'], captcha_sitekey: 'sitekey-abc', captcha_service: 'hcaptcha' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.append('Set-Cookie', '__cf_bm=bm789; Domain=.discord.com; Path=/; HttpOnly; Secure; SameSite=None');
      return new Response(
        JSON.stringify({ user_id: '12345', token: 'discord-session-token-ok', user_settings: { locale: 'en-US' } }),
        { status: 200, headers }
      );
    }

    if (urlStr === 'https://discord.com/api/v9/auth/mfa/totp') {
      const payload = JSON.parse(bodyText || '{}');
      assert.equal(payload.ticket, 'mfa-ticket-999');
      assert.equal(payload.code, '123456');
      return new Response(
        JSON.stringify({ token: 'discord-mfa-final-token', user_settings: { locale: 'en-US' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr === 'https://discord.com/api/v9/users/@me') {
      return new Response(
        JSON.stringify({ id: '12345', username: 'testuser', discriminator: '0' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not Found', { status: 404 });
  };

  try {
    // Step 1: Load /login page and verify security headers stripped + Set-Cookie rewritten
    const loginPageResp = await worker.fetch(
      new Request('https://my.workers.dev/-----https://discord.com/login', {
        headers: {
          'cf-connecting-ip': '9.9.9.9',
          'sec-fetch-site': 'same-origin',
        },
      }),
      {},
      {}
    );
    assert.equal(loginPageResp.status, 200);
    assert.equal(loginPageResp.headers.get('x-frame-options'), null);
    assert.equal(loginPageResp.headers.get('content-security-policy'), null);
    assert.equal(loginPageResp.headers.get('strict-transport-security'), null);

    const setCookies = loginPageResp.headers.getSetCookie();
    assert.equal(setCookies.length, 2);
    for (const c of setCookies) {
      assert.doesNotMatch(c, /Domain=/i);
      assert.match(c, /SameSite=None/);
      assert.match(c, /\bSecure\b/);
    }
    // Verify CF and sec-fetch headers were stripped before hitting Discord
    assert.equal(capturedCalls[0].headers.get('cf-connecting-ip'), null);
    assert.equal(capturedCalls[0].headers.get('sec-fetch-site'), null);
    assert.equal(capturedCalls[0].headers.get('host'), 'discord.com');

    // Step 2: Direct password sign-in via POST /-----https://discord.com/api/v9/auth/login
    const signInResp = await worker.fetch(
      new Request('https://my.workers.dev/-----https://discord.com/api/v9/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://my.workers.dev',
          Referer: 'https://my.workers.dev/-----https://discord.com/login',
          Cookie: '__dcfduid=dcf123; __sdcfduid=sdcf456',
          'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MifQ==',
        },
        body: JSON.stringify({ login: 'user@example.com', password: 'secret', undelete: false }),
      }),
      {},
      {}
    );
    assert.equal(signInResp.status, 200);
    const signInJson = await signInResp.json();
    assert.equal(signInJson.token, 'discord-session-token-ok');
    assert.equal(signInResp.headers.get('access-control-allow-origin'), 'https://my.workers.dev');

    const loginCall = capturedCalls[1];
    assert.equal(loginCall.headers.get('origin'), 'https://discord.com');
    assert.equal(loginCall.headers.get('referer'), 'https://discord.com/login');
    assert.equal(loginCall.headers.get('host'), 'discord.com');
    assert.equal(loginCall.headers.get('cookie'), '__dcfduid=dcf123; __sdcfduid=sdcf456');
    assert.equal(loginCall.headers.get('x-super-properties'), 'eyJvcyI6IldpbmRvd3MifQ==');

    // Step 3: MFA / 2FA TOTP challenge using direct Discord path (/api/v9/auth/login -> /api/v9/auth/mfa/totp)
    const mfaStartResp = await worker.fetch(
      new Request('https://my.workers.dev/api/v9/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: 'mfa@example.com', password: 'secret' }),
      }),
      {},
      {}
    );
    assert.equal(mfaStartResp.status, 200);
    const mfaStartJson = await mfaStartResp.json();
    assert.equal(mfaStartJson.mfa, true);
    assert.equal(mfaStartJson.ticket, 'mfa-ticket-999');

    const mfaTotpResp = await worker.fetch(
      new Request('https://my.workers.dev/api/v9/auth/mfa/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456', ticket: mfaStartJson.ticket }),
      }),
      {},
      {}
    );
    assert.equal(mfaTotpResp.status, 200);
    const mfaTotpJson = await mfaTotpResp.json();
    assert.equal(mfaTotpJson.token, 'discord-mfa-final-token');

    // Step 4: Captcha challenge passthrough (400 status & JSON preserved)
    const captchaResp = await worker.fetch(
      new Request('https://my.workers.dev/api/v9/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://my.workers.dev' },
        body: JSON.stringify({ login: 'captcha@example.com', password: 'secret' }),
      }),
      {},
      {}
    );
    assert.equal(captchaResp.status, 400);
    const captchaJson = await captchaResp.json();
    assert.deepEqual(captchaJson.captcha_key, ['captcha-required']);
    assert.equal(captchaResp.headers.get('access-control-allow-origin'), 'https://my.workers.dev');

    // Step 5: Authenticated /users/@me call with Authorization token
    const meResp = await worker.fetch(
      new Request('https://my.workers.dev/-----https://discord.com/api/v9/users/@me', {
        headers: { Authorization: 'discord-session-token-ok' },
      }),
      {},
      {}
    );
    assert.equal(meResp.status, 200);
    const meJson = await meResp.json();
    assert.equal(meJson.username, 'testuser');
    assert.equal(capturedCalls[capturedCalls.length - 1].headers.get('authorization'), 'discord-session-token-ok');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Discord Gateway WebSocket, Remote Auth QR WebSocket, Redirects, and Cookie-Free CDN', async () => {
  const origFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    const headers = new Headers(init?.headers || {});
    calls.push({ url: urlStr, headers, cf: init?.cf });

    if (urlStr.startsWith('https://gateway.discord.gg/') || urlStr.startsWith('https://remote-auth-gateway.discord.gg/')) {
      return new Response('ws-mock-ok', { status: 200 });
    }
    if (urlStr === 'https://discord.gg/testinvite') {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://discord.com/invite/testinvite' },
      });
    }
    if (urlStr === 'https://discord.com/assets/bad-worker-origin.js') {
      return new Response('Bad Worker Origin', { status: 400 });
    }
    if (urlStr.startsWith('https://cdn.discordapp.com/')) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }
    return new Response('ok', { status: 200 });
  };

  try {
    // 1. Gateway WebSocket
    await worker.fetch(
      new Request(
        'https://my.workers.dev/-----wss://gateway.discord.gg/?encoding=json&v=9&compress=zlib-stream&__proxy_origin=https%3A%2F%2Fdiscord.com',
        { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'cf-ray': '123' } }
      ),
      {},
      {}
    );
    assert.equal(calls[0].url, 'https://gateway.discord.gg/?encoding=json&v=9&compress=zlib-stream');
    assert.equal(calls[0].headers.get('origin'), 'https://discord.com');
    assert.equal(calls[0].headers.get('host'), 'gateway.discord.gg');
    assert.equal(calls[0].headers.get('cf-ray'), null);

    // 2. Remote Auth QR WebSocket (without explicit __proxy_origin, defaults to https://discord.com)
    await worker.fetch(
      new Request('https://my.workers.dev/-----wss://remote-auth-gateway.discord.gg/?v=2', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
      {},
      {}
    );
    assert.equal(calls[1].url, 'https://remote-auth-gateway.discord.gg/?v=2');
    assert.equal(calls[1].headers.get('origin'), 'https://discord.com');
    assert.equal(calls[1].headers.get('host'), 'remote-auth-gateway.discord.gg');

    // 3. Invite 302 redirect rewriting
    const redirResp = await worker.fetch(
      new Request('https://my.workers.dev/-----https://discord.gg/testinvite'),
      {},
      {}
    );
    assert.equal(redirResp.status, 302);
    assert.equal(
      redirResp.headers.get('location'),
      'https://my.workers.dev/-----https://discord.com/invite/testinvite'
    );

    // 4. Cookie-free Discord CDN strips Cookie, sets Cache-Control, and omits fetchInit.cf
    const cdnResp = await worker.fetch(
      new Request('https://my.workers.dev/-----https://cdn.discordapp.com/avatars/123/abc.png', {
        headers: { Cookie: '__dcfduid=secret' },
      }),
      {},
      { waitUntil() {} }
    );
    assert.equal(cdnResp.status, 200);
    assert.equal(calls[3].headers.get('cookie'), null);
    assert.equal(calls[3].cf, undefined);
    assert.match(cdnResp.headers.get('cache-control'), /max-age=86400/);

    // 5. Discord /assets/* 400 Bad Worker Origin falls back to 302 redirect
    const assetFallbackResp = await worker.fetch(
      new Request('https://my.workers.dev/-----https://discord.com/assets/bad-worker-origin.js'),
      {},
      {}
    );
    assert.equal(assetFallbackResp.status, 302);
    assert.equal(
      assetFallbackResp.headers.get('location'),
      'https://discord.com/assets/bad-worker-origin.js'
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ============================================================================
// 4. Client Runtime & Service Worker Syntax + VM Execution Tests
// ============================================================================

test('SERVICE_WORKER_SCRIPT and CLIENT_RUNTIME_SCRIPT parse cleanly and rewrite Discord browser APIs', () => {
  // Verify Service Worker script has valid JS syntax
  assert.doesNotThrow(() => new vm.Script(SERVICE_WORKER_SCRIPT));

  function runInMockBrowser(pathname) {
    const fetchCalls = [];
    const wsCalls = [];
    const xhrCalls = [];
    const historyCalls = [];
    const attrCalls = [];

    class MockRequest {
      constructor(url, init) {
        this.url = url;
        this.init = init;
      }
    }
    class MockWebSocket {
      constructor(url, protocols) {
        wsCalls.push({ url, protocols });
      }
    }
    MockWebSocket.CONNECTING = 0;
    MockWebSocket.OPEN = 1;
    MockWebSocket.CLOSING = 2;
    MockWebSocket.CLOSED = 3;

    class MockXHR {}
    MockXHR.prototype.open = function (method, url) {
      xhrCalls.push({ method, url });
    };

    class MockHistory {}
    MockHistory.prototype.pushState = function (state, title, url) {
      historyCalls.push({ fn: 'pushState', url });
    };
    MockHistory.prototype.replaceState = function (state, title, url) {
      historyCalls.push({ fn: 'replaceState', url });
    };

    class MockElement {}
    MockElement.prototype.setAttribute = function (k, v) {
      attrCalls.push({ k, v });
    };

    const sandbox = {
      URL,
      DOMException,
      location: {
        origin: 'https://my.workers.dev',
        href: `https://my.workers.dev${pathname}`,
        pathname,
        search: '',
        hash: '',
      },
      Request: MockRequest,
      fetch: (u, init) => {
        fetchCalls.push({ u, init });
        return Promise.resolve({ ok: true });
      },
      WebSocket: MockWebSocket,
      EventSource: function () {},
      Worker: function () {},
      XMLHttpRequest: MockXHR,
      History: MockHistory,
      Element: MockElement,
      HTMLScriptElement: { prototype: {} },
      HTMLImageElement: { prototype: {} },
      HTMLLinkElement: { prototype: {} },
      HTMLAnchorElement: { prototype: {} },
      HTMLFormElement: { prototype: {} },
      HTMLIFrameElement: { prototype: {} },
      HTMLSourceElement: { prototype: {} },
      HTMLMediaElement: { prototype: {} },
      navigator: { sendBeacon: () => true },
    };
    sandbox.window = sandbox;
    sandbox.history = new MockHistory();

    vm.runInNewContext(CLIENT_RUNTIME_SCRIPT, sandbox);
    return { sandbox, fetchCalls, wsCalls, xhrCalls, historyCalls, attrCalls };
  }

  // Case A: Page loaded via /-----https://discord.com/login
  const a = runInMockBrowser('/-----https://discord.com/login');
  a.sandbox.fetch('/api/v9/auth/login', { method: 'POST' });
  assert.equal(a.fetchCalls[0].u, 'https://my.workers.dev/-----https://discord.com/api/v9/auth/login');

  new a.sandbox.WebSocket('wss://gateway.discord.gg/?encoding=json&v=9');
  assert.equal(
    a.wsCalls[0].url,
    'wss://my.workers.dev/-----wss://gateway.discord.gg/?encoding=json&v=9&__proxy_origin=https%3A%2F%2Fdiscord.com'
  );

  const xhr = new a.sandbox.XMLHttpRequest();
  xhr.open('POST', '//discord.com/api/v9/auth/mfa/totp');
  assert.equal(xhrCallsCheck(a.xhrCalls[0].url), 'https://my.workers.dev/-----https://discord.com/api/v9/auth/mfa/totp');

  a.sandbox.history.pushState(null, '', '/channels/@me');
  assert.equal(a.historyCalls[0].url, '/channels/@me');

  const el = new a.sandbox.Element();
  el.setAttribute('src', '/assets/app.js');
  el.setAttribute('integrity', 'sha256-deadbeef');
  assert.equal(a.attrCalls.length, 1);
  assert.equal(a.attrCalls[0].v, 'https://my.workers.dev/-----https://discord.com/assets/app.js');

  // Case B: Page loaded via direct /login path on proxy origin
  const b = runInMockBrowser('/login');
  b.sandbox.fetch('/api/v9/auth/login', { method: 'POST' });
  assert.equal(b.fetchCalls[0].u, 'https://my.workers.dev/-----https://discord.com/api/v9/auth/login');
  b.sandbox.history.pushState(null, '', '/channels/@me');
  assert.equal(b.historyCalls[0].url, '/channels/@me');

  // Case C: Non-primary Discord host (ptb.discord.com) retains /----- prefix in pushState
  const c = runInMockBrowser('/-----https://ptb.discord.com/login');
  c.sandbox.history.pushState(null, '', '/channels/@me');
  assert.equal(c.historyCalls[0].url, '/-----https://ptb.discord.com/channels/@me');
});

function xhrCallsCheck(u) {
  return u;
}
