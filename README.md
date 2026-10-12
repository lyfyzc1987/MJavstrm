# MemoJavstrm

给 MemoJav 番号一个**永不过期的短链接**，.strm 里只写这个短链接，真实播放地址和
全部播放源由 Cloudflare Worker 在访问时实时解析。

架构与 [javstrm](https://github.com/bbemby/javstrm) 完全一致：

```
Emby 媒体库
  └── ROE-552.strm            ← 内容只有一行：
        https://memojavstrm.emby-59f.workers.dev/ROE-552
                    │
                    ▼  播放时 Worker 调用 info API 实时解析
        https://video10.memojav.net/stream/ROE-552/master.m3u8
```

好处：上游直链/域名变了只改 Worker，几万个 `.strm` 不用重写。

多源规则：

- MP4 资源会返回上游真实的 `1080P / 720P / 360P` 三条清晰度。
- HLS 上游当前只提供一条 `master.m3u8`，因此只返回一条真实线路，不会伪造清晰度；
  默认另加一条明确标注的 `MemoJav 代理` 兜底线路。
- 默认短链仍只返回第一条真实源的 **302**，清单和分片不经过 Worker，保持零流量。

---

## 1. Worker 接口

| 请求 | 行为 |
| --- | --- |
| `GET /<番号>` | **302** 重定向到第一条真实播放源（默认，零流量） |
| `GET /<番号>?sources=1` | 返回全部真实播放源（HLS / MP4 清晰度） |
| `GET /<番号>?source=<id>` | 302 重定向到指定播放源，如 `mp4-720` |
| `GET /<番号>?web=1` | **网页播放页**（hls.js + 同源代理，浏览器里直接看画面） |
| `GET /<番号>?proxy=1` | 反向代理：HLS 清单改写为走 Worker，MP4 与分片透传 Range |
| `GET /<番号>?refresh=1` | 绕过缓存强制重新解析（验证脚本用，避免旧 404 缓存误判） |
| `GET /<番号>?json=1` | 返回解析结果 JSON（调试） |
| `GET /<番号>/<分片>?proxy=1&p=1` | 代理模式下的分片 / `init.mp4` 转发 |
| `GET /` | 用法说明 + 上游域名 + 当前缓存 TTL |

- 番号大小写不敏感（内部统一大写），可带 `.strm` 等扩展名。
- 解析结果缓存 `CACHE_TTL` 秒（默认 600）；未命中的负缓存 60 秒，保证新上架番号能较快出现。
- `INCLUDE_PROXY_SOURCE=false` 可关闭 HLS 的代理兜底线路，只保留上游真实源。
- 每 15 分钟 cron 健康检查一次（`HEALTH_CHECK_CODES`）。

### 上游事实（2026-10-12 实测）

详情页播放器实际调用：

```
https://memojav.org/hls/get_video_info.php?id=<番号>&sig=...&sts=...
```

- 响应可能带 `for (;;);` 前缀，`type` 为 `hls` 或 `mp4`。
- MP4 返回同一地址的三档真实清晰度：`=m37`（1080P）、`=m22`（720P）、`=m18`（360P）。
- HLS 返回一条 `master.m3u8`；Worker 不把它拆成虚假的 1080P / 720P。

兼容旧直链探测：

```
https://video10.memojav.net/stream/<大写番号>/master.m3u8
```

- **免签直链，无需 Referer / UA** —— 所以默认 302 模式 Emby 就能直接播（这点比 javstrm 省事）。
- 番号**大小写敏感**，必须大写；不存在返回 404。
- 清单内是相对路径（`init.mp4` / `master0.m4s`），播放器按清单 URL 解析。
- 站点 `memojav.com` 会 301 到 `memojav.org`；媒体域名独立，不受影响。
- 测过的可用域名只有 `video10.memojav.net`（`video1-9/12/15/20` 不解析，`video11` 返回 404）。
  可用环境变量 `MEDIA_HOSTS` 传多个域名按顺序探测。

## 2. 部署 Worker

```bash
npm i -g wrangler
export CLOUDFLARE_API_TOKEN=xxx
export CLOUDFLARE_ACCOUNT_ID=59ff4cced38107663a9ee2dd8e83e023
cd worker
wrangler deploy
```

部署后得到 `https://memojavstrm.<子域>.workers.dev`。

自测：

```bash
curl -sI "https://memojavstrm.emby-59f.workers.dev/ROE-552" | head -3       # 期望 302 + location
curl -s  "https://memojavstrm.emby-59f.workers.dev/ROE-552?sources=1"       # 期望全部真实播放源
curl -sI "https://memojavstrm.emby-59f.workers.dev/ROE-552?source=mp4-720"  # MP4 资源时 302 到 720P
curl -s  "https://memojavstrm.emby-59f.workers.dev/ROE-552?json=1"           # 期望 {"ok":true,...}
curl -sI "https://memojavstrm.emby-59f.workers.dev/ZZZZ-999" | head -1      # 期望 404
```

### 2.1 浏览器里怎么看

**直接把 m3u8 粘到 Chrome 地址栏是播不了的**，这有两个独立原因：

1. **桌面 Chromium（Chrome/Edge）没有原生 HLS 支持** —— 它只认 `<video>` 里的 MP4/WebM。
   打开 m3u8 只会把清单当纯文本显示，或触发下载。Safari / iOS 原生支持 HLS，能直接播。
2. **上游不带 CORS 头** —— 实测 `video10.memojav.net` 的清单和分片都没有
   `access-control-allow-origin`，`OPTIONS` 预检直接返回 403。所以任何跨域页面
   （包括本项目自己的网页播放页）都**不能**直连上游清单。

因此网页播放页的播放源用的是**同源代理** `?proxy=1`：清单和分片全部经同一个 Worker
中转，绕开 CORS。页面会携带当前选中的 `source=<id>`，MP4 清晰度也能正确透传。
桌面端靠 hls.js（多 CDN 自动回退），Safari 走原生 HLS。

```
浏览器打开  https://memojavstrm.emby-59f.workers.dev/HMN-910?web=1
```

⚠️ **请求量提醒**：一个番号约 880 个分片，整片走代理 = 约 880 次 Worker 请求。
Workers 免费额度 100k 请求/天 ≈ 只能支撑 ~110 次「网页全片播放」。
**网页播放页只用于抽查预览**；Emby / VLC / PotPlayer 请用 302 短链，一跳直达上游、零 Worker 流量。

## 3. 生成 .strm

```bash
# 3.1 枚举番号（可选按分类，255 个分类）
python3 scripts/crawl_memojav.py --source best                     # /best/ 约 250 个
python3 scripts/crawl_memojav.py --source categories --max-pages 3  # 全分类各取 3 页
python3 scripts/crawl_memojav.py --source all --categories milf,anal-sex
python3 scripts/crawl_memojav.py --list-categories                  # 只看分类 slug

# 3.2 批量生成（并发验证短链接，302 才落盘）
python3 scripts/gen_strm_manifest.py memojav_codes.txt --out strm_out

# 3.3 或按番号单独生成
python3 scripts/gen_strm_code.py ROE-552 SDNM-561 -o strm_out
```

产物：`<番号>.strm`（内容=短链接）、解析不出的记入 `strm_out/failed_codes.txt`。

把 `strm_out/` 丢进 Emby 媒体库目录，扫描即可在线播放。

## 4. 目录结构

```
MemoJavstrm/
├── worker/
│   ├── worker.js        # Cloudflare Worker（短链解析 + HLS 代理）
│   └── wrangler.toml    # 部署配置（MEDIA_HOSTS / CACHE_TTL / cron）
└── scripts/
    ├── crawl_memojav.py      # 枚举番号（对标 javstrm 的 fetch_by_year.py）
    ├── gen_strm_code.py      # 按番号生成 strm（带验证）
    └── gen_strm_manifest.py  # 从清单批量生成（并发 + 断点续跑）
```

脚本只用 Python 标准库，无第三方依赖。

## 5. 与 javstrm 的差异

| | javstrm | MemoJavstrm |
| --- | --- | --- |
| 上游 | javdb 聚合（要签名 / UA 拦截） | `video10.memojav.net` 免签直链 |
| 默认模式 | 302 到上游直链 / data-URI HLS 内嵌清单 | 302 到 `master.m3u8` |
| Worker 是否必需 | 必需（直链有时效 + 签名） | 主要为「域名可换 + 避免直链过期」 |
| 番号来源 | 按年份枚举 javdb 可播放 | 按区块枚举 memojav（best / categories） |
| 番号体系 | 标准 jav 番号 | 标准 jav 番号（与 javstrm 可能重叠，注意去重） |

## License

MIT
