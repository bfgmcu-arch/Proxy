/**
 * Self-contained Cloudflare Workers Web Proxy + Built-in Native YouTube Engine
 * Optimized for Cloudflare Workers Free Tier (10ms CPU, 128MB RAM, 100k req/day).
 * Zero external dependencies or local imports — works with `wrangler deploy`,
 * Cloudflare Git Builds, AND Cloudflare Dashboard Quick Edit copy-paste.
 */

export const PREFIX = '/-----';
export const RUNTIME_PATH = '/__proxy_runtime.js';
export const SW_PATH = '/__proxy_sw.js';
export const HEALTH_PATH = '/__proxy_health';

const MAX_CSS_REWRITE_BYTES = 1_500_000;
const STATIC_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';
const SKIP_PROTOCOLS = /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i;
const STATIC_EXT_RE =
  /\.(?:js|mjs|css|wasm|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|eot|mp3|ogg|wav|webm|avif)(?:$|\?)/i;
const COOKIE_FREE_CDNS = ['chesscomfiles.com', 'ytimg.com', 'ggpht.com', 'fonts.gstatic.com'];

// ============================================================================
// URL, Asset, Cookie, CSS, and M3U8 Rewriting Helpers
// ============================================================================

export function isStreamingMediaUrl(targetUrl) {
  const host = targetUrl.hostname.toLowerCase();
  if (host === 'googlevideo.com' || host.endsWith('.googlevideo.com')) return true;
  const p = targetUrl.pathname.toLowerCase();
  return p.includes('/videoplayback') || /\.(?:m3u8|mpd|m4s|ts)(?:$|\?)/.test(p);
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
  if (
    (host === 'www.youtube.com' || host === 'm.youtube.com') &&
    (targetUrl.pathname.startsWith('/s/player/') || targetUrl.pathname.startsWith('/s/desktop/'))
  ) {
    return true;
  }
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

/**
 * Rewrite HLS (.m3u8) playlist URLs so YouTube HD HLS streams play through the Worker.
 */
export function rewriteM3u8(manifest, baseUrl, proxyBase) {
  if (!manifest) return manifest;
  return manifest
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (m, uri) => `URI="${rewriteUrl(uri, baseUrl, proxyBase)}"`);
      }
      return rewriteUrl(trimmed, baseUrl, proxyBase);
    })
    .join('\n');
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
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ============================================================================
// Built-in Native YouTube InnerTube Engine (/yt)
// ============================================================================

export function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    const h = u.hostname.toLowerCase();
    if (h === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }
    if (h === 'youtube.com' || h.endsWith('.youtube.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      const parts = u.pathname.split('/').filter(Boolean);
      if ((parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') && parts[1]) {
        if (/^[a-zA-Z0-9_-]{11}$/.test(parts[1])) return parts[1];
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function parseStartSeconds(t) {
  if (!t) return 0;
  const s = String(t).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  const h = s.match(/(\d+)h/);
  const m = s.match(/(\d+)m/);
  const sec = s.match(/(\d+)s/);
  if (h) total += Number(h[1]) * 3600;
  if (m) total += Number(m[1]) * 60;
  if (sec) total += Number(sec[1]);
  return total;
}

/**
 * Seamlessly detect YouTube page navigations (home, watch, shorts, search, embed)
 * so any YouTube link from any website opens directly in the working player.
 * Returns null for API/asset endpoints or when ?raw=1 is explicitly requested.
 */
export function matchYouTubePageRoute(targetUrl) {
  if (!targetUrl) return null;
  if (targetUrl.searchParams.get('raw') === '1') return null;

  const h = targetUrl.hostname.toLowerCase();
  const isYtHost =
    h === 'youtube.com' ||
    h === 'www.youtube.com' ||
    h === 'm.youtube.com' ||
    h === 'youtube-nocookie.com' ||
    h === 'www.youtube-nocookie.com' ||
    h === 'youtu.be';

  if (!isYtHost) return null;

  const p = targetUrl.pathname;
  const startSeconds = parseStartSeconds(
    targetUrl.searchParams.get('t') || targetUrl.searchParams.get('start')
  );

  if (h === 'youtu.be') {
    const id = extractVideoId(p.split('/').filter(Boolean)[0]);
    return id ? { type: 'watch', videoId: id, startSeconds } : { type: 'home' };
  }

  const parts = p.split('/').filter(Boolean);
  if (parts[0] === 'embed' && parts[1]) {
    const id = extractVideoId(parts[1]);
    if (id) return { type: 'embed', videoId: id, startSeconds };
  }

  if (p === '/watch') {
    const id = extractVideoId(targetUrl.searchParams.get('v'));
    if (id) return { type: 'watch', videoId: id, startSeconds };
  }

  if (parts[0] === 'shorts') {
    const id = parts[1] ? extractVideoId(parts[1]) : '';
    return { type: 'shorts', videoId: id || '' };
  }

  if (parts[0] === 'live' && parts[1]) {
    const id = extractVideoId(parts[1]);
    if (id) return { type: 'watch', videoId: id, startSeconds };
  }

  if (p === '/results') {
    return { type: 'search', query: targetUrl.searchParams.get('search_query') || '' };
  }

  if (p === '/' || p === '' || p.startsWith('/feed/')) {
    return { type: 'home' };
  }

  return null;
}

function ytText(obj) {
  if (!obj) return '';
  if (typeof obj.simpleText === 'string') return obj.simpleText;
  if (Array.isArray(obj.runs)) return obj.runs.map((r) => r.text || '').join('');
  return '';
}

/**
 * Recursively collect videoRenderer / compactVideoRenderer items from YouTube InnerTube JSON.
 */
export function parseSearchVideos(data, limit = 30) {
  const results = [];
  const seen = new Set();

  function walk(node) {
    if (!node || typeof node !== 'object' || results.length >= limit) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && results.length < limit; i++) walk(node[i]);
      return;
    }
    const sl = node.shortsLockupViewModel;
    if (sl) {
      const id = sl.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
      if (id && !seen.has(id)) {
        seen.add(id);
        results.push({
          id,
          title: sl.overlayMetadata?.primaryText?.content || sl.accessibilityText || '',
          author: '',
          views: sl.overlayMetadata?.secondaryText?.content || '',
          length: 'SHORT',
          published: '',
          isShort: true,
        });
        return;
      }
    }
    const ri = node.reelItemRenderer;
    if (ri && ri.videoId && !seen.has(ri.videoId)) {
      seen.add(ri.videoId);
      results.push({
        id: ri.videoId,
        title: ytText(ri.headline),
        author: '',
        views: ytText(ri.viewCountText),
        length: 'SHORT',
        published: '',
        isShort: true,
      });
      return;
    }
    const vr = node.videoRenderer || node.compactVideoRenderer || node.gridVideoRenderer;
    if (vr && vr.videoId && !seen.has(vr.videoId)) {
      seen.add(vr.videoId);
      const isShort = Boolean(vr.navigationEndpoint?.reelWatchEndpoint);
      results.push({
        id: vr.videoId,
        title: ytText(vr.title),
        author: ytText(vr.ownerText || vr.longBylineText || vr.shortBylineText),
        views: ytText(vr.shortViewCountText || vr.viewCountText),
        length: isShort ? 'SHORT' : ytText(vr.lengthText),
        published: ytText(vr.publishedTimeText),
        isShort,
      });
      return;
    }
    const lvm = node.lockupViewModel;
    if (lvm && lvm.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && lvm.contentId && !seen.has(lvm.contentId)) {
      seen.add(lvm.contentId);
      const meta = lvm.metadata?.lockupMetadataViewModel;
      const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
      const author = rows[0]?.metadataParts?.[0]?.text?.content || '';
      const views = rows[1]?.metadataParts?.[0]?.text?.content || '';
      const published = rows[1]?.metadataParts?.[1]?.text?.content || '';
      const overlays = lvm.contentImage?.thumbnailViewModel?.overlays || [];
      let length = '';
      for (const ov of overlays) {
        const badge = ov?.thumbnailOverlayBadgeViewModel?.thumbnailBadges?.[0]?.thumbnailBadgeViewModel?.text;
        if (badge) { length = badge; break; }
      }
      results.push({
        id: lvm.contentId,
        title: meta?.title?.content || '',
        author,
        views,
        length,
        published,
      });
      return;
    }
    for (const key of Object.keys(node)) {
      if (results.length >= limit) break;
      walk(node[key]);
    }
  }

  walk(data);
  return results;
}

/**
 * Extract directly playable streams (muxed MP4, HLS manifest, audio-only) from InnerTube player JSON.
 */
export function extractPlayableStreams(playerJson, proxyBase) {
  const sd = playerJson?.streamingData || {};
  const vd = playerJson?.videoDetails || {};
  const status = playerJson?.playabilityStatus?.status || 'UNKNOWN';
  const reason = playerJson?.playabilityStatus?.reason || '';

  const muxed = (sd.formats || [])
    .filter((f) => typeof f.url === 'string' && f.url.length > 0)
    .map((f) => ({
      itag: f.itag,
      quality: f.qualityLabel || `${f.height || ''}p`,
      mimeType: f.mimeType || 'video/mp4',
      url: `${proxyBase}${PREFIX}${f.url}`,
    }));

  const audio = (sd.adaptiveFormats || [])
    .filter((f) => typeof f.url === 'string' && (f.mimeType || '').startsWith('audio/'))
    .map((f) => ({
      itag: f.itag,
      bitrate: f.bitrate || 0,
      mimeType: f.mimeType,
      url: `${proxyBase}${PREFIX}${f.url}`,
    }))
    .sort((a, b) => b.bitrate - a.bitrate);

  const hlsUrl = sd.hlsManifestUrl ? `${proxyBase}${PREFIX}${sd.hlsManifestUrl}` : null;

  return {
    status,
    reason,
    videoId: vd.videoId || '',
    title: vd.title || '',
    author: vd.author || '',
    views: vd.viewCount || '',
    lengthSeconds: Number(vd.lengthSeconds || 0),
    description: vd.shortDescription || '',
    muxed,
    audio,
    hlsUrl,
  };
}

const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip';
const IOS_UA = 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';
const ANDROID_VR_UA =
  'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';

const INNERTUBE_CLIENTS = [
  {
    name: 'ANDROID',
    userAgent: ANDROID_UA,
    clientHeader: '3',
    versionHeader: '20.10.38',
    body: (videoId) => ({
      videoId,
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '20.10.38',
          androidSdkVersion: 34,
          osName: 'Android',
          osVersion: '14',
          hl: 'en',
          gl: 'US',
        },
      },
    }),
  },
  {
    name: 'IOS',
    userAgent: IOS_UA,
    clientHeader: '5',
    versionHeader: '20.10.4',
    body: (videoId) => ({
      videoId,
      context: {
        client: {
          clientName: 'IOS',
          clientVersion: '20.10.4',
          deviceMake: 'Apple',
          deviceModel: 'iPhone16,2',
          osName: 'iPhone',
          osVersion: '18.3.2.22D82',
          hl: 'en',
          gl: 'US',
        },
      },
    }),
  },
  {
    name: 'ANDROID_VR',
    userAgent: ANDROID_VR_UA,
    clientHeader: '28',
    versionHeader: '1.65.10',
    body: (videoId) => ({
      videoId,
      context: {
        client: {
          clientName: 'ANDROID_VR',
          clientVersion: '1.65.10',
          deviceMake: 'Oculus',
          deviceModel: 'Quest 3',
          androidSdkVersion: 32,
          osName: 'Android',
          osVersion: '12L',
          hl: 'en',
          gl: 'US',
        },
      },
    }),
  },
  {
    name: 'TVHTML5',
    userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
    clientHeader: '7',
    versionHeader: '7.20250310.17.00',
    body: (videoId) => ({
      videoId,
      context: {
        client: {
          clientName: 'TVHTML5',
          clientVersion: '7.20250310.17.00',
          hl: 'en',
          gl: 'US',
        },
      },
    }),
  },
];

const DEFAULT_PIPED_APIS = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
];

async function probeStreamOk(rawUrl, userAgent) {
  try {
    const r = await fetch(rawUrl, {
      headers: { Range: 'bytes=0-0', 'User-Agent': userAgent || ANDROID_UA },
      redirect: 'follow',
    });
    return r.status === 200 || r.status === 206;
  } catch {
    return false;
  }
}

async function fetchPipedFallback(videoId, proxyBase, env) {
  const custom = env && env.PIPED_APIS
    ? env.PIPED_APIS.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)
    : [];
  const apis = [...custom, ...DEFAULT_PIPED_APIS];

  for (const apiBase of apis) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4500);
      const resp = await fetch(`${apiBase}/streams/${encodeURIComponent(videoId)}`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const j = await resp.json();

      const muxed = (j.videoStreams || [])
        .filter(
          (s) =>
            s &&
            typeof s.url === 'string' &&
            !s.videoOnly &&
            !/lbry/i.test(String(s.quality || '')) &&
            !s.url.includes('odycdn.com')
        )
        .map((s) => ({
          itag: s.itag || 0,
          quality: s.quality || 'MP4',
          mimeType: s.mimeType || 'video/mp4',
          url: `${proxyBase}${PREFIX}${s.url}`,
        }));

      const audio = (j.audioStreams || [])
        .filter((s) => s && typeof s.url === 'string' && !s.url.includes('odycdn.com'))
        .map((s) => ({
          itag: s.itag || 0,
          bitrate: s.bitrate || 0,
          mimeType: s.mimeType || 'audio/mp4',
          url: `${proxyBase}${PREFIX}${s.url}`,
        }))
        .sort((a, b) => b.bitrate - a.bitrate);

      const hlsUrl = j.hls ? `${proxyBase}${PREFIX}${j.hls}` : null;

      if (muxed.length > 0 || hlsUrl) {
        return {
          status: 'OK',
          reason: '',
          client: 'PIPED (' + new URL(apiBase).host + ')',
          videoId,
          title: j.title || '',
          author: j.uploader || '',
          views: String(j.views || ''),
          lengthSeconds: Number(j.duration || 0),
          description: j.description || '',
          muxed,
          audio,
          hlsUrl,
        };
      }
    } catch {
      // try next Piped instance
    }
  }
  return null;
}

async function fetchInnerTubePlayer(videoId, proxyBase, env) {
  let lastResult = null;
  const cookie = env && env.YT_COOKIE ? env.YT_COOKIE : 'CONSENT=YES+cb';

  for (const client of INNERTUBE_CLIENTS) {
    try {
      const resp = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': client.userAgent,
          'X-YouTube-Client-Name': client.clientHeader,
          'X-YouTube-Client-Version': client.versionHeader,
          Origin: 'https://www.youtube.com',
          Referer: 'https://www.youtube.com/',
          Cookie: cookie,
        },
        body: JSON.stringify(client.body(videoId)),
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      const parsed = extractPlayableStreams(json, proxyBase);
      lastResult = { ...parsed, client: client.name };
      if (parsed.status === 'OK' && (parsed.muxed.length > 0 || parsed.hlsUrl)) {
        const rawProbeUrl =
          (json.streamingData?.formats || []).find((f) => f.url)?.url ||
          json.streamingData?.hlsManifestUrl;
        if (!rawProbeUrl || (await probeStreamOk(rawProbeUrl, client.userAgent))) {
          return lastResult;
        }
      }
    } catch {
      // try next client
    }
  }

  // Fallback to Piped public API when Cloudflare datacenter IP gets LOGIN_REQUIRED or 403
  const piped = await fetchPipedFallback(videoId, proxyBase, env);
  if (piped) return piped;

  return (
    lastResult || {
      status: 'ERROR',
      reason: 'Could not extract streams from YouTube',
      videoId,
      muxed: [],
      audio: [],
      hlsUrl: null,
    }
  );
}

/**
 * Format YouTube Data API v3 ISO 8601 duration (e.g. PT3M33S -> 3:33, PT1H2M5S -> 1:02:05).
 */
export function parseIsoDuration(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return '';
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
}

async function fetchOfficialYouTubeSearch(query, apiKey, isShorts = false) {
  if (!apiKey) return null;
  try {
    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      maxResults: '24',
      key: apiKey,
    });
    if (query) {
      params.set('q', isShorts ? `${query} #shorts` : query);
    } else if (isShorts) {
      params.set('q', '#shorts');
    } else {
      // Home feed: official mostPopular chart
      const popUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&chart=mostPopular&regionCode=US&maxResults=24&key=${encodeURIComponent(apiKey)}`;
      const popResp = await fetch(popUrl);
      if (!popResp.ok) return null;
      const popJson = await popResp.json();
      return (popJson.items || []).map((it) => ({
        id: it.id,
        title: it.snippet?.title || '',
        author: it.snippet?.channelTitle || '',
        views: it.statistics?.viewCount ? `${Number(it.statistics.viewCount).toLocaleString()} views` : '',
        length: parseIsoDuration(it.contentDetails?.duration),
        published: (it.snippet?.publishedAt || '').slice(0, 10),
        isShort: false,
      }));
    }

    if (isShorts) params.set('videoDuration', 'short');
    const resp = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const items = (data.items || []).filter((it) => it?.id?.videoId);
    if (!items.length) return [];

    // Fetch durations & view counts in a single batch call
    const ids = items.map((it) => it.id.videoId).join(',');
    const metaMap = new Map();
    try {
      const mResp = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${encodeURIComponent(ids)}&key=${encodeURIComponent(apiKey)}`
      );
      if (mResp.ok) {
        const mJson = await mResp.json();
        for (const v of mJson.items || []) metaMap.set(v.id, v);
      }
    } catch {
      // optional enrichment
    }

    return items.map((it) => {
      const id = it.id.videoId;
      const meta = metaMap.get(id);
      const dur = parseIsoDuration(meta?.contentDetails?.duration);
      return {
        id,
        title: it.snippet?.title || '',
        author: it.snippet?.channelTitle || '',
        views: meta?.statistics?.viewCount
          ? `${Number(meta.statistics.viewCount).toLocaleString()} views`
          : '',
        length: isShorts ? 'SHORT' : dur,
        published: (it.snippet?.publishedAt || '').slice(0, 10),
        isShort: isShorts,
      };
    });
  } catch {
    return null;
  }
}

async function fetchOfficialYouTubeVideoMeta(videoId, apiKey) {
  if (!apiKey) return null;
  try {
    const resp = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`
    );
    if (!resp.ok) return null;
    const j = await resp.json();
    const it = j.items?.[0];
    if (!it) return null;
    return {
      title: it.snippet?.title || '',
      author: it.snippet?.channelTitle || '',
      views: it.statistics?.viewCount || '',
      description: it.snippet?.description || '',
    };
  } catch {
    return null;
  }
}

async function fetchInnerTubeSearch(query, env) {
  // Prefer official YouTube Data API v3 when YT_API_KEY secret is configured
  if (env && env.YT_API_KEY) {
    const official = await fetchOfficialYouTubeSearch(query, env.YT_API_KEY, false);
    if (official && official.length > 0) return official;
  }

  const endpoint = query
    ? 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false'
    : 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false';

  const payload = query
    ? {
        query,
        context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } },
      }
    : {
        browseId: 'FEwhat_to_watch',
        context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } },
      };

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Origin: 'https://www.youtube.com',
      Referer: 'https://www.youtube.com/',
      Cookie: env && env.YT_COOKIE ? env.YT_COOKIE : 'CONSENT=YES+cb',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return parseSearchVideos(data, 30);
}

async function fetchInnerTubeRelated(videoId, env) {
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Origin: 'https://www.youtube.com',
        Referer: 'https://www.youtube.com/',
        Cookie: env && env.YT_COOKIE ? env.YT_COOKIE : 'CONSENT=YES+cb',
      },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } },
      }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return parseSearchVideos(data, 16);
  } catch {
    return [];
  }
}

async function fetchInnerTubeShorts(query, env) {
  // Prefer official YouTube Data API v3 when YT_API_KEY secret is configured
  if (env && env.YT_API_KEY) {
    const official = await fetchOfficialYouTubeSearch(query, env.YT_API_KEY, true);
    if (official && official.length > 0) return official;
  }

  try {
    const q = query ? `${query} #shorts` : '#shorts';
    const resp = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        Origin: 'https://www.youtube.com',
        Referer: 'https://www.youtube.com/',
        Cookie: env && env.YT_COOKIE ? env.YT_COOKIE : 'CONSENT=YES+cb',
      },
      body: JSON.stringify({
        query: q,
        params: 'EgIYAQ%3D%3D',
        context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } },
      }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const all = parseSearchVideos(data, 40);
    const shortsOnly = all.filter((v) => v.isShort || /^0:\d\d$/.test(v.length));
    return shortsOnly.length > 0 ? shortsOnly.slice(0, 25) : all.slice(0, 20);
  } catch {
    return [];
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderYouTubeEmbed(videoId, startSeconds = 0) {
  const safeV = JSON.stringify(videoId);
  const safeStart = Number(startSeconds) || 0;
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YouTube Embed</title>
  <style>html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;font-family:system-ui,sans-serif;color:#fff;display:grid;place-items:center;}video{width:100%;height:100%;display:block;}</style>
</head>
<body>
  <div id="msg">Loading video…</div>
  <script>
    (async function(){
      try {
        var r = await fetch('/yt/api/player?v=' + encodeURIComponent(${safeV}));
        var p = await r.json();
        var src = (p.muxed && p.muxed[0] && p.muxed[0].url) || p.hlsUrl;
        if (!src) throw new Error(p.reason || 'No playable stream');
        document.body.innerHTML = '<video controls autoplay playsinline src="' + src.replace(/"/g,'&quot;') + '"></video>';
        var v = document.querySelector('video');
        if (${safeStart} > 0) v.addEventListener('loadedmetadata', function(){ v.currentTime = ${safeStart}; }, { once: true });
      } catch (e) {
        document.getElementById('msg').textContent = 'Video unavailable: ' + e.message;
      }
    })();
  </script>
</body>
</html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

function renderYouTubeShorts(initialVideoId = '', initialQuery = '') {
  const safeV = JSON.stringify(initialVideoId || '');
  const safeQ = escapeHtml(initialQuery || '');
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YouTube Shorts — Cloudflare Proxy</title>
  <style>
    :root { --bg:#0f0f0f; --surf:#1c1c1c; --hover:#2a2a2a; --border:#303030; --text:#f1f1f1; --muted:#aaa; --red:#ff0033; }
    * { box-sizing:border-box; }
    html, body { margin:0; padding:0; height:100%; background:var(--bg); color:var(--text); font-family:system-ui,-apple-system,Roboto,sans-serif; overflow:hidden; }
    header { height:56px; display:flex; align-items:center; gap:.65rem; padding:0 1rem; background:rgba(15,15,15,.95); border-bottom:1px solid var(--border); }
    .logo { display:flex; align-items:center; gap:.35rem; font-weight:800; font-size:1.05rem; color:#fff; text-decoration:none; white-space:nowrap; }
    .logo span { background:var(--red); color:#fff; padding:.1rem .4rem; border-radius:6px; font-size:.85rem; }
    form.search { display:flex; flex:1; max-width:420px; }
    form.search input { flex:1; background:#121212; border:1px solid var(--border); border-right:none; border-radius:20px 0 0 20px; padding:.4rem .85rem; color:#fff; font-size:.88rem; outline:none; }
    form.search button { background:var(--hover); border:1px solid var(--border); border-radius:0 20px 20px 0; padding:.4rem .9rem; color:#fff; cursor:pointer; font-weight:600; font-size:.85rem; }
    .nav-btn { background:var(--surf); border:1px solid var(--border); color:var(--text); border-radius:8px; padding:.4rem .7rem; font-size:.82rem; text-decoration:none; cursor:pointer; font-weight:600; white-space:nowrap; }
    .nav-btn:hover { background:var(--hover); }
    .stage { height:calc(100vh - 56px); display:flex; align-items:center; justify-content:center; gap:1rem; padding:12px; position:relative; }
    .reel { position:relative; height:100%; max-height:860px; aspect-ratio:9/16; max-width:100%; background:#000; border-radius:16px; overflow:hidden; box-shadow:0 16px 48px rgba(0,0,0,.7); border:1px solid var(--border); display:grid; place-items:center; }
    .reel video, .reel iframe { width:100%; height:100%; object-fit:cover; display:block; border:none; }
    .overlay { position:absolute; left:0; right:0; bottom:0; padding:1rem; background:linear-gradient(transparent, rgba(0,0,0,.85)); pointer-events:none; }
    .overlay .stitle { font-weight:700; font-size:.95rem; line-height:1.3; margin-bottom:.25rem; text-shadow:0 1px 3px rgba(0,0,0,.8); }
    .overlay .smeta { font-size:.8rem; color:#ddd; }
    .controls { display:flex; flex-direction:column; gap:.65rem; align-items:center; }
    .ctrl-btn { width:46px; height:46px; border-radius:50%; background:var(--surf); border:1px solid var(--border); color:#fff; font-size:1.15rem; cursor:pointer; display:grid; place-items:center; transition:background .12s,transform .12s; }
    .ctrl-btn:hover { background:var(--hover); transform:scale(1.06); }
    .counter { font-size:.76rem; color:var(--muted); }
    @media (max-width:640px) { .controls { position:fixed; right:10px; bottom:90px; z-index:10; } .stage { padding:6px; } }
  </style>
</head>
<body>
  <header>
    <a class="logo" href="/shorts"><span>⚡</span> Shorts</a>
    <form class="search" id="sh-search">
      <input type="text" id="sq" value="${safeQ}" placeholder="Filter Shorts topic (e.g. chess, gaming)…">
      <button type="submit">Go</button>
    </form>
    <a class="nav-btn" href="/yt">▶ YouTube</a>
    <a class="nav-btn" href="/">🌐 Proxy</a>
  </header>
  <div class="stage" id="stage">
    <div class="reel" id="reel">
      <div id="status" style="color:#aaa;padding:1rem;text-align:center;">Loading Shorts…</div>
    </div>
    <div class="controls">
      <button class="ctrl-btn" id="prev-btn" title="Previous Short (↑)">▲</button>
      <div class="counter" id="counter">1 / 1</div>
      <button class="ctrl-btn" id="next-btn" title="Next Short (↓)">▼</button>
      <button class="ctrl-btn" id="mute-btn" title="Mute / Unmute (M)">🔊</button>
      <a class="ctrl-btn" id="watch-link" href="/yt" title="Open in full Watch page" style="text-decoration:none;font-size:.9rem;">⛶</a>
    </div>
  </div>
  <script>
    (function () {
      const PREFIX = ${JSON.stringify(PREFIX)};
      const reel = document.getElementById('reel');
      const counter = document.getElementById('counter');
      const muteBtn = document.getElementById('mute-btn');
      const watchLink = document.getElementById('watch-link');
      const sq = document.getElementById('sq');

      let queue = [];
      let idx = 0;
      let muted = false;
      let wheelLock = false;
      let touchStartY = 0;

      function esc(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }

      async function playAt(i) {
        if (!queue.length) {
          reel.innerHTML = '<div style="color:#aaa;padding:1rem;text-align:center;">No Shorts found. Try a different topic above.</div>';
          return;
        }
        idx = ((i % queue.length) + queue.length) % queue.length;
        const item = queue[idx];
        counter.textContent = (idx + 1) + ' / ' + queue.length;
        watchLink.href = '/watch?v=' + encodeURIComponent(item.id);
        try { history.replaceState(null, '', '/shorts/' + encodeURIComponent(item.id)); } catch (e) {}

        reel.innerHTML = '<div style="color:#aaa;padding:1rem;text-align:center;">Loading Short…</div>';

        try {
          const resp = await fetch('/yt/api/player?v=' + encodeURIComponent(item.id));
          const p = await resp.json();
          const title = p.title || item.title || 'YouTube Short';
          const author = p.author || item.author || '';
          document.title = title + ' — Shorts';

          const src = (p.muxed && p.muxed[0] && p.muxed[0].url) || p.hlsUrl;
          if (src) {
            reel.innerHTML =
              '<video id="svid" loop autoplay playsinline' + (muted ? ' muted' : '') + ' src="' + esc(src) + '"></video>' +
              '<div class="overlay"><div class="stitle">' + esc(title) + '</div>' +
              (author ? '<div class="smeta">' + esc(author) + '</div>' : '') + '</div>';
            const v = document.getElementById('svid');
            v.addEventListener('click', function () { v.paused ? v.play() : v.pause(); });
            v.play().catch(function () { v.muted = true; muted = true; muteBtn.textContent = '🔇'; v.play().catch(function(){}); });
          } else {
            reel.innerHTML =
              '<iframe src="' + PREFIX + 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(item.id) + '?autoplay=1&loop=1&playlist=' + encodeURIComponent(item.id) + '&raw=1" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>';
          }
        } catch (e) {
          reel.innerHTML = '<div style="color:#aaa;padding:1rem;text-align:center;">Could not load Short: ' + esc(e.message) + '</div>';
        }
      }

      document.getElementById('prev-btn').addEventListener('click', function () { playAt(idx - 1); });
      document.getElementById('next-btn').addEventListener('click', function () { playAt(idx + 1); });

      muteBtn.addEventListener('click', function () {
        muted = !muted;
        muteBtn.textContent = muted ? '🔇' : '🔊';
        const v = document.getElementById('svid');
        if (v) v.muted = muted;
      });

      document.addEventListener('keydown', function (ev) {
        if (ev.target && ev.target.tagName === 'INPUT') return;
        if (ev.key === 'ArrowDown' || ev.key === 'j' || ev.key === 'J') { ev.preventDefault(); playAt(idx + 1); }
        else if (ev.key === 'ArrowUp' || ev.key === 'k' || ev.key === 'K') { ev.preventDefault(); playAt(idx - 1); }
        else if (ev.key === ' ') { ev.preventDefault(); const v = document.getElementById('svid'); if (v) v.paused ? v.play() : v.pause(); }
        else if (ev.key === 'm' || ev.key === 'M') { muteBtn.click(); }
      });

      document.getElementById('stage').addEventListener('wheel', function (ev) {
        if (wheelLock || Math.abs(ev.deltaY) < 25) return;
        wheelLock = true;
        setTimeout(function () { wheelLock = false; }, 450);
        playAt(ev.deltaY > 0 ? idx + 1 : idx - 1);
      }, { passive: true });

      reel.addEventListener('touchstart', function (ev) { touchStartY = ev.touches[0].clientY; }, { passive: true });
      reel.addEventListener('touchend', function (ev) {
        const dy = touchStartY - ev.changedTouches[0].clientY;
        if (Math.abs(dy) > 45) playAt(dy > 0 ? idx + 1 : idx - 1);
      }, { passive: true });

      document.getElementById('sh-search').addEventListener('submit', function (e) {
        e.preventDefault();
        window.location.href = '/shorts?q=' + encodeURIComponent(sq.value.trim());
      });

      (async function init() {
        const initV = ${safeV};
        const initQ = ${JSON.stringify(safeQ)};
        try {
          const resp = await fetch('/yt/api/shorts' + (initQ ? '?q=' + encodeURIComponent(initQ) : ''));
          const data = await resp.json();
          queue = data.videos || [];
        } catch (e) {
          queue = [];
        }
        if (initV) {
          const existing = queue.findIndex(function (x) { return x.id === initV; });
          if (existing !== -1) {
            idx = existing;
          } else {
            queue.unshift({ id: initV, title: '' });
            idx = 0;
          }
        }
        playAt(idx);
      })();
    })();
  </script>
</body>
</html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } }
  );
}

function renderYouTubeShell(proxyBase, initialQuery, initialVideoId, startSeconds = 0) {
  const safeQ = escapeHtml(initialQuery || '');
  const safeV = escapeHtml(initialVideoId || '');
  const safeStart = Number(startSeconds) || 0;
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YouTube — Cloudflare Proxy</title>
  <style>
    :root { --bg:#0f0f0f; --surf:#1c1c1c; --hover:#272727; --border:#303030; --text:#f1f1f1; --muted:#aaa; --red:#ff0033; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:system-ui,-apple-system,Roboto,sans-serif; }
    header { position:sticky; top:0; z-index:20; display:flex; align-items:center; gap:.75rem; padding:.6rem 1rem; background:rgba(15,15,15,.95); backdrop-filter:blur(8px); border-bottom:1px solid var(--border); flex-wrap:wrap; }
    .logo { display:flex; align-items:center; gap:.4rem; font-weight:800; font-size:1.1rem; color:#fff; text-decoration:none; }
    .logo span { background:var(--red); color:#fff; padding:.1rem .45rem; border-radius:6px; font-size:.9rem; }
    form.search { display:flex; flex:1; max-width:600px; min-width:200px; }
    form.search input { flex:1; background:#121212; border:1px solid var(--border); border-right:none; border-radius:20px 0 0 20px; padding:.5rem 1rem; color:#fff; font-size:.95rem; outline:none; }
    form.search input:focus { border-color:#3ea6ff; }
    form.search button { background:var(--hover); border:1px solid var(--border); border-radius:0 20px 20px 0; padding:.5rem 1.1rem; color:#fff; cursor:pointer; font-weight:600; }
    .nav-btn { background:var(--surf); border:1px solid var(--border); color:var(--text); border-radius:8px; padding:.45rem .75rem; font-size:.84rem; text-decoration:none; cursor:pointer; font-weight:600; }
    .nav-btn:hover { background:var(--hover); }
    main { max-width:1400px; margin:0 auto; padding:1rem; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:1.1rem; }
    .card { display:flex; flex-direction:column; text-decoration:none; color:inherit; background:var(--surf); border-radius:12px; overflow:hidden; border:1px solid transparent; transition:transform .12s,border-color .12s; }
    .card:hover { transform:translateY(-2px); border-color:var(--border); }
    .thumb-wrap { position:relative; aspect-ratio:16/9; background:#000; }
    .thumb-wrap img { width:100%; height:100%; object-fit:cover; display:block; }
    .dur { position:absolute; right:6px; bottom:6px; background:rgba(0,0,0,.85); color:#fff; font-size:.74rem; font-weight:700; padding:2px 5px; border-radius:4px; }
    .meta { padding:.65rem .75rem; }
    .title { font-weight:600; font-size:.92rem; line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; margin-bottom:.35rem; }
    .sub { color:var(--muted); font-size:.8rem; }
    .watch-layout { display:grid; grid-template-columns:1fr 360px; gap:1.25rem; }
    @media (max-width:960px) { .watch-layout { grid-template-columns:1fr; } }
    .player-box { width:100%; aspect-ratio:16/9; background:#000; border-radius:12px; overflow:hidden; }
    .player-box video, .player-box iframe { width:100%; height:100%; display:block; border:none; }
    .watch-bar { display:flex; align-items:center; justify-content:space-between; gap:.5rem; margin-top:.75rem; flex-wrap:wrap; }
    .watch-bar select { background:var(--surf); color:#fff; border:1px solid var(--border); border-radius:8px; padding:.4rem .65rem; font-size:.85rem; }
    .watch-title { margin:.75rem 0 .25rem; font-size:1.25rem; }
    .watch-author { color:var(--muted); font-size:.9rem; margin-bottom:.75rem; }
    .desc { background:var(--surf); border-radius:10px; padding:.85rem; font-size:.86rem; color:#ddd; white-space:pre-wrap; max-height:180px; overflow-y:auto; }
    .related { display:flex; flex-direction:column; gap:.75rem; }
    .rel-card { display:flex; gap:.6rem; text-decoration:none; color:inherit; }
    .rel-card .thumb-wrap { width:150px; flex-shrink:0; border-radius:8px; overflow:hidden; }
    .status { text-align:center; padding:2.5rem 1rem; color:var(--muted); }
  </style>
</head>
<body>
  <header>
    <a class="logo" href="/yt"><span>▶</span> YouTube</a>
    <form class="search" id="yt-search">
      <input type="text" id="q" value="${safeQ}" placeholder="Search YouTube or paste a YouTube URL…">
      <button type="submit">Search</button>
    </form>
    <a class="nav-btn" href="/shorts">⚡ Shorts</a>
    <a class="nav-btn" href="/">🌐 All-Sites Proxy</a>
    <a class="nav-btn" href="/__proxy_go?url=https%3A%2F%2Fwww.chess.com%2Fplay">♟ Chess.com</a>
  </header>
  <main id="app"><div class="status">Loading…</div></main>
  <script>
    (function () {
      const PREFIX = ${JSON.stringify(PREFIX)};
      const app = document.getElementById('app');
      const qInput = document.getElementById('q');

      function esc(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }

      function thumbUrl(id) {
        return PREFIX + 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/hqdefault.jpg';
      }

      function renderGrid(videos) {
        if (!videos || !videos.length) {
          app.innerHTML = '<div class="status">No videos found. Try searching for a topic or pasting a YouTube video URL.</div>';
          return;
        }
        app.innerHTML = '<div class="grid">' + videos.map(function (v) {
          const href = v.isShort ? '/shorts/' + encodeURIComponent(v.id) : '/watch?v=' + encodeURIComponent(v.id);
          return '<a class="card" href="' + href + '">' +
            '<div class="thumb-wrap"><img loading="lazy" src="' + thumbUrl(v.id) + '" alt="">' +
            (v.length ? '<span class="dur">' + esc(v.length) + '</span>' : '') + '</div>' +
            '<div class="meta"><div class="title">' + esc(v.title) + '</div>' +
            '<div class="sub">' + esc(v.author) + (v.views ? ' • ' + esc(v.views) : '') + (v.published ? ' • ' + esc(v.published) : '') + '</div></div></a>';
        }).join('') + '</div>';
      }

      async function loadSearch(q) {
        app.innerHTML = '<div class="status">Loading YouTube' + (q ? ' search for "' + esc(q) + '"' : ' home feed') + '…</div>';
        try {
          const resp = await fetch('/yt/api/search' + (q ? '?q=' + encodeURIComponent(q) : ''));
          const data = await resp.json();
          renderGrid(data.videos || []);
        } catch (e) {
          app.innerHTML = '<div class="status">Failed to load YouTube feed: ' + esc(e.message) + '</div>';
        }
      }

      async function loadWatch(videoId, startSec) {
        app.innerHTML = '<div class="status">Resolving video streams via Cloudflare Worker…</div>';
        try {
          const [playerResp, relResp] = await Promise.all([
            fetch('/yt/api/player?v=' + encodeURIComponent(videoId)),
            fetch('/yt/api/related?v=' + encodeURIComponent(videoId))
          ]);
          const p = await playerResp.json();
          const rel = await relResp.json();
          if (p.title) document.title = p.title + ' — YouTube';

          const streams = [];
          (p.muxed || []).forEach(function (m) {
            streams.push({ label: (m.quality || 'MP4') + ' (Direct MP4)', url: m.url, type: 'video' });
          });
          if (p.hlsUrl) {
            streams.push({ label: 'Auto HD (HLS)', url: p.hlsUrl, type: 'hls' });
          }
          if (p.audio && p.audio.length) {
            streams.push({ label: 'Audio Only', url: p.audio[0].url, type: 'audio' });
          }

          const prefOfficial = localStorage.getItem('yt_player_mode') === 'official';
          function officialEmbedHtml() {
            return '<iframe src="https://www.youtube-nocookie.com/embed/' + encodeURIComponent(videoId) + '?autoplay=1' + (startSec > 0 ? '&start=' + startSec : '') + '" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>';
          }

          let playerHtml = '';
          if (!prefOfficial && streams.length > 0) {
            playerHtml = '<video id="vid" controls autoplay playsinline src="' + esc(streams[0].url) + '"></video>';
          } else {
            playerHtml = officialEmbedHtml();
          }

          const optionsHtml = streams.map(function (s, i) {
            return '<option value="' + i + '">' + esc(s.label) + '</option>';
          }).join('');

          const relHtml = (rel.videos || []).map(function (v) {
            return '<a class="rel-card" href="/watch?v=' + encodeURIComponent(v.id) + '">' +
              '<div class="thumb-wrap"><img loading="lazy" src="' + thumbUrl(v.id) + '" alt="">' +
              (v.length ? '<span class="dur">' + esc(v.length) + '</span>' : '') + '</div>' +
              '<div><div class="title">' + esc(v.title) + '</div><div class="sub">' + esc(v.author) + (v.views ? ' • ' + esc(v.views) : '') + '</div></div></a>';
          }).join('');

          app.innerHTML =
            '<div class="watch-layout"><div>' +
            '<div class="player-box" id="player-box">' + playerHtml + '</div>' +
            '<div class="watch-bar">' +
              (streams.length ? '<select id="q-sel">' + optionsHtml + '</select>' : '<span class="sub">Official YouTube Player</span>') +
              '<div style="display:flex;gap:.4rem;flex-wrap:wrap;">' +
                '<button class="nav-btn" id="mode-btn">' + (prefOfficial || !streams.length ? 'Direct Proxy Stream' : 'Official YT Player') + '</button>' +
                '<a class="nav-btn" href="/__proxy_go?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + videoId + '&raw=1') + '">Raw YouTube</a>' +
              '</div>' +
            '</div>' +
            '<h1 class="watch-title">' + esc(p.title || 'YouTube Video') + '</h1>' +
            '<div class="watch-author">' + esc(p.author || '') + (p.views ? ' • ' + Number(p.views).toLocaleString() + ' views' : '') + (p.client ? ' • via ' + esc(p.client) : '') + '</div>' +
            (p.description ? '<div class="desc">' + esc(p.description) + '</div>' : '') +
            '</div><aside class="related">' + relHtml + '</aside></div>';

          const modeBtn = document.getElementById('mode-btn');
          if (modeBtn) {
            modeBtn.addEventListener('click', function () {
              const box = document.getElementById('player-box');
              const currentlyOfficial = !document.getElementById('vid');
              if (currentlyOfficial && streams.length > 0) {
                localStorage.setItem('yt_player_mode', 'direct');
                box.innerHTML = '<video id="vid" controls autoplay playsinline src="' + esc(streams[0].url) + '"></video>';
                modeBtn.textContent = 'Official YT Player';
              } else {
                localStorage.setItem('yt_player_mode', 'official');
                box.innerHTML = officialEmbedHtml();
                modeBtn.textContent = 'Direct Proxy Stream';
              }
            });
          }

          const vidEl = document.getElementById('vid');
          if (vidEl && startSec > 0) {
            vidEl.addEventListener('loadedmetadata', function () { vidEl.currentTime = startSec; }, { once: true });
          }

          const sel = document.getElementById('q-sel');
          if (sel) {
            sel.addEventListener('change', function () {
              const s = streams[Number(sel.value)];
              const box = document.getElementById('player-box');
              const cur = document.getElementById('vid');
              const t = cur ? cur.currentTime : 0;
              box.innerHTML = '<video id="vid" controls autoplay playsinline src="' + esc(s.url) + '"></video>';
              const nv = document.getElementById('vid');
              nv.addEventListener('loadedmetadata', function () { if (t > 0) nv.currentTime = t; }, { once: true });
            });
          }

          // YouTube-style keyboard shortcuts
          document.addEventListener('keydown', function (ev) {
            if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
            const v = document.getElementById('vid');
            if (!v) return;
            if (ev.key === ' ' || ev.key === 'k' || ev.key === 'K') { ev.preventDefault(); v.paused ? v.play() : v.pause(); }
            else if (ev.key === 'j' || ev.key === 'J') v.currentTime = Math.max(0, v.currentTime - 10);
            else if (ev.key === 'l' || ev.key === 'L') v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
            else if (ev.key === 'm' || ev.key === 'M') v.muted = !v.muted;
            else if (ev.key === 'f' || ev.key === 'F') { document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen?.(); }
          });
        } catch (e) {
          app.innerHTML = '<div class="status">Error loading video: ' + esc(e.message) + '</div>';
        }
      }

      document.getElementById('yt-search').addEventListener('submit', function (e) {
        e.preventDefault();
        const val = qInput.value.trim();
        if (!val) return;
        const m = val.match(/(?:v=|youtu\\.be\\/|shorts\\/|embed\\/)([a-zA-Z0-9_-]{11})/);
        if (m) {
          window.location.href = '/watch?v=' + encodeURIComponent(m[1]);
        } else {
          window.location.href = '/results?search_query=' + encodeURIComponent(val);
        }
      });

      const initV = ${JSON.stringify(safeV)};
      const initQ = ${JSON.stringify(safeQ)};
      const initStart = ${safeStart};
      if (initV) loadWatch(initV, initStart);
      else loadSearch(initQ);
    })();
  </script>
</body>
</html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    }
  );
}

// ============================================================================
// Service Worker & Client Runtime Scripts (for All-Websites Proxy)
// ============================================================================

export const SERVICE_WORKER_SCRIPT = `const PREFIX = '${PREFIX}';

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
      p === '/yt' ||
      p.startsWith('/yt/') ||
      p === '/watch' ||
      p === '/results' ||
      p.startsWith('/shorts/') ||
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

export const CLIENT_RUNTIME_SCRIPT = `(function(){
if(window.__PROXY_RT__)return;window.__PROXY_RT__=1;
var PRE='${PREFIX}',P=location.origin,W=P.replace(/^http/i,'ws'),SKIP=/^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i;
try{if('serviceWorker' in navigator&&!navigator.serviceWorker.controller){navigator.serviceWorker.register('${SW_PATH}',{scope:'/'}).catch(function(){});}}catch(e){}
function curTarget(){
  try{
    var pn=location.pathname;
    var p=(pn.indexOf(PRE)===0?pn.substring(PRE.length):pn.substring(1))+location.search+location.hash;
    p=p.replace(/^(https?|wss?):\\/(?!\\/)/i,'$1://');
    if(/^https?:\\/\\//i.test(p))return p;
  }catch(e){}
  return location.href;
}
function rwHttp(u){
  if(typeof u!=='string'){if(u&&typeof u.href==='string')u=u.href;else return u;}
  var t=u.trim();if(!t||SKIP.test(t))return u;
  if(t.indexOf(P+PRE)===0||t.indexOf(PRE)===0||t.indexOf(P+'/http')===0||t.indexOf(P+'/ws')===0||t.indexOf('/__proxy_')===0||t.indexOf(P+'/__proxy_')===0)return u;
  if(/^\\/(https?|wss?):\\/\\//i.test(t))return P+PRE+t.substring(1);
  try{
    var r=new URL(t,curTarget());
    if(r.origin===P){
      var pn=r.pathname;
      var sub=(pn.indexOf(PRE)===0?pn.substring(PRE.length):pn.substring(1)).replace(/^(https?|wss?):\\/(?!\\/)/i,'$1://');
      if(/^(https?|wss?):\\/\\//i.test(sub))return P+PRE+sub+r.search+r.hash;
      r=new URL(r.pathname+r.search+r.hash,new URL(curTarget()).origin);
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
function wH(fn){var o=History.prototype[fn];if(!o)return;History.prototype[fn]=function(s,t,u){if(u!==undefined&&u!==null&&u!==''){try{var n=rwHttp(String(u));if(n&&n.indexOf(P)===0)u=n.substring(P.length);}catch(e){}}return o.call(this,s,t,u);};}
wH('pushState');wH('replaceState');
var oOp=window.open;if(oOp){window.open=function(u,t,f){if(u)u=rwHttp(String(u));return oOp.call(this,u,t,f);};}
var UA={src:1,href:1,action:1,poster:1,data:1},oSA=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(k,v){var l=String(k).toLowerCase();if(l==='integrity')return;if(l==='srcset')v=rwSrcset(String(v));else if(UA[l]&&typeof v==='string'){v=rwHttp(v);}return oSA.call(this,k,v);};
function hP(pr,k,ss){if(!pr)return;var d=Object.getOwnPropertyDescriptor(pr,k);if(!d||!d.set)return;Object.defineProperty(pr,k,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){if(typeof v==='string'){v=ss?rwSrcset(v):rwHttp(v);}return d.set.call(this,v);}});}
hP(HTMLScriptElement.prototype,'src',0);hP(HTMLImageElement.prototype,'src',0);hP(HTMLImageElement.prototype,'srcset',1);hP(HTMLLinkElement.prototype,'href',0);hP(HTMLAnchorElement.prototype,'href',0);hP(HTMLFormElement.prototype,'action',0);hP(HTMLIFrameElement.prototype,'src',0);hP(HTMLSourceElement.prototype,'src',0);hP(HTMLSourceElement.prototype,'srcset',1);hP(HTMLMediaElement.prototype,'src',0);
function igP(pr,k){if(!pr)return;var d=Object.getOwnPropertyDescriptor(pr,k);if(!d||!d.configurable)return;Object.defineProperty(pr,k,{configurable:true,enumerable:d.enumerable,get:function(){return'';},set:function(){}});}
igP(HTMLScriptElement.prototype,'integrity');igP(HTMLLinkElement.prototype,'integrity');
})();`;

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
          // { html: true } prevents escaping CSS selectors like `>` or quotes!
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
  <p>Starting proxy service worker…</p>
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
          youtube: true,
          ytApiKeyConfigured: Boolean(env && env.YT_API_KEY),
          ytCookieConfigured: Boolean(env && env.YT_COOKIE),
          websockets: true,
          serviceWorker: true,
          streamingHtml: typeof HTMLRewriter !== 'undefined',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } }
      );
    }

    // 4. Seamless YouTube Routes (/yt, /watch, /results, /shorts/*, /yt/api/*)
    if (url.pathname === '/yt' || url.pathname === '/yt/') {
      const q = url.searchParams.get('q') || '';
      const vid = extractVideoId(q);
      if (vid) {
        return Response.redirect(`${proxyBase}/watch?v=${vid}`, 302);
      }
      return renderYouTubeShell(proxyBase, q, '');
    }

    if (url.pathname === '/yt/watch' || url.pathname === '/watch') {
      const v = extractVideoId(url.searchParams.get('v') || '');
      if (!v) return Response.redirect(`${proxyBase}/yt`, 302);
      const startSec = parseStartSeconds(url.searchParams.get('t') || url.searchParams.get('start'));
      return renderYouTubeShell(proxyBase, '', v, startSec);
    }

    if (url.pathname === '/results') {
      return renderYouTubeShell(proxyBase, url.searchParams.get('search_query') || '', '');
    }

    if (url.pathname === '/shorts' || url.pathname.startsWith('/shorts/')) {
      const v = extractVideoId(url.pathname.split('/').filter(Boolean)[1] || '');
      const q = url.searchParams.get('q') || '';
      return renderYouTubeShorts(v || '', q);
    }

    if (url.pathname === '/yt/api/shorts') {
      const q = url.searchParams.get('q') || '';
      const videos = await fetchInnerTubeShorts(q, env);
      return new Response(JSON.stringify({ videos }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120', ...corsHeaders(request) },
      });
    }

    if (url.pathname === '/yt/api/search') {
      const q = url.searchParams.get('q') || '';
      const videos = await fetchInnerTubeSearch(q, env);
      return new Response(JSON.stringify({ videos }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120', ...corsHeaders(request) },
      });
    }

    if (url.pathname === '/yt/api/player') {
      const v = extractVideoId(url.searchParams.get('v') || '');
      if (!v) {
        return new Response(JSON.stringify({ error: 'Invalid video ID' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
        });
      }
      const data = await fetchInnerTubePlayer(v, proxyBase, env);
      if (env && env.YT_API_KEY && !data.title) {
        const meta = await fetchOfficialYouTubeVideoMeta(v, env.YT_API_KEY);
        if (meta) Object.assign(data, meta);
      }
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request) },
      });
    }

    if (url.pathname === '/yt/api/related') {
      const v = extractVideoId(url.searchParams.get('v') || '');
      const videos = v ? await fetchInnerTubeRelated(v, env) : [];
      return new Response(JSON.stringify({ videos }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...corsHeaders(request) },
      });
    }

    // 5. Service Worker & Client Runtime
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

    // 6. Root Launcher UI (100% Cloudflare Workers)
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
    .container { background: #262421; border: 1px solid #3a3733; padding: 2rem; border-radius: 14px; box-shadow: 0 14px 36px rgba(0,0,0,0.5); width: min(480px, 92vw); }
    h2 { margin: 0 0 0.4rem; font-size: 1.4rem; }
    p { margin: 0 0 1.1rem; color: #a6a39e; font-size: 0.86rem; }
    form { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
    input[type="text"] { flex: 1; padding: 0.65rem 0.8rem; border: 1px solid #3a3733; border-radius: 8px; background: #161512; color: #fff; font-size: 0.94rem; }
    button, a.btn { padding: 0.65rem 1rem; background: #81b64c; color: #161512; border: none; border-radius: 8px; cursor: pointer; font-weight: 700; text-decoration: none; display: inline-block; text-align: center; }
    button:hover, a.btn:hover { background: #95cc5d; }
    .quick { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .quick a.btn { background: #33302c; color: #ecebe8; font-size: 0.85rem; font-weight: 600; border: 1px solid #3a3733; }
    .quick a.btn.yt { background: #ff0033; color: #fff; border-color: #ff0033; }
    .quick a.btn.yt:hover { background: #d9002b; }
    .quick a.btn:hover { background: #403d38; }
    .sw-status { margin-top: 0.9rem; font-size: 0.78rem; color: #81b64c; }
  </style>
</head>
<body>
  <div class="container">
    <h2>🌐 Cloudflare Web Proxy</h2>
    <p>100% Cloudflare Workers • Built-in Fast YouTube Player • All Websites</p>
    <form action="/" method="GET" id="proxy-form">
      <input type="text" name="url" placeholder="Enter any URL (YouTube, Chess.com, etc.)" required>
      <button type="submit">Go</button>
    </form>
    <div class="quick">
      <a class="btn yt" href="/yt">▶ YouTube</a>
      <a class="btn yt" href="/shorts">⚡ Shorts</a>
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
            el.textContent = '✓ Service Worker active';
          }
        } catch (e) { el.textContent = 'Ready'; }
      })();

      async function go(raw) {
        var val = raw.trim();
        var shMatch = val.match(/youtube\\.com\\/shorts\\/([a-zA-Z0-9_-]{11})/i);
        if (shMatch) { window.location.href = '/shorts/' + shMatch[1]; return; }
        if (/^(?:https?:\\/\\/)?(?:www\\.|m\\.)?youtube\\.com\\/shorts\\/?$/i.test(val)) { window.location.href = '/shorts'; return; }
        var ytMatch = val.match(/(?:youtube\\.com\\/watch\\?[^#]*v=|youtu\\.be\\/)([a-zA-Z0-9_-]{11})/i);
        if (ytMatch) { window.location.href = '/watch?v=' + ytMatch[1]; return; }
        if (/^(?:https?:\\/\\/)?(?:www\\.|m\\.)?youtube\\.com\\/?$/i.test(val)) { window.location.href = '/yt'; return; }
        await swReady;
        if (!/^https?:\\/\\//i.test(val)) val = 'https://' + val;
        window.location.href = '${PREFIX}' + val;
      }

      document.getElementById('proxy-form').addEventListener('submit', function(e) {
        e.preventDefault();
        go(document.querySelector('input[name="url"]').value);
      });
      document.querySelectorAll('.quick a[data-url]').forEach(function(a) {
        a.addEventListener('click', function(e) { e.preventDefault(); go(a.getAttribute('data-url')); });
      });
    </script>
  </div>
</body>
</html>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' } }
      );
    }

    // 7. Resolve target URL
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

    // Seamlessly connect any proxied YouTube page or third-party embed to the working player
    if (request.method === 'GET' && !isWebSocket) {
      const ytRoute = matchYouTubePageRoute(fetchUrl);
      if (ytRoute) {
        if (ytRoute.type === 'embed') return renderYouTubeEmbed(ytRoute.videoId, ytRoute.startSeconds);
        if (ytRoute.type === 'shorts') return renderYouTubeShorts(ytRoute.videoId, '');
        if (ytRoute.type === 'watch') return renderYouTubeShell(proxyBase, '', ytRoute.videoId, ytRoute.startSeconds);
        if (ytRoute.type === 'search') return renderYouTubeShell(proxyBase, ytRoute.query, '');
        if (ytRoute.type === 'home') return renderYouTubeShell(proxyBase, '', '');
      }
    }
    if (fetchUrl.searchParams.get('raw') === '1') {
      fetchUrl.searchParams.delete('raw');
    }

    const isStreamingMedia = isStreamingMediaUrl(fetchUrl);

    // 8. Check Cloudflare Edge Cache for GET static assets (never cache videoplayback streams)
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

    // 9. Build upstream headers
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
    if (newHeaders.has('x-origin')) {
      newHeaders.set('x-origin', upstreamOrigin);
    }
    if (isGoogleVideo) {
      newHeaders.set('Referer', 'https://www.youtube.com/');
      const cParam = (fetchUrl.searchParams.get('c') || '').toUpperCase();
      if (cParam === 'ANDROID') newHeaders.set('User-Agent', ANDROID_UA);
      else if (cParam === 'IOS') newHeaders.set('User-Agent', IOS_UA);
    } else if (refererHeader) {
      const refTarget = extractProxiedTarget(refererHeader);
      newHeaders.set('Referer', refTarget ? refTarget.href : fetchUrl.origin + '/');
    }

    if (isYouTube) {
      const existingCookie = newHeaders.get('cookie') || '';
      if (!existingCookie.includes('CONSENT=')) {
        newHeaders.set('cookie', existingCookie ? `${existingCookie}; CONSENT=YES+cb` : 'CONSENT=YES+cb');
      }
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

    // 10. WebSocket passthrough
    if (isWebSocket) {
      try {
        const wsResp = await fetch(fetchUrl.href, { headers: newHeaders });
        if (wsResp.webSocket) return new Response(null, { status: 101, webSocket: wsResp.webSocket });
        return wsResp;
      } catch (e) {
        return new Response('WebSocket proxy error: ' + e.message, { status: 502 });
      }
    }

    // 11. Fetch upstream (follow 302s transparently for googlevideo.com media streams)
    const fetchInit = {
      method: request.method,
      headers: newHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
      redirect: isStreamingMedia ? 'follow' : 'manual',
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

    // 12. Streaming HTML rewriting
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

    // 13. HLS (.m3u8) manifest rewriting for YouTube HD HLS streams
    if (
      contentType.includes('mpegurl') ||
      fetchUrl.pathname.toLowerCase().endsWith('.m3u8')
    ) {
      const text = await response.text();
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
      return new Response(rewriteM3u8(text, fetchUrl.href, proxyBase), {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    // 14. Size-guarded fast CSS rewriting
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

    // 15. Zero-copy streaming for videoplayback, JS, WASM, images, audio, JSON
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
