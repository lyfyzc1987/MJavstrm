import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  memoVideoSignature,
  parseMemoVideoInfo,
} from "./worker.js";

const ORIGIN = "https://memojavstrm.example";
const INFO_ORIGIN = "https://memojav.org/hls/get_video_info.php";
const HLS_URL = "https://video10.memojav.net/stream/ROE-552/master.m3u8";
const MP4_URL = "https://video10.memojav.net/download/ROE-552.mp4";

function infoResponse(type, url) {
  return new Response(
    `for (;;);${JSON.stringify({
      type,
      url: encodeURIComponent(url),
      success: true,
    })}`,
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

function playlistResponse(body) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/vnd.apple.mpegurl" },
  });
}

async function request(path, options = {}) {
  const {
    env = {},
    init = {},
    fetchImpl,
  } = options;
  const calls = [];
  const mockFetch = async (url, requestInit = {}) => {
    calls.push({ url: String(url), init: requestInit });
    if (!fetchImpl) throw new Error(`unexpected fetch: ${url}`);
    return fetchImpl(String(url), requestInit);
  };
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, init),
    env,
    {},
    mockFetch,
  );
  return { response, calls };
}

test("reproduces the upstream timestamp signature", () => {
  assert.deepEqual(memoVideoSignature(1750000000000), {
    sig: "MDAwMDAwMA",
    sts: 6321862,
  });
});

test("parses the anti-hijack info API response", () => {
  const info = parseMemoVideoInfo(
    `for (;;);${JSON.stringify({
      type: "hls",
      url: encodeURIComponent(HLS_URL),
      success: true,
    })}`,
    "2026-10-12T00:00:00.000Z",
  );

  assert.equal(info.ok, true);
  assert.equal(info.host, "video10.memojav.net");
  assert.deepEqual(
    info.sources.map((source) => source.id),
    ["hls"],
  );
});

test("default short link returns a zero-traffic 302 to the real HLS source", async () => {
  const { response, calls } = await request("/roe-552.strm", {
    fetchImpl: async () => infoResponse("hls", HLS_URL),
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), HLS_URL);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/memojav\.org\/hls\/get_video_info\.php\?/);
  assert.equal(calls[0].init.headers.referer, "https://memojav.org/embed/ROE-552");
});

test("sources endpoint exposes the real HLS line and an optional proxy fallback", async () => {
  const { response } = await request("/ROE-552?sources=1", {
    fetchImpl: async () => infoResponse("hls", HLS_URL),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(
    payload.sources.map((source) => [source.id, source.height, source.proxy]),
    [
      ["hls", 0, false],
      ["hls-proxy", 0, true],
    ],
  );
});

test("sources endpoint can omit the optional proxy fallback", async () => {
  const { response } = await request("/ROE-552?sources=1", {
    env: { INCLUDE_PROXY_SOURCE: "false" },
    fetchImpl: async () => infoResponse("hls", HLS_URL),
  });

  const payload = await response.json();
  assert.deepEqual(
    payload.sources.map((source) => source.id),
    ["hls"],
  );
});

test("MP4 info exposes three real qualities and selects the requested one", async () => {
  const { response: listResponse, calls } = await request("/ROE-552?sources=1", {
    fetchImpl: async () => infoResponse("mp4", MP4_URL),
  });
  const list = await listResponse.json();

  assert.deepEqual(
    list.sources.map((source) => [source.id, source.height, source.url]),
    [
      ["mp4-1080", 1080, `${MP4_URL}=m37`],
      ["mp4-720", 720, `${MP4_URL}=m22`],
      ["mp4-360", 360, `${MP4_URL}=m18`],
    ],
  );
  assert.equal(calls.length, 1);

  const { response: selectedResponse } = await request(
    "/ROE-552?source=mp4-720",
    {
      fetchImpl: async () => infoResponse("mp4", MP4_URL),
    },
  );
  assert.equal(selectedResponse.status, 302);
  assert.equal(selectedResponse.headers.get("location"), `${MP4_URL}=m22`);
});

test("falls back to the legacy master playlist when the info API fails", async () => {
  const calls = [];
  const { response } = await request("/ROE-552", {
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.startsWith(INFO_ORIGIN)) {
        return new Response("unavailable", { status: 503 });
      }
      return playlistResponse("#EXTM3U\n#EXT-X-VERSION:7\n");
    },
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), HLS_URL);
  assert.deepEqual(calls, [calls[0], HLS_URL]);
  assert.match(calls[0], /^https:\/\/memojav\.org\/hls\/get_video_info\.php\?/);
});

test("proxy playlist rewriting keeps the selected source id", async () => {
  const { response } = await request("/ROE-552?proxy=1&source=hls-proxy", {
    fetchImpl: async (url) => {
      if (url.startsWith(INFO_ORIGIN)) return infoResponse("hls", HLS_URL);
      return playlistResponse(
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:8.3,\nmaster0.m4s\n',
      );
    },
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(
    body,
    /URI="https:\/\/memojavstrm\.example\/ROE-552\/init\.mp4\?proxy=1&p=1&source=hls-proxy"/,
  );
  assert.match(
    body,
    /https:\/\/memojavstrm\.example\/ROE-552\/master0\.m4s\?proxy=1&p=1&source=hls-proxy/,
  );
});

test("MP4 proxy forwards Range requests to the selected quality", async () => {
  const { response, calls } = await request(
    "/ROE-552?proxy=1&source=mp4-720",
    {
      init: { headers: { range: "bytes=0-99" } },
      fetchImpl: async (url) => {
        if (url.startsWith(INFO_ORIGIN)) return infoResponse("mp4", MP4_URL);
        return new Response(new Uint8Array(100), {
          status: 206,
          headers: {
            "content-range": "bytes 0-99/1000",
            "content-type": "video/mp4",
          },
        });
      },
    },
  );

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-99/1000");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `${MP4_URL}=m22`);
  assert.equal(calls[1].init.headers.range, "bytes=0-99");
});

test("invalid codes are rejected without contacting upstream", async () => {
  const { response, calls } = await request("/%E0%A4%A");

  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("reports 404 when both the info API and legacy hosts miss", async () => {
  const { response } = await request("/ZZZZ-999", {
    fetchImpl: async (url) => {
      if (url.startsWith(INFO_ORIGIN)) return new Response("no", { status: 404 });
      return new Response("not found", { status: 404 });
    },
  });

  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.code, "ZZZZ-999");
});
