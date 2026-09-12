/**
 * memojavstrm-worker —— MemoJav 番号 → 固定短链接 → 动态解析播放源
 *
 * 架构与 javstrm 完全一致：给每个番号一个永不过期的短链接，.strm 里只写它：
 *
 *     https://memojavstrm.<子域>.workers.dev/<番号>
 *
 * 播放时 Worker 实时解析出真实播放地址：
 *
 *     GET /<番号>              → 302 重定向到 master.m3u8（默认，零流量）
 *     GET /<番号>?proxy=1      → 反向代理 HLS（清单 + 分片全部走 Worker，兜底）
 *     GET /<番号>?refresh=1    → 绕过缓存强制重新解析（验证脚本专用，避免旧 404 缓存误判）
 *     GET /<番号>?json=1       → 返回解析结果 JSON（调试）
 *     GET /<番号>/<分片>?proxy=1&p=1 → 代理模式下的分片/map 转发（透传 Range）
 *
 * 上游（2026-09-12 实测）：
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

/** 规范化番号：去扩展名、去空白、统一大写 */
function normalizeCode(raw) {
  let code = String(raw || "").trim();
  if (!code) return "";
  code = decodeURIComponent(code).toUpperCase();
  code = code.replace(/\.(STRM|MP4|MKV|M3U8|TS)$/, "");
  if (!/^[A-Z0-9][A-Z0-9_.-]{0,63}$/.test(code)) return "";
  if (!/[A-Z0-9]/.test(code)) return "";
  return code;
}

/**
 * 探测番号是否存在：逐个候选域名请求 master.m3u8 的前 2KB。
 * 命中返回 { ok:true, host, url }，全部失败返回 { ok:false, status }。
 */
async function resolveSource(code, env) {
  const list = mediaHosts(env);
  let lastStatus = 404;
  for (const host of list) {
    const url = `https://${host}/stream/${code}/master.m3u8`;
    try {
      const resp = await fetch(url, {
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
          return { ok: true, host, url, checkedAt: new Date().toISOString() };
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

/** 读/写解析缓存（caches.default），refresh=1 时跳过读 */
async function resolveCached(code, env, refresh) {
  const ttl = cacheTtl(env);
  const cache = caches.default;
  const key = new Request(`https://memojavstrm.internal/__resolve/${code}`, { method: "GET" });

  if (!refresh) {
    const hit = await cache.match(key);
    if (hit) {
      try {
        return await hit.json();
      } catch {
        /* 缓存损坏，走实时解析 */
      }
    }
  }

  const info = await resolveSource(code, env);
  const body = JSON.stringify(info);
  const maxAge = info.ok ? ttl : NEGATIVE_CACHE_TTL;
  // 注意：caches.default.put 必须在响应结束后仍可执行，用 ctx 交给运行时
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
  return info;
}

let ctxGlobal = null;

/** 把清单里的相对 URI 改写成走本 Worker 代理的绝对 URL */
function rewritePlaylist(text, code, origin) {
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
    return `${base}/${proxied}?proxy=1&p=1`;
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
async function proxyFetch(target, request) {
  const headers = {
    "user-agent": request.headers.get("user-agent") || UA,
    accept: request.headers.get("accept") || "*/*",
  };
  const range = request.headers.get("range");
  if (range) headers.range = range;
  const up = await fetch(target, { method: "GET", headers });
  const out = new Headers(up.headers);
  out.set("cache-control", "no-store");
  out.set("access-control-allow-origin", "*");
  // HLS 清单必须用正确的 mime，否则部分播放器不认
  if (/\.m3u8($|\?)/i.test(target)) {
    out.set("content-type", "application/vnd.apple.mpegurl");
  }
  return new Response(up.body, { status: up.status, headers: out });
}

export default {
  async fetch(request, env, ctx) {
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
          "GET /<番号>": "302 重定向到最新 m3u8 直链（默认）",
          "GET /<番号>?proxy=1": "HLS 反向代理（清单+分片走 Worker）",
          "GET /<番号>?refresh=1": "绕过缓存强制重新解析",
          "GET /<番号>?json=1": "返回解析结果 JSON",
        },
        example: `${url.origin}/ROE-552`,
        upstream: hosts.map((h) => `https://${h}/stream/<番号>/master.m3u8`),
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

    // ---- 1. 解析（带缓存） ----
    const info = await resolveCached(code, env, refresh);

    if (!info || !info.ok) {
      const status = info && info.status === 502 ? 502 : 404;
      return json(
        {
          error: status === 404 ? "番号不存在或已下架" : "上游暂时不可用",
          code,
          hint: status === 404 ? "检查番号拼写（番号大小写不敏感，内部统一大写）" : "稍后重试",
        },
        status
      );
    }

    // ---- 2. 代理模式下的分片/map 转发 ----
    if (proxy && segment) {
      const target = `https://${info.host}/stream/${code}/${segment}`;
      return proxyFetch(target, request);
    }

    // ---- 3. 调试 JSON ----
    if (asJson) {
      return json({ ok: true, code, host: info.host, url: info.url, proxy });
    }

    // ---- 4. 代理模式：拉清单并改写为走本 Worker ----
    if (proxy) {
      const up = await fetch(info.url, {
        headers: { "user-agent": request.headers.get("user-agent") || UA },
      });
      if (!up.ok) {
        return json({ error: "上游清单拉取失败", code, status: up.status }, 502);
      }
      const text = await up.text();
      const rewritten = rewritePlaylist(text, code, url.origin);
      return new Response(rewritten, {
        status: 200,
        headers: {
          "content-type": "application/vnd.apple.mpegurl",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }

    // ---- 5. 默认模式：302 零流量重定向 ----
    return new Response(null, {
      status: 302,
      headers: {
        location: info.url,
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
