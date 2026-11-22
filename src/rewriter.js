/**
 * Ultra-lightweight shared proxy utilities optimized for Cloudflare Workers Free Tier
 * (10ms CPU limit, 128MB memory, 100k req/day).
 */

export const RUNTIME_PATH = '/__proxy_runtime.js';
export const HEALTH_PATH = '/__proxy_health';

const SKIP_PROTOCOLS = /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i;

const STATIC_EXT_RE =
  /\.(?:js|mjs|css|wasm|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|eot|mp3|ogg|wav|webm|avif)(?:$|\?)/i;

const COOKIE_FREE_CDNS = [
  'chesscomfiles.com',
  'ytimg.com',
  'ggpht.com',
  'fonts.gstatic.com',
];

/**
 * Detect live/range-based media streams (e.g. YouTube googlevideo.com/videoplayback)
 * that must be streamed zero-copy without edge caching.
 */
export function isStreamingMediaUrl(targetUrl) {
  const host = targetUrl.hostname.toLowerCase();
  if (host === 'googlevideo.com' || host.endsWith('.googlevideo.com')) {
    return true;
  }
  const p = targetUrl.pathname.toLowerCase();
  return p.includes('/videoplayback') || /\.(?:m3u8|mpd|m4s|ts)(?:$|\?)/.test(p);
}

/**
 * Detect public static CDNs where stripping cookies maximizes Cloudflare edge cache hits.
 */
export function isCookieFreeCdn(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  for (let i = 0; i < COOKIE_FREE_CDNS.length; i++) {
    const cdn = COOKIE_FREE_CDNS[i];
    if (h === cdn || h.endsWith('.' + cdn)) return true;
  }
  return false;
}

/**
 * Determine whether a target URL is a cacheable static asset (never caches videoplayback streams).
 */
export function isStaticAssetUrl(targetUrl) {
  if (isStreamingMediaUrl(targetUrl)) return false;
  const host = targetUrl.hostname.toLowerCase();
  if (isCookieFreeCdn(host)) return true;
  if (
    (host === 'www.youtube.com' || host === 'm.youtube.com') &&
    (targetUrl.pathname.startsWith('/s/player/') || targetUrl.pathname.startsWith('/s/desktop/'))
  ) {
    return true;
  }
  return STATIC_EXT_RE.test(targetUrl.pathname);
}

/**
 * Fix collapsed protocol slashes (e.g. https:/www.chess.com -> https://www.chess.com).
 */
export function normalizeTargetUrl(raw) {
  if (!raw) return '';
  return raw.replace(/^(https?|wss?):\/(?!\/)/i, '$1://');
}

/**
 * Extract the real target URL from a proxied URL string.
 */
export function extractProxiedTarget(proxiedUrlStr) {
  try {
    const parsed = new URL(proxiedUrlStr);
    const raw = normalizeTargetUrl(parsed.pathname.substring(1) + parsed.search);
    if (/^(https?|wss?):\/\//i.test(raw)) {
      return new URL(raw);
    }
    if (parsed.pathname === '/' && parsed.searchParams.has('url')) {
      return new URL(normalizeTargetUrl(parsed.searchParams.get('url')));
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Resolve an incoming request URL into a target URL object.
 */
export function resolveIncomingTargetUrl(requestUrl, refererHeader) {
  let targetUrlStr = '';

  if (requestUrl.pathname === '/' && requestUrl.searchParams.has('url')) {
    targetUrlStr = normalizeTargetUrl(requestUrl.searchParams.get('url') || '');
  } else {
    targetUrlStr = normalizeTargetUrl(requestUrl.pathname.substring(1) + requestUrl.search);
  }

  if (!targetUrlStr) {
    return { error: 'Invalid URL', status: 400 };
  }

  if (/^(https?|wss?):\/\//i.test(targetUrlStr)) {
    try {
      return { targetUrl: new URL(targetUrlStr) };
    } catch {
      return { error: 'Invalid URL: ' + targetUrlStr, status: 400 };
    }
  }

  // Relative URL fallback via Referer (preserves leading slash for root-relative paths)
  if (refererHeader) {
    const baseTargetUrl = extractProxiedTarget(refererHeader);
    if (baseTargetUrl) {
      try {
        const relativePath = requestUrl.pathname + requestUrl.search;
        return { targetUrl: new URL(relativePath, baseTargetUrl.href) };
      } catch {
        return { error: 'Invalid URL or unable to resolve relative path', status: 400 };
      }
    }
  }

  return { error: 'Invalid URL: ' + targetUrlStr, status: 400 };
}

/**
 * Rewrite a single URL (absolute, protocol-relative, or relative) to go through proxyBase.
 */
export function rewriteUrl(rawUrl, baseUrl, proxyBase) {
  if (!rawUrl) return rawUrl;
  const trimmed = rawUrl.trim();
  if (!trimmed || SKIP_PROTOCOLS.test(trimmed)) return rawUrl;

  if (trimmed.startsWith(proxyBase + '/http') || trimmed.startsWith(proxyBase + '/ws')) {
    return rawUrl;
  }
  if (/^\/(https?|wss?):\/\//i.test(trimmed)) {
    return rawUrl;
  }

  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
      return `${proxyBase}/${resolved.href}`;
    }
    if (resolved.protocol === 'ws:' || resolved.protocol === 'wss:') {
      const wsProxyBase = proxyBase.replace(/^http/i, 'ws');
      return `${wsProxyBase}/${resolved.href}`;
    }
  } catch {
    // leave untouched
  }
  return rawUrl;
}

/**
 * Rewrite an HTML srcset attribute value.
 */
export function rewriteSrcset(srcset, baseUrl, proxyBase) {
  if (!srcset) return srcset;
  return srcset
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const spaceIdx = trimmed.search(/\s/);
      if (spaceIdx === -1) {
        return rewriteUrl(trimmed, baseUrl, proxyBase);
      }
      return rewriteUrl(trimmed.slice(0, spaceIdx), baseUrl, proxyBase) + trimmed.slice(spaceIdx);
    })
    .join(', ');
}

/**
 * Fast CSS url(...) and @import rewriter with early exit when nothing needs rewriting.
 */
export function rewriteCss(css, baseUrl, proxyBase) {
  if (!css) return css;
  const hasUrl = css.indexOf('url(') !== -1 || css.indexOf('URL(') !== -1;
  const hasImport = css.indexOf('@import') !== -1 || css.indexOf('@IMPORT') !== -1;
  if (!hasUrl && !hasImport) return css;

  let out = css;
  if (hasUrl) {
    out = out.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, quote, urlVal) => {
      const rewritten = rewriteUrl(urlVal, baseUrl, proxyBase);
      return `url(${quote}${rewritten}${quote})`;
    });
  }
  if (hasImport) {
    out = out.replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, urlVal) => {
      const rewritten = rewriteUrl(urlVal, baseUrl, proxyBase);
      return `@import ${quote}${rewritten}${quote}`;
    });
  }
  return out;
}

/**
 * Rewrite Set-Cookie header so cookies persist on the proxy origin and work inside iframes.
 */
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

/**
 * Static, browser-cacheable client runtime served at /__proxy_runtime.js.
 * Zero per-request templating: derives proxy origin & target URL from window.location.
 */
export const CLIENT_RUNTIME_SCRIPT = `(function(){
if(window.__PROXY_RT__)return;window.__PROXY_RT__=1;
var P=location.origin,W=P.replace(/^http/i,'ws'),SKIP=/^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i;
function curTarget(){try{var p=location.pathname.substring(1)+location.search+location.hash;p=p.replace(/^(https?|wss?):\\/(?!\\/)/i,'$1://');if(/^https?:\\/\\//i.test(p))return p;}catch(e){}return location.href;}
function rwHttp(u){
  if(typeof u!=='string'){if(u&&typeof u.href==='string')u=u.href;else return u;}
  var t=u.trim();if(!t||SKIP.test(t))return u;
  if(t.indexOf(P+'/http')===0||t.indexOf(P+'/ws')===0||t.indexOf('/__proxy_')===0||t.indexOf(P+'/__proxy_')===0)return u;
  if(/^\\/(https?|wss?):\\/\\//i.test(t))return P+t;
  try{
    var r=new URL(t,curTarget());
    if(r.origin===P){
      var sub=r.pathname.substring(1).replace(/^(https?|wss?):\\/(?!\\/)/i,'$1://');
      if(/^(https?|wss?):\\/\\//i.test(sub))return P+'/'+sub+r.search+r.hash;
      r=new URL(r.pathname+r.search+r.hash,new URL(curTarget()).origin);
    }
    if(r.protocol==='http:'||r.protocol==='https:')return P+'/'+r.href;
    if(r.protocol==='ws:'||r.protocol==='wss:')return W+'/'+r.href;
  }catch(e){}
  return u;
}
function rwWs(u){
  if(typeof u!=='string'){if(u&&typeof u.href==='string')u=u.href;else return u;}
  var t=u.trim();if(!t||t.indexOf(W+'/ws')===0)return u;
  try{
    var tb=new URL(curTarget()),r=new URL(t,tb.href.replace(/^http/i,'ws'));
    if(r.origin===W){
      var sub=r.pathname.substring(1).replace(/^(wss?):\\/(?!\\/)/i,'$1://');
      if(/^wss?:\\/\\//i.test(sub))return W+'/'+sub+r.search;
      r=new URL(r.pathname+r.search,tb.origin.replace(/^http/i,'ws'));
    }
    var o=W+'/'+r.href;return o+(o.indexOf('?')===-1?'?':'&')+'__proxy_origin='+encodeURIComponent(tb.origin);
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
try{if(navigator&&navigator.serviceWorker&&navigator.serviceWorker.register){navigator.serviceWorker.register=function(){return Promise.reject(new DOMException('ServiceWorker disabled in proxy','SecurityError'));};}}catch(e){}
var oXO=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){var a=Array.prototype.slice.call(arguments);if(typeof u==='string'||u instanceof URL){a[1]=rwHttp(String(u));}return oXO.apply(this,a);};
var oWS=window.WebSocket;
if(oWS){var PWS=function(u,p){var n=rwWs(u);return arguments.length>1?new oWS(n,p):new oWS(n);};PWS.prototype=oWS.prototype;PWS.CONNECTING=oWS.CONNECTING;PWS.OPEN=oWS.OPEN;PWS.CLOSING=oWS.CLOSING;PWS.CLOSED=oWS.CLOSED;window.WebSocket=PWS;}
var oES=window.EventSource;
if(oES){var PES=function(u,c){var n=rwHttp(u);return arguments.length>1?new oES(n,c):new oES(n);};PES.prototype=oES.prototype;PES.CONNECTING=oES.CONNECTING;PES.OPEN=oES.OPEN;PES.CLOSED=oES.CLOSED;window.EventSource=PES;}
var oW=window.Worker;
if(oW){var PW=function(u,o){var n=rwHttp(u);return arguments.length>1?new oW(n,o):new oW(n);};PW.prototype=oW.prototype;window.Worker=PW;}
if(navigator&&navigator.sendBeacon){var oB=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){return oB(rwHttp(u),d);};}
function wH(fn){var o=History.prototype[fn];if(!o)return;History.prototype[fn]=function(s,t,u){if(u!==undefined&&u!==null&&u!==''){try{var n=rwHttp(String(u));if(n&&n.indexOf(P)===0)u=n.substring(P.length);}catch(e){}}return o.call(this,s,t,u);};}
wH('pushState');wH('replaceState');
var oOp=window.open;if(oOp){window.open=function(u,t,f){if(u)u=rwHttp(String(u));return oOp.call(this,u,t,f);};}
var UA={src:1,href:1,action:1,poster:1,data:1},oSA=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(k,v){var l=String(k).toLowerCase();if(l==='integrity')return;if(l==='srcset')v=rwSrcset(String(v));else if(UA[l]&&typeof v==='string'){v=rwHttp(v);}return oSA.call(this,k,v);};
function hP(pr,k,ss){if(!pr)return;var d=Object.getOwnPropertyDescriptor(pr,k);if(!d||!d.set)return;Object.defineProperty(pr,k,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){if(typeof v==='string'){v=ss?rwSrcset(v):rwHttp(v);}return d.set.call(this,v);}});}
hP(HTMLScriptElement.prototype,'src',0);hP(HTMLImageElement.prototype,'src',0);hP(HTMLImageElement.prototype,'srcset',1);hP(HTMLLinkElement.prototype,'href',0);hP(HTMLAnchorElement.prototype,'href',0);hP(HTMLFormElement.prototype,'action',0);hP(HTMLIFrameElement.prototype,'src',0);hP(HTMLSourceElement.prototype,'src',0);hP(HTMLSourceElement.prototype,'srcset',1);hP(HTMLMediaElement.prototype,'src',0);
function igP(pr,k){if(!pr)return;var d=Object.getOwnPropertyDescriptor(pr,k);if(!d||!d.configurable)return;Object.defineProperty(pr,k,{configurable:true,enumerable:d.enumerable,get:function(){return'';},set:function(){}});}
igP(HTMLScriptElement.prototype,'integrity');igP(HTMLLinkElement.prototype,'integrity');
function np(){try{if(parent&&parent!==window)parent.postMessage({type:'proxy:location',url:curTarget(),title:document.title||''},'*');}catch(e){}}
addEventListener('DOMContentLoaded',np);addEventListener('popstate',np);addEventListener('hashchange',np);
})();`;

/**
 * Fallback JS-based HTML rewriter (used only when native Cloudflare HTMLRewriter is unavailable).
 */
export function rewriteHtml(html, baseUrl, proxyBase) {
  if (!html) return html;
  let out = html.replace(/<meta\b[^>]*http-equiv\s*=\s*(['"]?)content-security-policy\1[^>]*>/gi, '');
  out = out.replace(/\s+integrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(
    /(\b(?:href|src|action|poster|data-src)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi,
    (match, prefix, dqVal, sqVal) => {
      const quote = dqVal !== undefined ? '"' : "'";
      const val = dqVal !== undefined ? dqVal : sqVal;
      return `${prefix}${quote}${rewriteUrl(val, baseUrl, proxyBase)}${quote}`;
    }
  );
  out = out.replace(
    /(\bsrcset\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi,
    (match, prefix, dqVal, sqVal) => {
      const quote = dqVal !== undefined ? '"' : "'";
      const val = dqVal !== undefined ? dqVal : sqVal;
      return `${prefix}${quote}${rewriteSrcset(val, baseUrl, proxyBase)}${quote}`;
    }
  );
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, o, b, c) => o + rewriteCss(b, baseUrl, proxyBase) + c);

  const runtimeTag = `<script src="${proxyBase}${RUNTIME_PATH}"></script>`;
  if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, (m) => `${m}\n${runtimeTag}`);
  } else if (/<html\b[^>]*>/i.test(out)) {
    out = out.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${runtimeTag}</head>`);
  } else {
    out = runtimeTag + out;
  }
  return out;
}

/**
 * Compute the best Origin header to send upstream for a proxied request.
 */
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
  return targetUrl.origin;
}

/**
 * Strip our internal __proxy_origin query param before forwarding to upstream.
 */
export function stripInternalParams(targetUrl) {
  const cleaned = new URL(targetUrl.href);
  const explicitOrigin = cleaned.searchParams.get('__proxy_origin');
  if (cleaned.searchParams.has('__proxy_origin')) {
    cleaned.searchParams.delete('__proxy_origin');
  }
  return { cleanedUrl: cleaned, explicitOrigin };
}
