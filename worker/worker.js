/**
 * memojavstrm-worker —— MemoJav 番号 → 固定短链接 → 动态解析播放源
 *
 * 架构与 javstrm 完全一致：给每个番号一个永不过期的短链接，.strm 里只写它：
 *
 *     https://memojavstrm.<子域>.workers.dev/<番号>
 *
 * 播放时 Worker 实时解析出真实播放地址：
 *
 *     GET /<番号>              → 302 重定向到第一条真实播放源（默认，零流量）
 *     GET /<番号>?sources=1    → 返回上游真实播放源列表（HLS / MP4 清晰度）
 *     GET /<番号>?source=<id>  → 302 重定向到指定播放源
 *     GET /<番号>?proxy=1      → 反向代理 HLS / MP4（清单 + 分片走 Worker，兜底）
 *     GET /<番号>?refresh=1    → 绕过缓存强制重新解析（验证脚本专用，避免旧 404 缓存误判）
 *     GET /<番号>?json=1       → 返回解析结果 JSON（调试）
 *     GET /<番号>/<分片>?proxy=1&p=1 → 代理模式下的分片/map 转发（透传 Range）
 *
 * 上游（2026-10-12 实测）：
 *     https://memojav.org/hls/get_video_info.php?id=<番号>&sig=...&sts=...
 *   - 这是详情页播放器实际使用的接口，返回 hls 或 mp4；
 *   - mp4 会原生提供 1080p / 720p / 360p 三条清晰度；
 *   - hls 上游当前只有一条 master.m3u8，不能伪造出并不存在的清晰度。
 *
 * 兼容旧直链探测：
 *     https://video10.memojav.net/stream/<大写番号>/master.m3u8
 *   - 免签直链，**无需 Referer / UA**（比 javstrm 简单，302 模式即可直接播）
 *   - 番号大小写敏感，必须大写；不存在返回 404
 *   - 清单内为相对路径（init.mp4 / masterN.m4s），播放器按清单 URL 解析
 *   - 站点 memojav.com 301 → memojav.org（媒体域名独立，不受影响）
 *
 * 部署：
 *     npm i -g wrangler
 *     export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
 *     cd worker && wrangler deploy
 */

// 上游媒体域名（可用环境变量 MEDIA_HOSTS 覆盖，逗号分隔，按顺序探测）
const DEFAULT_HOSTS = ["video10.memojav.net"];

// 解析结果缓存时长（秒）。命中缓存时 302/代理都不打上游。
const DEFAULT_CACHE_TTL = 600;
// 未命中的负缓存时长（秒），短一点，保证新上架番号能较快出现
const NEGATIVE_CACHE_TTL = 60;
const SOURCE_CACHE_VERSION = 2;

const INFO_ORIGIN = "https://memojav.org";
const INFO_PATH = "/hls/get_video_info.php";
const INFO_REFERER_PREFIX = "https://memojav.org/embed/";

const MP4_QUALITIES = [
  { id: "mp4-1080", suffix: "m37", height: 1080, name: "MemoJav 1080P" },
  { id: "mp4-720", suffix: "m22", height: 720, name: "MemoJav 720P" },
  { id: "mp4-360", suffix: "m18", height: 360, name: "MemoJav 360P" },
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function mediaHosts(env) {
  const raw = (env && env.MEDIA_HOSTS) || "";
  const list = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_HOSTS;
}

function cacheTtl(env) {
  const n = parseInt((env && env.CACHE_TTL) || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_TTL;
}

function includeProxySource(env) {
  const raw = String((env && env.INCLUDE_PROXY_SOURCE) || "true")
    .trim()
    .toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off" && raw !== "no";
}

/** 规范化番号：去扩展名、去空白、统一大写 */
function normalizeCode(raw) {
  let code = String(raw || "").trim();
  if (!code) return "";
  try {
    code = decodeURIComponent(code);
  } catch {
    return "";
  }
  code = code.toUpperCase();
  code = code.replace(/\.(STRM|MP4|MKV|M3U8|TS)$/, "");
  if (!/^[A-Z0-9][A-Z0-9_.-]{0,63}$/.test(code)) return "";
  if (!/[A-Z0-9]/.test(code)) return "";
  return code;
}

function base64Encode(value) {
  if (typeof btoa === "function") return btoa(value);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "binary").toString("base64");
  }
  throw new Error("base64 encoder unavailable");
}

/**
 * 复刻上游 /static/main.js 的 video_sig()：
 *   sig = btoa(timestamp) 的第 8~17 位（共 10 位）
 *   sts = 1 + Σ(charCode(sig[i]) * i * 1743)
 */
export function memoVideoSignature(nowMs = Date.now()) {
  const encoded = base64Encode(String(nowMs));
  const sig = encoded.slice(-12, -2);
  let sts = 1;
  for (let index = 0; index < sig.length; index += 1) {
    sts += sig.charCodeAt(index) * index * 1743;
  }
  return { sig, sts };
}

function decodeComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function hostFromUrl(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hlsSource(url, checkedAt) {
  return {
    id: "hls",
    name: "MemoJav 302",
    kind: "hls",
    container: "m3u8",
    height: 0,
    url,
    checkedAt,
  };
}

function mp4Sources(baseUrl, checkedAt) {
  return MP4_QUALITIES.map((quality) => ({
    id: quality.id,
    name: quality.name,
    kind: "mp4",
    container: "mp4",
    height: quality.height,
    url: `${baseUrl}=${quality.suffix}`,
    checkedAt,
  }));
}

export function parseMemoVideoInfo(text, checkedAt = new Date().toISOString()) {
  const raw = String(text || "").replace(/^\s*for\s*\(;;\);\s*/i, "");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || payload.success !== true) return null;
  const type = String(payload.type || "").toLowerCase();
  const url = decodeComponent(payload.url);
  if (!url) return null;
  if (type === "hls") {
    const source = hlsSource(url, checkedAt);
    return {
      ok: true,
      type: "hls",
      provider: "memojav-api",
      host: hostFromUrl(url),
      url,
      sources: [source],
      checkedAt,
    };
  }
  if (type === "mp4") {
    const sources = mp4Sources(url, checkedAt);
    return {
      ok: true,
      type: "mp4",
      provider: "memojav-api",
      host: hostFromUrl(sources[0].url),
      url: sources[0].url,
      sources,
      checkedAt,
    };
  }
  return null;
}

function addProxyFallback(info, env) {
  if (!includeProxySource(env) || !info || !info.ok) return info;
  if (info.type !== "hls" || !Array.isArray(info.sources) || !info.sources.length) {
    return info;
  }
  const primary = info.sources.find((source) => source.id === "hls") || info.sources[0];
  if (info.sources.some((source) => source.id === "hls-proxy")) return info;
  info.sources.push({
    id: "hls-proxy",
    name: "MemoJav 代理",
    kind: "hls",
    container: "m3u8",
    height: primary.height || 0,
    url: primary.url,
    proxy: true,
    fallback: true,
    checkedAt: info.checkedAt,
  });
  return info;
}

async function resolveMemoInfo(code, env, fetchImpl = fetch) {
  const checkedAt = new Date().toISOString();
  const signature = memoVideoSignature();
  const infoUrl =
    `${INFO_ORIGIN}${INFO_PATH}?id=${encodeURIComponent(code)}` +
    `&sig=${encodeURIComponent(signature.sig)}&sts=${encodeURIComponent(String(signature.sts))}`;
  try {
    const response = await fetchImpl(infoUrl, {
      method: "GET",
      headers: {
        "user-agent": UA,
        accept: "*/*",
        referer: `${INFO_REFERER_PREFIX}${encodeURIComponent(code)}`,
      },
    });
    if (response.ok) {
      const info = parseMemoVideoInfo(await response.text(), checkedAt);
      if (info) return addProxyFallback(info, env);
    }
  } catch {
    // 接口失败时继续走旧版媒体域名探测，保证已上架 HLS 仍可播放。
  }
  return null;
}

/**
 * 探测番号是否存在：逐个候选域名请求 master.m3u8 的前 2KB。
 * 命中返回 { ok:true, host, url }，全部失败返回 { ok:false, status }。
 */
async function resolveLegacySource(code, env, fetchImpl = fetch) {
  const list = mediaHosts(env);
  let lastStatus = 404;
  for (const host of list) {
    const url = `https://${host}/stream/${code}/master.m3u8`;
    try {
      const resp = await fetchImpl(url, {
        method: "GET",
        headers: { "user-agent": UA, accept: "*/*", range: "bytes=0-4095" },
      });
      if (resp.status === 200 || resp.status === 206) {
        let head = "";
        try {
          head = await resp.text();
        } catch {
          head = "";
        }
        // 必须真的是 HLS 清单，避免把 CDN 的错误页当成命中
        if (/#EXTM3U/i.test(head)) {
          const checkedAt = new Date().toISOString();
          return addProxyFallback(
            {
              ok: true,
              type: "hls",
              provider: "legacy-host",
              host,
              url,
              sources: [hlsSource(url, checkedAt)],
              checkedAt,
            },
            env,
          );
        }
        lastStatus = 502;
      } else {
        lastStatus = resp.status;
      }
    } catch {
      lastStatus = 0;
    }
  }
  return { ok: false, status: lastStatus };
}

export async function resolveSource(code, env, fetchImpl = fetch) {
  const info = await resolveMemoInfo(code, env, fetchImpl);
  if (info && info.ok) return info;
  return resolveLegacySource(code, env, fetchImpl);
}

/** 读/写解析缓存（caches.default），refresh=1 时跳过读 */
async function resolveCached(code, env, refresh, fetchImpl = fetch) {
  const ttl = cacheTtl(env);
  let cache = null;
  try {
    cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    cache = null;
  }
  const key = new Request(
    `https://memojavstrm.internal/__resolve/v${SOURCE_CACHE_VERSION}/${code}` +
      `?proxy=${includeProxySource(env) ? "1" : "0"}`,
    { method: "GET" },
  );

  if (!refresh && cache) {
    const hit = await cache.match(key);
    if (hit) {
      try {
        return await hit.json();
      } catch {
        /* 缓存损坏，走实时解析 */
      }
    }
  }

  const info = await resolveSource(code, env, fetchImpl);
  const body = JSON.stringify(info);
  const maxAge = info.ok ? ttl : NEGATIVE_CACHE_TTL;
  // 注意：caches.default.put 必须在响应结束后仍可执行，用 ctx 交给运行时
  if (cache) {
    const put = cache.put(
      key,
      new Response(body, {
        headers: { "content-type": "application/json", "cache-control": `s-maxage=${maxAge}` },
      })
    );
    if (typeof ctxGlobal !== "undefined" && ctxGlobal && ctxGlobal.waitUntil) {
      ctxGlobal.waitUntil(put);
    } else {
      await put;
    }
  }
  return info;
}

let ctxGlobal = null;

/** 把清单里的相对 URI 改写成走本 Worker 代理的绝对 URL */
function rewritePlaylist(text, code, origin, sourceId = "") {
  const base = `${origin}/${code}`;
  const fix = (raw) => {
    if (!raw) return raw;
    const u = String(raw).trim();
    if (/^(https?:)?\/\//i.test(u) || u.startsWith("data:") || u.startsWith("blob:")) return raw;
    const clean = u.split("#")[0].split("?")[0];
    const name = clean.replace(/^\.\//, "").replace(/^\//, "");
    if (!name) return raw;
    const proxied = name
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    const sourceQuery = sourceId ? `&source=${encodeURIComponent(sourceId)}` : "";
    return `${base}/${proxied}?proxy=1&p=1${sourceQuery}`;
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        // #EXT-X-MAP / #EXT-X-KEY / #EXT-X-MEDIA / #EXT-X-I-FRAME-STREAM-INF 等带 URI 属性
        return line.replace(/URI="([^"]*)"/gi, (m, u) => `URI="${fix(u)}"`);
      }
      return fix(t);
    })
    .join("\n");
}

/** 代理转发（透传 Range，保留 200/206），用于分片与兜底清单 */
async function proxyFetch(target, request, fetchImpl = fetch) {
  const headers = {
    "user-agent": request.headers.get("user-agent") || UA,
    accept: request.headers.get("accept") || "*/*",
  };
  const range = request.headers.get("range");
  if (range) headers.range = range;
  const up = await fetchImpl(target, { method: "GET", headers });
  const out = new Headers(up.headers);
  out.set("cache-control", "no-store");
  out.set("access-control-allow-origin", "*");
  // HLS 清单必须用正确的 mime，否则部分播放器不认
  if (/\.m3u8($|\?)/i.test(target)) {
    out.set("content-type", "application/vnd.apple.mpegurl");
  }
  return new Response(up.body, { status: up.status, headers: out });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

const PAGE_HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0e0f13;color:#e8eaf0;
       font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:960px;margin:0 auto;padding:18px}
  h1{font-size:16px;margin:0 0 12px;font-weight:600;letter-spacing:.3px}
  h1 b{color:#7cc4ff}
  .box{position:relative;background:#000;border-radius:10px;overflow:hidden;aspect-ratio:16/9}
  video{width:100%;height:100%;display:block;background:#000}
  .status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
          text-align:center;padding:24px;color:#9aa3b2;font-size:13px;line-height:1.8}
  .status.err{color:#ff9a9a}
  .status.hide{display:none}
  .bar{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  a.btn,button.btn{appearance:none;border:1px solid #2a2f3a;background:#171a21;color:#cfd6e4;
                   padding:7px 12px;border-radius:8px;font-size:12.5px;cursor:pointer;text-decoration:none}
  a.btn:hover,button.btn:hover{border-color:#3d4759;background:#1d212a}
  .note{margin-top:16px;color:#7b8494;font-size:12px;line-height:1.9}
  code{background:#171a21;border:1px solid #232833;padding:2px 6px;border-radius:5px;
       font-size:12px;word-break:break-all}
</style>`;

/**
 * 网页播放页。
 * 关键点：上游 video10.memojav.net 不返回任何 CORS 头（OPTIONS 直接 403），
 * 浏览器无法跨域抓清单，所以播放源必须用同源的 `?proxy=1`（清单+分片都走本 Worker）。
 * 桌面 Chromium 无原生 HLS，靠 hls.js；Safari/iOS 走原生 HLS。
 */
function playerHtml(code, origin, upstream) {
  const sourceId = upstream && upstream.id ? upstream.id : "";
  const sourceQuery = sourceId ? `&source=${encodeURIComponent(sourceId)}` : "";
  const src = `${origin}/${code}?proxy=1${sourceQuery}`;
  const short = `${origin}/${code}`;
  const isMp4 = upstream && upstream.kind === "mp4";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<title>${code} · MemoJavstrm</title>
${PAGE_HEAD}
</head>
<body>
<div class="wrap">
  <h1>MemoJavstrm · <b>${code}</b></h1>
  <div class="box">
    <video id="v" controls autoplay playsinline></video>
    <div id="st" class="status">正在加载播放清单…</div>
  </div>
  <div class="bar">
    <button class="btn" id="cp">复制 302 短链</button>
    <a class="btn" href="${short}" target="_blank" rel="noreferrer">302 短链（给外部播放器）</a>
    <a class="btn" href="${src}" target="_blank" rel="noreferrer">代理播放源</a>
    <a class="btn" href="/">接口说明</a>
  </div>
  <div class="note">
    <div>· 本页播放走同源代理 <code>?proxy=1</code>，清单与分片经 Cloudflare Worker 中转（网页预览专用）。</div>
    <div>· Emby / VLC / PotPlayer 请用 302 短链 <code>${short}</code>，一跳直达上游、零 Worker 流量。</div>
    <div>· 上游地址 <code>${upstream && upstream.url ? upstream.url : "unknown"}</code> 不带 CORS 头，浏览器无法直连，故本页必须走同源代理。</div>
    <div>· 桌面端 HLS 依赖 hls.js（多 CDN 自动回退）；Safari / iOS 走原生 HLS 可直开。</div>
  </div>
</div>
<script>
var CODE=${JSON.stringify(code)}, SRC=${JSON.stringify(src)}, SHORT=${JSON.stringify(short)};
var v=document.getElementById('v'), st=document.getElementById('st');
function say(m){ st.innerHTML=m; st.className='status err'; }
function hide(){ st.className='status hide'; }
function start(Hls){
  if (${isMp4 ? "true" : "v.canPlayType('application/vnd.apple.mpegurl')"}) {
    v.src=SRC;
    v.addEventListener('loadedmetadata', hide);
    v.addEventListener('error', function(){ say('原生 HLS 播放失败，请改用 302 短链在 VLC / PotPlayer 里打开。'); });
    return;
  }
  if (Hls && Hls.isSupported()) {
    var hls=new Hls({enableWorker:true, maxBufferLength:30});
    var retried=false;
    hls.on(Hls.Events.MANIFEST_PARSED, function(){
      hide();
      var p=v.play(); if(p && p.catch) p.catch(function(){});
    });
    hls.on(Hls.Events.ERROR, function(ev, data){
      if(!data || !data.fatal) return;
      if(data.type===Hls.ErrorTypes.NETWORK_ERROR && !retried){
        retried=true; say('网络错误，正在重试…'); hls.startLoad(); return;
      }
      say('播放失败：'+data.type+' / '+data.details+
          '<br>请改用 302 短链在 VLC / PotPlayer / IINA 里打开。');
    });
    hls.loadSource(SRC);
    hls.attachMedia(v);
    return;
  }
  say('当前浏览器不支持 HLS，且 hls.js 未能从任何 CDN 加载成功（可能被网络拦截）。'+
      '<br>请用 Safari 打开本页，或用 VLC / PotPlayer / IINA 打开 302 短链。');
}
var CDNS=[
  'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
  'https://unpkg.com/hls.js@1/dist/hls.min.js',
  'https://cdn.bootcdn.net/ajax/libs/hls.js/1.5.20/hls.min.js',
  'https://cdn.staticfile.org/hls.js/1.5.20/hls.min.js'
];
(function load(i){
  if(i>=CDNS.length){ start(null); return; }
  var s=document.createElement('script');
  s.src=CDNS[i];
  s.onload=function(){ start(window.Hls); };
  s.onerror=function(){ load(i+1); };
  document.head.appendChild(s);
})(0);
document.getElementById('cp').addEventListener('click', function(){
  var btn=this;
  function done(ok){
    btn.textContent = ok ? '已复制 ✓' : '复制失败，请手动复制';
    setTimeout(function(){ btn.textContent='复制 302 短链'; }, 1800);
  }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(SHORT).then(function(){ done(true); }, function(){ done(false); });
  } else { done(false); }
});
</script>
</body>
</html>`;
}

function errorHtml(code, status) {
  const msg =
    status === 404
      ? "番号不存在或已下架"
      : "上游暂时不可用，稍后重试";
  return `<!doctype html>
<html lang="zh-CN">
<head><title>${code} · 无法播放</title>${PAGE_HEAD}</head>
<body>
<div class="wrap">
  <h1>MemoJavstrm · <b>${code}</b></h1>
  <div class="box" style="aspect-ratio:auto;padding:40px 24px">
    <div class="status err" style="position:static">${status} — ${msg}</div>
  </div>
  <div class="bar">
    <a class="btn" href="/">接口说明</a>
    <a class="btn" href="/${code}?json=1">查看解析 JSON</a>
  </div>
</div>
</body>
</html>`;
}

function sourceListPayload(info, code) {
  return {
    ok: true,
    code,
    type: info.type,
    provider: info.provider,
    checkedAt: info.checkedAt,
    sources: (info.sources || []).map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      container: source.container,
      height: source.height || 0,
      url: source.url,
      proxy: Boolean(source.proxy),
      fallback: Boolean(source.fallback),
    })),
  };
}

function selectSource(info, requested) {
  const sources = Array.isArray(info && info.sources) ? info.sources : [];
  if (!sources.length) return null;
  const raw = String(requested || "").trim().toLowerCase();
  if (!raw) return sources[0];
  return (
    sources.find((source) => String(source.id || "").toLowerCase() === raw) ||
    sources.find((source) => String(source.height || "") === raw) ||
    sources.find((source) => String(source.name || "").toLowerCase() === raw) ||
    sources[0]
  );
}

export default {
  async fetch(request, env, ctx, fetchImpl = globalThis.fetch) {
    ctxGlobal = ctx;
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "仅支持 GET/HEAD" }, 405);
    }

    const parts = url.pathname.split("/").filter(Boolean);

    // 根路径 → 用法说明
    if (parts.length === 0) {
      const hosts = mediaHosts(env);
      return json({
        ok: true,
        service: "memojavstrm",
        usage: {
          "GET /<番号>": "302 重定向到第一条真实播放源（默认，零流量）",
          "GET /<番号>?sources=1": "返回上游真实播放源列表（HLS / MP4 清晰度）",
          "GET /<番号>?source=<id>": "302 重定向到指定播放源",
          "GET /<番号>?web=1": "网页播放页（hls.js 同源代理播放，浏览器直接看）",
          "GET /<番号>?proxy=1": "反向代理播放源（HLS 清单+分片或 MP4）",
          "GET /<番号>?refresh=1": "绕过缓存强制重新解析",
          "GET /<番号>?json=1": "返回解析结果 JSON",
        },
        example: `${url.origin}/ROE-552`,
        upstream: {
          info: `${INFO_ORIGIN}${INFO_PATH}`,
          legacy: hosts.map((h) => `https://${h}/stream/<番号>/master.m3u8`),
        },
        include_proxy_source: includeProxySource(env),
        cache_ttl_seconds: cacheTtl(env),
      });
    }

    const code = normalizeCode(parts[0]);
    if (!code) {
      return json({ error: "无效番号", hint: "格式示例: /ROE-552" }, 400);
    }
    const segment = parts.slice(1).join("/");
    const proxy = url.searchParams.get("proxy") === "1";
    const refresh = url.searchParams.get("refresh") === "1";
    const asJson = url.searchParams.get("json") === "1";
    const web = url.searchParams.get("web") === "1";
    const asSources = url.searchParams.get("sources") === "1";
    const requestedSource =
      url.searchParams.get("source") || url.searchParams.get("quality") || "";

    // ---- 1. 解析（带缓存） ----
    const info = await resolveCached(code, env, refresh, fetchImpl);

    if (!info || !info.ok) {
      const status = info && info.status === 502 ? 502 : 404;
      if (web) return html(errorHtml(code, status), status);
      return json(
        {
          error: status === 404 ? "番号不存在或已下架" : "上游暂时不可用",
          code,
          hint: status === 404 ? "检查番号拼写（番号大小写不敏感，内部统一大写）" : "稍后重试",
        },
        status
      );
    }
    const selected = selectSource(info, requestedSource);
    if (!selected) {
      return json({ error: "没有可用播放源", code }, 502);
    }

    // ---- 2. 返回结构化源列表（供 Emby / 客户端生成多个 MediaSource） ----
    if (asSources) {
      return json(sourceListPayload(info, code));
    }

    // ---- 3. 代理模式下的分片/map 转发 ----
    if (proxy && segment) {
      const target = `https://${info.host}/stream/${code}/${segment}`;
      return proxyFetch(target, request, fetchImpl);
    }

    // ---- 4. 调试 JSON ----
    if (asJson) {
      return json({
        ...sourceListPayload(info, code),
        host: info.host,
        url: selected.url,
        selectedSourceId: selected.id,
        proxy,
      });
    }

    // ---- 5. 网页播放页（浏览器直接看；走同源 ?proxy=1，规避上游无 CORS 头的问题） ----
    if (web) {
      return html(playerHtml(code, url.origin, selected));
    }

    // ---- 6. 代理模式：HLS 拉清单并改写；MP4 直接透传 ----
    if (proxy) {
      if (selected.kind === "mp4" || selected.container === "mp4") {
        return proxyFetch(selected.url, request, fetchImpl);
      }
      const up = await fetchImpl(selected.url, {
        headers: { "user-agent": request.headers.get("user-agent") || UA },
      });
      if (!up.ok) {
        return json({ error: "上游清单拉取失败", code, status: up.status }, 502);
      }
      const text = await up.text();
      const rewritten = rewritePlaylist(text, code, url.origin, selected.id);
      return new Response(rewritten, {
        status: 200,
        headers: {
          "content-type": "application/vnd.apple.mpegurl",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }

    // ---- 7. 默认模式：302 零流量重定向 ----
    if (selected.proxy) {
      const proxyUrl = new URL(`${url.origin}/${encodeURIComponent(code)}`);
      proxyUrl.searchParams.set("proxy", "1");
      proxyUrl.searchParams.set("source", selected.id);
      return new Response(null, {
        status: 302,
        headers: {
          location: proxyUrl.toString(),
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }
    return new Response(null, {
      status: 302,
      headers: {
        location: selected.url,
        "cache-control": `s-maxage=${cacheTtl(env)}`,
        "access-control-allow-origin": "*",
      },
    });
  },

  /**
   * 定时健康检查：确认上游仍然可用、域名没变。
   * 在 wrangler.toml 的 [triggers] crons 中配置。
   */
  async scheduled(event, env, ctx) {
    const codes = String((env && env.HEALTH_CHECK_CODES) || "")
      .split(",")
      .map((s) => normalizeCode(s))
      .filter(Boolean);
    for (const code of codes) {
      const info = await resolveSource(code, env);
      console.log(
        `[health] ${code} -> ${info.ok ? `OK ${info.host}` : `FAIL status=${info.status}`}`
      );
    }
  },
};
