import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  PREFIX,
  RUNTIME_PATH,
  SW_PATH,
  extractVideoId,
  parseStartSeconds,
  matchYouTubePageRoute,
  parseSearchVideos,
  extractPlayableStreams,
  rewriteM3u8,
  rewriteCss,
  rewriteSetCookie,
  resolveIncomingTargetUrl,
  isStreamingMediaUrl,
  isStaticAssetUrl,
  isCookieFreeCdn,
} from '../src/index.js';

test('extractVideoId parses watch, youtu.be, shorts, embed, and raw IDs', () => {
  assert.equal(extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('not a video'), null);
});

test('parseStartSeconds and matchYouTubePageRoute seamlessly map all YouTube URLs', async () => {
  assert.equal(parseStartSeconds('90'), 90);
  assert.equal(parseStartSeconds('1m30s'), 90);
  assert.equal(parseStartSeconds('1h2m3s'), 3723);

  assert.deepEqual(
    matchYouTubePageRoute(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s')),
    { type: 'watch', videoId: 'dQw4w9WgXcQ', startSeconds: 90 }
  );
  assert.deepEqual(
    matchYouTubePageRoute(new URL('https://youtu.be/dQw4w9WgXcQ?t=42')),
    { type: 'watch', videoId: 'dQw4w9WgXcQ', startSeconds: 42 }
  );
  assert.deepEqual(
    matchYouTubePageRoute(new URL('https://www.youtube.com/embed/dQw4w9WgXcQ')),
    { type: 'embed', videoId: 'dQw4w9WgXcQ', startSeconds: 0 }
  );
  assert.deepEqual(
    matchYouTubePageRoute(new URL('https://www.youtube.com/results?search_query=chess')),
    { type: 'search', query: 'chess' }
  );
  assert.deepEqual(
    matchYouTubePageRoute(new URL('https://www.youtube.com/')),
    { type: 'home' }
  );
  // API endpoints and ?raw=1 must NOT be intercepted
  assert.equal(matchYouTubePageRoute(new URL('https://www.youtube.com/youtubei/v1/player')), null);
  assert.equal(matchYouTubePageRoute(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ&raw=1')), null);

  // Worker seamlessly serves watch & embed for proxied YouTube URLs
  const wResp = await worker.fetch(
    new Request('https://my.workers.dev/-----https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30'),
    {},
    {}
  );
  assert.equal(wResp.status, 200);
  const wHtml = await wResp.text();
  assert.match(wHtml, /dQw4w9WgXcQ/);
  assert.match(wHtml, /initStart = 30/);

  const embResp = await worker.fetch(
    new Request('https://my.workers.dev/-----https://www.youtube.com/embed/dQw4w9WgXcQ'),
    {},
    {}
  );
  assert.equal(embResp.status, 200);
  assert.match(await embResp.text(), /YouTube Embed/);
});

test('parseSearchVideos extracts videoRenderer items from InnerTube JSON', () => {
  const sample = {
    contents: {
      sectionListRenderer: {
        contents: [
          {
            itemSectionRenderer: {
              contents: [
                {
                  videoRenderer: {
                    videoId: 'dQw4w9WgXcQ',
                    title: { runs: [{ text: 'Rick Astley - Never Gonna Give You Up' }] },
                    ownerText: { runs: [{ text: 'Rick Astley' }] },
                    shortViewCountText: { simpleText: '1.5B views' },
                    lengthText: { simpleText: '3:33' },
                  },
                },
              ],
            },
          },
        ],
      },
    },
  };
  const videos = parseSearchVideos(sample);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].id, 'dQw4w9WgXcQ');
  assert.equal(videos[0].title, 'Rick Astley - Never Gonna Give You Up');
  assert.equal(videos[0].author, 'Rick Astley');
  assert.equal(videos[0].length, '3:33');
});

test('extractPlayableStreams rewrites muxed MP4, audio, and HLS URLs through Worker', () => {
  const playerJson = {
    playabilityStatus: { status: 'OK' },
    videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'Test Video', author: 'Test Channel', viewCount: '100' },
    streamingData: {
      hlsManifestUrl: 'https://manifest.googlevideo.com/api/manifest/hls_variant/abc.m3u8',
      formats: [
        { itag: 18, qualityLabel: '360p', mimeType: 'video/mp4', url: 'https://rr1---sn-a.googlevideo.com/videoplayback?itag=18' },
      ],
      adaptiveFormats: [
        { itag: 251, bitrate: 128000, mimeType: 'audio/webm', url: 'https://rr1---sn-a.googlevideo.com/videoplayback?itag=251' },
      ],
    },
  };
  const out = extractPlayableStreams(playerJson, 'https://my.workers.dev');
  assert.equal(out.status, 'OK');
  assert.equal(out.muxed[0].url, 'https://my.workers.dev/-----https://rr1---sn-a.googlevideo.com/videoplayback?itag=18');
  assert.equal(out.audio[0].url, 'https://my.workers.dev/-----https://rr1---sn-a.googlevideo.com/videoplayback?itag=251');
  assert.equal(out.hlsUrl, 'https://my.workers.dev/-----https://manifest.googlevideo.com/api/manifest/hls_variant/abc.m3u8');
});

test('rewriteM3u8 rewrites segment URLs and URI attributes', () => {
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,URI="https://manifest.googlevideo.com/audio.m3u8"',
    '#EXTINF:5.0,',
    'https://rr1---sn-a.googlevideo.com/videoplayback?seg=1',
  ].join('\n');

  const out = rewriteM3u8(m3u8, 'https://manifest.googlevideo.com/master.m3u8', 'https://my.workers.dev');
  assert.match(out, /URI="https:\/\/my\.workers\.dev\/-----https:\/\/manifest\.googlevideo\.com\/audio\.m3u8"/);
  assert.match(out, /https:\/\/my\.workers\.dev\/-----https:\/\/rr1---sn-a\.googlevideo\.com\/videoplayback\?seg=1/);
});

test('URL, cookie, CSS, and static/media classification helpers work correctly', () => {
  assert.equal(isStreamingMediaUrl(new URL('https://rr1---sn-abc.googlevideo.com/videoplayback?itag=18')), true);
  assert.equal(isStaticAssetUrl(new URL('https://rr1---sn-abc.googlevideo.com/videoplayback?itag=18')), false);
  assert.equal(isStaticAssetUrl(new URL('https://i.ytimg.com/vi/abc/hqdefault.jpg')), true);
  assert.equal(isCookieFreeCdn('i.ytimg.com'), true);

  const res = resolveIncomingTargetUrl(
    new URL('https://my.workers.dev/callback/user'),
    `https://my.workers.dev${PREFIX}https://www.chess.com/play`
  );
  assert.equal(res.targetUrl.href, 'https://www.chess.com/callback/user');

  const cookie = rewriteSetCookie('SID=1; Domain=.youtube.com; Path=/; SameSite=Lax', true);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /\bSecure\b/);

  const css = rewriteCss('.a { background: url("/img/x.png"); }', 'https://www.chess.com/s.css', 'https://my.workers.dev');
  assert.match(css, /https:\/\/my\.workers\.dev\/-----https:\/\/www\.chess\.com\/img\/x\.png/);
});

test('Cloudflare Worker endpoints: /yt, /yt/api/player, /__proxy_sw.js, googlevideo Range/206, and M3U8 proxy', async () => {
  // 1. Health & Service Worker & Runtime
  const health = await worker.fetch(new Request('https://my.workers.dev/__proxy_health'), {}, {});
  assert.equal(health.status, 200);
  const hJson = await health.json();
  assert.equal(hJson.youtube, true);
  assert.equal(hJson.serviceWorker, true);

  const sw = await worker.fetch(new Request(`https://my.workers.dev${SW_PATH}`), {}, {});
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get('service-worker-allowed'), '/');

  const rt = await worker.fetch(new Request(`https://my.workers.dev${RUNTIME_PATH}`), {}, {});
  assert.equal(rt.status, 200);
  assert.match(rt.headers.get('cache-control'), /immutable/);

  // 2. /yt UI and /yt/watch UI
  const ytPage = await worker.fetch(new Request('https://my.workers.dev/yt'), {}, {});
  assert.equal(ytPage.status, 200);
  assert.match(await ytPage.text(), /YouTube — Cloudflare Proxy/);

  // 3. Mock upstream fetch for /yt/api/player, googlevideo 206 Range, and .m3u8 manifest
  const origFetch = globalThis.fetch;
  let lastInit = null;
  globalThis.fetch = async (u, init) => {
    lastInit = init;
    if (String(u).includes('/youtubei/v1/player')) {
      return new Response(
        JSON.stringify({
          playabilityStatus: { status: 'OK' },
          videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'Mock Song', author: 'Mock Artist' },
          streamingData: {
            formats: [
              { itag: 18, qualityLabel: '360p', mimeType: 'video/mp4', url: 'https://rr1---sn-a.googlevideo.com/videoplayback?itag=18' },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (String(u).includes('.m3u8')) {
      return new Response('#EXTM3U\nhttps://rr1---sn-a.googlevideo.com/seg1.ts', {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
      });
    }
    if (String(u).includes('googlevideo.com')) {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 206,
        headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/100', 'Accept-Ranges': 'bytes' },
      });
    }
    return new Response('ok', { status: 200 });
  };

  try {
    const pResp = await worker.fetch(new Request('https://my.workers.dev/yt/api/player?v=dQw4w9WgXcQ'), {}, {});
    assert.equal(pResp.status, 200);
    const pData = await pResp.json();
    assert.equal(pData.status, 'OK');
    assert.equal(pData.muxed.length, 1);
    assert.match(pData.muxed[0].url, /^https:\/\/my\.workers\.dev\/-----https:\/\/rr1---sn-a\.googlevideo\.com/);

    const m3u8Resp = await worker.fetch(
      new Request('https://my.workers.dev/-----https://manifest.googlevideo.com/master.m3u8'),
      {},
      { waitUntil() {} }
    );
    assert.equal(m3u8Resp.status, 200);
    assert.match(await m3u8Resp.text(), /https:\/\/my\.workers\.dev\/-----https:\/\/rr1---sn-a\.googlevideo\.com\/seg1\.ts/);

    const gvResp = await worker.fetch(
      new Request('https://my.workers.dev/-----https://rr1---sn-a.googlevideo.com/videoplayback?itag=18', {
        headers: { Range: 'bytes=0-3' },
      }),
      {},
      { waitUntil() {} }
    );
    assert.equal(gvResp.status, 206);
    assert.equal(lastInit.cf, undefined);
    assert.equal(lastInit.headers.get('origin'), 'https://www.youtube.com');
    assert.equal(lastInit.headers.get('referer'), 'https://www.youtube.com/');
    assert.equal(gvResp.headers.get('access-control-expose-headers'), '*');
  } finally {
    globalThis.fetch = origFetch;
  }
});
