/**
 * Self-contained Cloudflare Workers Discord Proxy
 * Optimized for Cloudflare Workers Free Tier (10ms CPU, 128MB RAM, 100k req/day).
 * Zero external dependencies or local imports — works with `wrangler deploy`,
 * Cloudflare Git Builds, AND Cloudflare Dashboard Quick Edit copy-paste.
 */

const PREFIX = '/-----';
const RUNTIME_PATH = '/__proxy_runtime.js';
const SW_PATH = '/__proxy_sw.js';
const HEALTH_PATH = '/__proxy_health';

const DISCORD_ORIGIN = 'https://discord.com';

const MAX_CSS_REWRITE_BYTES = 1_500_000;
const STATIC_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';
const SKIP_PROTOCOLS = /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i;
const STATIC_EXT_RE =
  /\.(?:js|mjs|css|wasm|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|eot|mp3|ogg|wav|webm|avif)(?:$|\?)/i;
const COOKIE_FREE_CDNS = [
  'cdn.discordapp.com',
  'media.discordapp.net',
  'images-ext-1.discordapp.net',
  'images-ext-2.discordapp.net',
  'fonts.gstatic.com',
];

const DISCORD_EXACT_HOSTS = new Set([
  'discord.com',
  'discord.gg',
  'discordapp.com',
  'discordapp.net',
  'discord.media',
  'discordstatus.com',
  'dis.gd',
]);

const DISCORD_APP_PATH_RE =
  /^\/(?:login|register|app|channels(?:\/|$)|invite(?:\/|$)|oauth2(?:\/|$)|api(?:\/|$)|assets(?:\/|$)|verify(?:\/|$)|reset(?:\/|$)|handoff(?:\/|$)|activate(?:\/|$)|billing(?:\/|$)|store(?:\/|$)|nitro(?:\/|$)|shop(?:\/|$)|quests(?:\/|$)|discovery(?:\/|$)|servers(?:\/|$)|developers(?:\/|$)|me(?:\/|$)|guild-stages(?:\/|$)|events(?:\/|$)|cdn-cgi(?:\/|$)|favicon\.ico$|robots\.txt$)/i;

const DISCORD_CORS_ALLOW_HEADERS =
  'Authorization, Content-Type, X-Super-Properties, X-Discord-Locale, X-Discord-Timezone, X-Debug-Options, X-Context-Properties, X-Fingerprint, X-Captcha-Key, X-Captcha-Rqtoken, X-Captcha-Session-Id, X-Audit-Log-Reason, If-None-Match';

// ============================================================================
// Discord Domain, URL, Asset, Cookie, and CSS Rewriting Helpers
// ============================================================================

export function isDiscordHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  if (DISCORD_EXACT_HOSTS.has(h)) return true;
  return (
    h.endsWith('.discord.com') ||
    h.endsWith('.discord.gg') ||
    h.endsWith('.discordapp.com') ||
    h.endsWith('.discordapp.net') ||
    h.endsWith('.discord.media')
  );
}

export function isDiscordAppPath(pathname) {
  if (!pathname) return false;
  return DISCORD_APP_PATH_RE.test(pathname);
}

export function isStreamingMediaUrl(targetUrl) {
  const p = targetUrl.pathname.toLowerCase();
  return /\.(?:m3u8|mpd|m4s|ts)(?:$|\?)/.test(p);
}

export function isCookieFreeCdn(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  for (let i = 0; i < COOKIE_FREE_CDNS.length; i++) {
    const cdn = COOKIE_FREE_CDNS[i];
    if (h === cdn || h.endsWith('.' + cdn)) return true;
  }
  return false;
}

export function isStaticAssetUrl(targetUrl) {
  if (isStreamingMediaUrl(targetUrl)) return false;
  const host = targetUrl.hostname.toLowerCase();
  if (isCookieFreeCdn(host)) return true;
  return STATIC_EXT_RE.test(targetUrl.pathname);
}

export function normalizeTargetUrl(raw) {
  if (!raw) return '';
  return raw.replace(/^(https?|wss?):\/(?!\/)/i, '$1://');
}

function stripProxyPrefix(pathname) {
  if (pathname.startsWith(PREFIX)) return pathname.substring(PREFIX.length);
  return pathname.substring(1);
}

export function extractProxiedTarget(proxiedUrlStr) {
  try {
    const parsed = new URL(proxiedUrlStr);
    const raw = normalizeTargetUrl(stripProxyPrefix(parsed.pathname) + parsed.search);
    if (/^(https?|wss?):\/\//i.test(raw)) return new URL(raw);
    if (parsed.pathname === '/' && parsed.searchParams.has('url')) {
      return new URL(normalizeTargetUrl(parsed.searchParams.get('url')));
    }
    if (isDiscordAppPath(parsed.pathname)) {
      return new URL(parsed.pathname + parsed.search, DISCORD_ORIGIN);
    }
  } catch {
    // ignore
  }
  return null;
}

export function resolveIncomingTargetUrl(requestUrl, refererHeader) {
  let targetUrlStr = '';
  if (requestUrl.pathname === '/' && requestUrl.searchParams.has('url')) {
    targetUrlStr = normalizeTargetUrl(requestUrl.searchParams.get('url') || '');
  } else {
    targetUrlStr = normalizeTargetUrl(stripProxyPrefix(requestUrl.pathname) + requestUrl.search);
  }

  if (!targetUrlStr) return { error: 'Invalid URL', status: 400 };

  if (/^(https?|wss?):\/\//i.test(targetUrlStr)) {
    try {
      return { targetUrl: new URL(targetUrlStr) };
    } catch {
      return { error: 'Invalid URL: ' + targetUrlStr, status: 400 };
    }
  }

  if (refererHeader) {
    const baseTargetUrl = extractProxiedTarget(refererHeader);
    if (baseTargetUrl) {
      try {
        return { targetUrl: new URL(requestUrl.pathname + requestUrl.search, baseTargetUrl.href) };
      } catch {
        return { error: 'Invalid URL or unable to resolve relative path', status: 400 };
      }
    }
  }

  if (isDiscordAppPath(requestUrl.pathname)) {
    try {
      return { targetUrl: new URL(requestUrl.pathname + requestUrl.search, DISCORD_ORIGIN) };
    } catch {
      return { error: 'Invalid Discord path', status: 400 };
    }
  }

  return { error: 'Invalid URL: ' + targetUrlStr, status: 400 };
}

export function rewriteUrl(rawUrl, baseUrl, proxyBase) {
  if (!rawUrl) return rawUrl;
  const trimmed = rawUrl.trim();
  if (!trimmed || SKIP_PROTOCOLS.test(trimmed)) return rawUrl;
  if (
    trimmed.startsWith(proxyBase + PREFIX) ||
    trimmed.startsWith(PREFIX) ||
    trimmed.startsWith(proxyBase + '/http') ||
    trimmed.startsWith(proxyBase + '/ws') ||
    /^\/(https?|wss?):\/\//i.test(trimmed)
  ) {
    return rawUrl;
  }

  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
      return `${proxyBase}${PREFIX}${resolved.href}`;
    }
    if (resolved.protocol === 'ws:' || resolved.protocol === 'wss:') {
      return `${proxyBase.replace(/^http/i, 'ws')}${PREFIX}${resolved.href}`;
    }
  } catch {
    // ignore
  }
  return rawUrl;
}

export function rewriteSrcset(srcset, baseUrl, proxyBase) {
  if (!srcset) return srcset;
  return srcset
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const spaceIdx = trimmed.search(/\s/);
      if (spaceIdx === -1) return rewriteUrl(trimmed, baseUrl, proxyBase);
      return rewriteUrl(trimmed.slice(0, spaceIdx), baseUrl, proxyBase) + trimmed.slice(spaceIdx);
    })
    .join(', ');
}

export function rewriteCss(css, baseUrl, proxyBase) {
  if (!css) return css;
  const hasUrl = css.indexOf('url(') !== -1 || css.indexOf('URL(') !== -1;
  const hasImport = css.indexOf('@import') !== -1 || css.indexOf('@IMPORT') !== -1;
  if (!hasUrl && !hasImport) return css;

  let out = css;
  if (hasUrl) {
    out = out.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, quote, urlVal) => {
      return `url(${quote}${rewriteUrl(urlVal, baseUrl, proxyBase)}${quote})`;
    });
  }
  if (hasImport) {
    out = out.replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, urlVal) => {
      return `@import ${quote}${rewriteUrl(urlVal, baseUrl, proxyBase)}${quote}`;
    });
  }
  return out;
}

export function rewriteSetCookie(cookieHeader, isHttpsProxy) {
  if (!cookieHeader) return cookieHeader;
  const parts = cookieHeader.split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return cookieHeader;

  const nameValue = parts[0];
  const attrs = [];
  let hasSameSite = false;
  let hasSecure = false;
  let hasPath = false;

  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i];
    const lower = attr.toLowerCase();
    if (lower.startsWith('domain=')) continue;
    if (lower.startsWith('path=')) {
      attrs.push('Path=/');
      hasPath = true;
      continue;
    }
    if (lower.startsWith('samesite=')) {
      hasSameSite = true;
      attrs.push(isHttpsProxy ? 'SameSite=None' : 'SameSite=Lax');
      continue;
    }
    if (lower === 'secure') {
      hasSecure = true;
      if (isHttpsProxy) attrs.push('Secure');
      continue;
    }
    if (lower === 'partitioned' && !isHttpsProxy) continue;
    attrs.push(attr);
  }

  if (!hasPath) attrs.push('Path=/');
  if (isHttpsProxy) {
    if (!hasSameSite) attrs.push('SameSite=None');
    if (!hasSecure) attrs.push('Secure');
  }
  return [nameValue, ...attrs].join('; ');
}

export function computeUpstreamOrigin(targetUrl, refererHeader, explicitProxyOrigin) {
  if (explicitProxyOrigin) {
    try {
      return new URL(explicitProxyOrigin).origin;
    } catch {
      // fall through
    }
  }
  if (refererHeader) {
    const refTarget = extractProxiedTarget(refererHeader);
    if (refTarget) return refTarget.origin;
  }
  if (isDiscordHost(targetUrl.hostname)) {
    const h = targetUrl.hostname.toLowerCase();
    if (h === 'ptb.discord.com' || h === 'canary.discord.com') {
      return `https://${h}`;
    }
    return DISCORD_ORIGIN;
  }
  return targetUrl.origin;
}

export function stripInternalParams(targetUrl) {
  const cleaned = new URL(targetUrl.href);
  const explicitOrigin = cleaned.searchParams.get('__proxy_origin');
  if (cleaned.searchParams.has('__proxy_origin')) {
    cleaned.searchParams.delete('__proxy_origin');
  }
  return { cleanedUrl: cleaned, explicitOrigin };
}

function corsHeaders(request) {
  const reqOrigin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': reqOrigin || '*',
    'Access-Control-Allow-Credentials': reqOrigin ? 'true' : 'false',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD',
    'Access-Control-Allow-Headers':
      request.headers.get('Access-Control-Request-Headers') || DISCORD_CORS_ALLOW_HEADERS,
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ============================================================================
// Service Worker & Client Runtime Scripts (Discord-Aware Proxy)
// ============================================================================

const SERVICE_WORKER_SCRIPT = `const PREFIX = '${PREFIX}';
const DISCORD_ORIGIN = '${DISCORD_ORIGIN}';
const DISCORD_PATH_RE = ${DISCORD_APP_PATH_RE.toString()};

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function extractTargetFromClientUrl(clientUrl) {
  try {
    const u = new URL(clientUrl);
    let raw = u.pathname.startsWith(PREFIX)
      ? u.pathname.substring(PREFIX.length) + u.search
      : u.pathname.substring(1) + u.search;
    raw = raw.replace(/^(https?|wss?):\\/(?!\\/)/i, '$1://');
    if (/^https?:\\/\\//i.test(raw)) return new URL(raw);
    if (DISCORD_PATH_RE.test(u.pathname)) return new URL(u.pathname + u.search, DISCORD_ORIGIN);
  } catch (e) {}
  return null;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let reqUrl;
  try {
    reqUrl = new URL(req.url);
  } catch (e) {
    return;
  }

  if (reqUrl.protocol !== 'http:' && reqUrl.protocol !== 'https:') return;

  const isSameOrigin = reqUrl.origin === self.location.origin;
  if (isSameOrigin) {
    const p = reqUrl.pathname;
    if (
      p === '/' ||
      p.startsWith('/__proxy_') ||
      p.startsWith(PREFIX) ||
      /^\\/(https?|wss?):\\/\\//i.test(p)
    ) {
      return;
    }
  }

  event.respondWith((async () => {
    let targetHref = null;
    if (!isSameOrigin) {
      targetHref = reqUrl.href;
    } else {
      let client = null;
      if (event.clientId) client = await self.clients.get(event.clientId);
      if (!client && event.resultingClientId) client = await self.clients.get(event.resultingClientId);
      if (client) {
        const baseTarget = extractTargetFromClientUrl(client.url);
        if (baseTarget) targetHref = new URL(reqUrl.pathname + reqUrl.search, baseTarget.origin).href;
      }
      if (!targetHref && req.referrer) {
        const refTarget = extractTargetFromClientUrl(req.referrer);
        if (refTarget) targetHref = new URL(reqUrl.pathname + reqUrl.search, refTarget.origin).href;
      }
      if (!targetHref && DISCORD_PATH_RE.test(reqUrl.pathname)) {
        targetHref = new URL(reqUrl.pathname + reqUrl.search, DISCORD_ORIGIN).href;
      }
    }

    if (!targetHref) return fetch(req);

    const proxiedUrl = self.location.origin + PREFIX + targetHref;
    const init = {
      method: req.method,
      headers: new Headers(req.headers),
      credentials: 'include',
      redirect: 'follow',
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        const buf = await req.arrayBuffer();
        if (buf.byteLength > 0) init.body = buf;
      } catch (e) {}
    }
    return fetch(proxiedUrl, init);
  })());
});
`;

const CLIENT_RUNTIME_SCRIPT = `(function(){
if(window.__PROXY_RT__)return;window.__PROXY_RT__=1;
var PRE='${PREFIX}',P=location.origin,W=P.replace(/^http/i,'ws'),D_ORIGIN='${DISCORD_ORIGIN}',SKIP=/^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i;
try{if('serviceWorker' in navigator&&!navigator.serviceWorker.controller){navigator.serviceWorker.register('${SW_PATH}',{scope:'/'}).catch(function(){});}}catch(e){}
function curTarget(){
  try{
    var pn=location.pathname;
    if(pn.indexOf(PRE)===0||/^\\/(https?|wss?):/i.test(pn)){
      var p=(pn.indexOf(PRE)===0?pn.substring(PRE.length):pn.substring(1))+location.search+location.hash;
      p=p.replace(/^(https?|wss?):\\/(?!\\/)/i,'$1://');
      if(/^https?:\\/\\//i.test(p))return p;
    }
    return D_ORIGIN+pn+location.search+location.hash;
  }catch(e){}
  return D_ORIGIN+'/';
}
function rwHttp(u){
  if(typeof u!=='string'){if(u&&typeof u.href==='string')u=u.href;else return u;}
  var t=u.trim();if(!t||SKIP.test(t))return u;
  if(t.indexOf(P+PRE)===0||t.indexOf(PRE)===0||t.indexOf(P+'/http')===0||t.indexOf(P+'/ws')===0||t.indexOf('/__proxy_')===0||t.indexOf(P+'/__proxy_')===0)return u;
  if(/^\\/(https?|wss?):\\/\\//i.test(t))return P+PRE+t.substring(1);
  try{
    var ct=curTarget();
    var r=new URL(t,ct);
    if(r.origin===P){
      var pn=r.pathname;
      var sub=(pn.indexOf(PRE)===0?pn.substring(PRE.length):pn.substring(1)).replace(/^(https?|wss?):\\/(?!\\/)/i,'$1://');
      if(/^(https?|wss?):\\/\\//i.test(sub))return P+PRE+sub+r.search+r.hash;
      r=new URL(r.pathname+r.search+r.hash,new URL(ct).origin);
    }
    if(r.protocol==='http:'||r.protocol==='https:')return P+PRE+r.href;
    if(r.protocol==='ws:'||r.protocol==='wss:')return W+PRE+r.href;
  }catch(e){}
  return u;
}
function rwWs(u){
  if(typeof u!=='string'){if(u&&typeof u.href==='string')u=u.href;else return u;}
  var t=u.trim();if(!t||t.indexOf(W+PRE)===0||t.indexOf(W+'/ws')===0)return u;
  try{
    var tb=new URL(curTarget()),r=new URL(t,tb.href.replace(/^http/i,'ws'));
    if(r.origin===W){
      var pn=r.pathname;
      var sub=(pn.indexOf(PRE)===0?pn.substring(PRE.length):pn.substring(1)).replace(/^(wss?):\\/(?!\\/)/i,'$1://');
      if(/^wss?:\\/\\//i.test(sub))return W+PRE+sub+r.search;
      r=new URL(r.pathname+r.search,tb.origin.replace(/^http/i,'ws'));
    }
    var o=W+PRE+r.href;return o+(o.indexOf('?')===-1?'?':'&')+'__proxy_origin='+encodeURIComponent(tb.origin);
  }catch(e){}
  return u;
}
function rwSrcset(v){
  if(typeof v!=='string')return v;
  return v.split(',').map(function(p){var t=p.trim();if(!t)return p;var i=t.search(/\\s/);if(i===-1)return rwHttp(t);return rwHttp(t.slice(0,i))+t.slice(i);}).join(', ');
}
var oReq=window.Request;
if(oReq){var PReq=function(i,o){if(typeof i==='string'||i instanceof URL){i=rwHttp(String(i));}return arguments.length>1?new oReq(i,o):new oReq(i);};PReq.prototype=oReq.prototype;window.Request=PReq;}
var oF=window.fetch;
if(oF){window.fetch=function(a,b){try{if(typeof a==='string'||a instanceof URL){a=rwHttp(String(a));}else if(a instanceof oReq){var n2=rwHttp(a.url);if(n2!==a.url)a=new oReq(n2,a);}}catch(e){}return oF.call(this,a,b);};}
try{if(navigator&&navigator.serviceWorker&&navigator.serviceWorker.register){var oSwReg=navigator.serviceWorker.register.bind(navigator.serviceWorker);navigator.serviceWorker.register=function(url,opts){if(String(url).indexOf('${SW_PATH}')!==-1)return oSwReg(url,opts);return Promise.reject(new DOMException('Upstream ServiceWorker disabled in proxy','SecurityError'));};}}catch(e){}
var oXO=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){var a=Array.prototype.slice.call(arguments);if(typeof u==='string'||u instanceof URL){a[1]=rwHttp(String(u));}return oXO.apply(this,a);};
var oWS=window.WebSocket;
if(oWS){var PWS=function(u,p){var n=rwWs(u);return arguments.length>1?new oWS(n,p):new oWS(n);};PWS.prototype=oWS.prototype;PWS.CONNECTING=oWS.CONNECTING;PWS.OPEN=oWS.OPEN;PWS.CLOSING=oWS.CLOSING;PWS.CLOSED=oWS.CLOSED;window.WebSocket=PWS;}
var oES=window.EventSource;
if(oES){var PES=function(u,c){var n=rwHttp(u);return arguments.length>1?new oES(n,c):new oES(n);};PES.prototype=oES.prototype;PES.CONNECTING=oES.CONNECTING;PES.OPEN=oES.OPEN;PES.CLOSED=oES.CLOSED;window.EventSource=PES;}
var oW=window.Worker;
if(oW){var PW=function(u,o){var n=rwHttp(u);return arguments.length>1?new oW(n,o):new oW(n);};PW.prototype=oW.prototype;window.Worker=PW;}
if(navigator&&navigator.sendBeacon){var oB=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){return oB(rwHttp(u),d);};}
function wH(fn){var o=History.prototype[fn];if(!o)return;History.prototype[fn]=function(s,t,u){if(u!==undefined&&u!==null&&u!==''){try{var n=rwHttp(String(u));if(n&&n.indexOf(P)===0){var sub=n.substring(P.length);if(sub.indexOf(PRE+D_ORIGIN+'/')===0){u=sub.substring((PRE+D_ORIGIN).length)||'/';}else{u=sub;}}}catch(e){}}return o.call(this,s,t,u);};}
wH('pushState');wH('replaceState');
var oOp=window.open;if(oOp){window.open=function(u,t,f){if(u)u=rwHttp(String(u));return oOp.call(this,u,t,f);};}
var UA={src:1,href:1,action:1,poster:1,data:1},oSA=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(k,v){var l=String(k).toLowerCase();if(l==='integrity')return;if(l==='srcset')v=rwSrcset(String(v));else if(UA[l]&&typeof v==='string'){v=rwHttp(v);}return oSA.call(this,k,v);};
function hP(pr,k,ss){if(!pr)return;var d=Object.getOwnPropertyDescriptor(pr,k);if(!d||!d.set)return;Object.defineProperty(pr,k,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){if(typeof v==='string'){v=ss?rwSrcset(v):rwHttp(v);}return d.set.call(this,v);}});}
hP(HTMLScriptElement.prototype,'src',0);hP(HTMLImageElement.prototype,'src',0);hP(HTMLImageElement.prototype,'srcset',1);hP(HTMLLinkElement.prototype,'href',0);hP(HTMLAnchorElement.prototype,'href',0);hP(HTMLFormElement.prototype,'action',0);hP(HTMLIFrameElement.prototype,'src',0);hP(HTMLSourceElement.prototype,'src',0);hP(HTMLSourceElement.prototype,'srcset',1);hP(HTMLMediaElement.prototype,'src',0);
function igP(pr,k){if(!pr)return;var d=Object.getOwnPropertyDescriptor(pr,k);if(!d||!d.configurable)return;Object.defineProperty(pr,k,{configurable:true,enumerable:d.enumerable,get:function(){return'';},set:function(){}});}
igP(HTMLScriptElement.prototype,'integrity');igP(HTMLLinkElement.prototype,'integrity');
})();`;

export function getProxyConfig() {
  return {
    PREFIX,
    RUNTIME_PATH,
    SW_PATH,
    HEALTH_PATH,
    DISCORD_ORIGIN,
    SERVICE_WORKER_SCRIPT,
    CLIENT_RUNTIME_SCRIPT,
  };
}

// ============================================================================
// Streaming Cloudflare HTMLRewriter
// ============================================================================

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
        if (equiv === 'content-security-policy') el.remove();
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
          chunk.replace(out, { html: true });
          styleBuf = '';
        } else {
          chunk.remove();
        }
      },
    });

  return rewriter.transform(response);
}

function renderSwBootstrapPage(targetUrl) {
  let destPath = PREFIX + targetUrl;
  try {
    const parsed = new URL(targetUrl);
    if (parsed.origin === DISCORD_ORIGIN && isDiscordAppPath(parsed.pathname)) {
      destPath = parsed.pathname + parsed.search + parsed.hash;
    }
  } catch {
    // ignore
  }
  const safeTarget = JSON.stringify(destPath);
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Connecting to Discord…</title>
  <style>body{background:#1e1f22;color:#f2f3f5;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;}</style>
</head>
<body>
  <p>Starting Discord proxy service worker…</p>
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
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

function renderDiscordLauncher() {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Discord Proxy — Cloudflare Workers</title>
  <style>
    :root { --bg:#1e1f22; --card:#2b2d31; --input:#1e1f22; --border:#3f4147; --text:#f2f3f5; --muted:#b5bac1; --blurple:#5865f2; --blurple-hover:#4752c4; --green:#23a559; }
    * { box-sizing:border-box; }
    body { font-family: 'gg sans', system-ui, -apple-system, sans-serif; display:flex; justify-content:center; align-items:center; min-height:100vh; background:var(--bg); color:var(--text); margin:0; padding:1rem; }
    .container { background:var(--card); border:1px solid var(--border); padding:2rem; border-radius:14px; box-shadow:0 16px 40px rgba(0,0,0,0.45); width:min(500px, 94vw); }
    h1 { margin:0 0 0.35rem; font-size:1.5rem; display:flex; align-items:center; gap:0.55rem; }
    .badge { font-size:0.72rem; background:var(--blurple); color:#fff; padding:0.18rem 0.5rem; border-radius:999px; font-weight:700; letter-spacing:0.03em; }
    p { margin:0 0 1.25rem; color:var(--muted); font-size:0.9rem; line-height:1.45; }
    .primary-actions { display:grid; grid-template-columns:1fr 1fr; gap:0.65rem; margin-bottom:1.15rem; }
    a.btn, button.btn { padding:0.75rem 1rem; border-radius:8px; font-weight:700; font-size:0.92rem; text-decoration:none; text-align:center; border:none; cursor:pointer; transition:background 0.15s; display:inline-flex; align-items:center; justify-content:center; gap:0.4rem; }
    .btn-primary { background:var(--blurple); color:#fff; }
    .btn-primary:hover { background:var(--blurple-hover); }
    .btn-secondary { background:#383a40; color:var(--text); border:1px solid var(--border); }
    .btn-secondary:hover { background:#43464d; }
    form { display:flex; gap:0.5rem; margin-bottom:1rem; }
    input[type="text"] { flex:1; padding:0.65rem 0.85rem; border:1px solid var(--border); border-radius:8px; background:var(--input); color:#fff; font-size:0.9rem; outline:none; }
    input[type="text"]:focus { border-color:var(--blurple); }
    .quick { display:flex; gap:0.5rem; flex-wrap:wrap; }
    .quick a.btn { padding:0.48rem 0.8rem; font-size:0.82rem; font-weight:600; }
    .sw-status { margin-top:1rem; font-size:0.8rem; color:var(--green); display:flex; align-items:center; justify-content:space-between; }
    .sw-status span.muted { color:var(--muted); }
  </style>
</head>
<body>
  <div class="container">
    <h1>Discord Proxy <span class="badge">CF WORKERS</span></h1>
    <p>Dedicated Discord proxy with full sign-in, 2FA, QR remote auth, WebSocket Gateway, and CDN media support.</p>
    <div class="primary-actions">
      <a class="btn btn-primary" data-url="https://discord.com/login" href="/login">Sign In to Discord</a>
      <a class="btn btn-secondary" data-url="https://discord.com/app" href="/app">Open Discord App</a>
    </div>
    <form action="/" method="GET" id="proxy-form">
      <input type="text" name="url" placeholder="Paste Discord invite, channel URL, or discord.com path…" required>
      <button class="btn btn-primary" type="submit">Go</button>
    </form>
    <div class="quick">
      <a class="btn btn-secondary" data-url="https://discord.com/channels/@me" href="/channels/@me">Direct Messages</a>
      <a class="btn btn-secondary" data-url="https://ptb.discord.com/login" href="/__proxy_go?url=https%3A%2F%2Fptb.discord.com%2Flogin">Discord PTB</a>
      <a class="btn btn-secondary" data-url="https://canary.discord.com/login" href="/__proxy_go?url=https%3A%2F%2Fcanary.discord.com%2Flogin">Discord Canary</a>
    </div>
    <div class="sw-status">
      <span id="sw-status">Initializing Service Worker…</span>
      <span class="muted">Gateway WSS + Auth Ready</span>
    </div>
    <script>
      var DISCORD_PATH_RE = ${DISCORD_APP_PATH_RE.toString()};
      var swReady = (async function () {
        var el = document.getElementById('sw-status');
        try {
          if ('serviceWorker' in navigator) {
            await navigator.serviceWorker.register('${SW_PATH}', { scope: '/' });
            await navigator.serviceWorker.ready;
            el.textContent = '✓ Service Worker active';
          }
        } catch (e) { el.textContent = 'Ready'; }
      })();

      async function go(raw) {
        var val = raw.trim();
        if (!val) return;
        if (val.charAt(0) === '/') val = 'https://discord.com' + val;
        else if (!/^https?:\\/\\//i.test(val)) val = 'https://' + val;
        await swReady;
        try {
          var u = new URL(val);
          if (u.origin === 'https://discord.com' && DISCORD_PATH_RE.test(u.pathname)) {
            window.location.href = u.pathname + u.search + u.hash;
            return;
          }
        } catch (e) {}
        window.location.href = '${PREFIX}' + val;
      }

      document.getElementById('proxy-form').addEventListener('submit', function(e) {
        e.preventDefault();
        go(document.querySelector('input[name="url"]').value);
      });
      document.querySelectorAll('a[data-url]').forEach(function(a) {
        a.addEventListener('click', function(e) { e.preventDefault(); go(a.getAttribute('data-url')); });
      });
    </script>
  </div>
</body>
</html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' } }
  );
}

// ============================================================================
// Main Cloudflare Worker Entrypoint
// ============================================================================

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

    // 2. CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const proxyBase = url.origin;
    const isHttpsProxy = url.protocol === 'https:';

    // 3. Health check
    if (url.pathname === HEALTH_PATH) {
      return new Response(
        JSON.stringify({
          ok: true,
          runtime: 'cloudflare-worker',
          discord: true,
          websockets: true,
          serviceWorker: true,
          streamingHtml: typeof HTMLRewriter !== 'undefined',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } }
      );
    }

    // 4. Service Worker & Client Runtime
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

    if (url.pathname === '/__proxy_go' && url.searchParams.has('url')) {
      let dest = (url.searchParams.get('url') || '').trim();
      if (!/^https?:\/\//i.test(dest)) dest = 'https://' + dest;
      return renderSwBootstrapPage(dest);
    }

    // 5. Root Discord Launcher UI
    if (url.pathname === '/' && !url.searchParams.has('url')) {
      return renderDiscordLauncher();
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

    const isStreamingMedia = isStreamingMediaUrl(fetchUrl);

    // 7. Check Cloudflare Edge Cache for GET static assets (Discord CDN, assets)
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
        // ignore
      }
    }

    // 8. Build upstream headers (Discord-aware Origin, Referer, Host, Cookie handling)
    const newHeaders = new Headers(request.headers);
    newHeaders.set('Host', fetchUrl.host);

    const isDiscord = isDiscordHost(fetchUrl.hostname);
    const upstreamOrigin = computeUpstreamOrigin(fetchUrl, refererHeader, explicitOrigin);

    if (request.headers.has('Origin') || isWebSocket || (isDiscord && !['GET', 'HEAD'].includes(request.method))) {
      newHeaders.set('Origin', upstreamOrigin);
    }
    if (newHeaders.has('x-origin')) {
      newHeaders.set('x-origin', upstreamOrigin);
    }

    if (refererHeader) {
      const refTarget = extractProxiedTarget(refererHeader);
      newHeaders.set('Referer', refTarget ? refTarget.href : upstreamOrigin + '/');
    } else if (isDiscord) {
      newHeaders.set('Referer', upstreamOrigin + '/');
    }

    // Strip proxy, CF, and sec-fetch-* headers that can cause upstream rejections
    for (const h of [
      'cf-connecting-ip', 'cf-ipcountry', 'cf-visitor', 'cf-ray', 'cf-worker',
      'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
      'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
    ]) {
      newHeaders.delete(h);
    }

    if (isCacheableStatic && isCookieFreeCdn(fetchUrl.hostname)) {
      newHeaders.delete('cookie');
    }

    // 9. WebSocket passthrough (Discord Gateway & Remote Auth QR)
    if (isWebSocket) {
      try {
        const wsResp = await fetch(fetchUrl.href, { headers: newHeaders });
        if (wsResp.webSocket) return new Response(null, { status: 101, webSocket: wsResp.webSocket });
        return wsResp;
      } catch (e) {
        return new Response('WebSocket proxy error: ' + e.message, { status: 502 });
      }
    }

    // 10. Fetch upstream
    const hasBody = !['GET', 'HEAD'].includes(request.method) && request.body !== null;
    const fetchInit = {
      method: request.method,
      headers: newHeaders,
      body: hasBody ? request.body : null,
      redirect: isStreamingMedia ? 'follow' : 'manual',
    };
    if (hasBody) {
      fetchInit.duplex = 'half';
    }

    let response;
    try {
      response = await fetch(fetchUrl.href, fetchInit);
    } catch (e) {
      return new Response('Error fetching target URL: ' + e.message, { status: 502 });
    }

    const responseHeaders = new Headers(response.headers);
    for (const h of [
      'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
      'clear-site-data', 'cross-origin-embedder-policy', 'cross-origin-opener-policy',
      'cross-origin-resource-policy', 'strict-transport-security',
    ]) {
      responseHeaders.delete(h);
    }

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

    const cors = corsHeaders(request);
    for (const [k, v] of Object.entries(cors)) responseHeaders.set(k, v);

    const shouldCacheResponse =
      isCacheableStatic && response.status === 200 && setCookies.length === 0;
    if (shouldCacheResponse) {
      responseHeaders.set('Cache-Control', STATIC_CACHE_CONTROL);
    }

    const contentType = (responseHeaders.get('content-type') || '').toLowerCase();

    // 11. Streaming HTML rewriting
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
      return baseResp;
    }

    // 12. Size-guarded fast CSS rewriting
    if (contentType.includes('text/css')) {
      const contentLen = Number(responseHeaders.get('content-length') || '0');
      if (contentLen <= MAX_CSS_REWRITE_BYTES) {
        const css = await response.text();
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
        const outResp = new Response(rewriteCss(css, fetchUrl.href, proxyBase), {
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

    // 13. Zero-copy streaming for JS, WASM, images, audio, video, JSON
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
