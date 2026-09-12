#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
crawl_memojav.py — 枚举 MemoJav 全站番号，作为 memojavstrm 的 .strm 数据源

与 javstrm 的 fetch_by_year.py 对应：javstrm 从 javdb 按年份取番号，
本脚本从 memojav.org 按「区块」取番号（无年份维度，改用 best / categories）。

数据源（2026-09-12 实测）：
  /best/            精选，page-1..page-25 每页 10 个（page-26 只有 1 个残留）
  /categories       255 个分类入口，每个分类形如 /categories/<slug>/page-N

输出：
  <out>.txt    清单，每行 "source<TAB>番号"   —— 直接喂给 gen_strm_manifest.py
  <out>.jsonl  每条含 番号/标题/封面/厂商/女优/详情页 —— 供 gen_strm_code.py --meta 用

用法：
  python3 crawl_memojav.py --source best                      # 只爬 /best/
  python3 crawl_memojav.py --source categories --max-pages 3  # 分类各取前 3 页
  python3 crawl_memojav.py --source all --categories milf,anal-sex
  python3 crawl_memojav.py --source categories --list-categories
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HOST = "https://memojav.org"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
)

# 番号：字母数字 + 连字符，尾部可选字母（如 ROE-552 / SDNM-561 / ABF-383）
CODE_RE = re.compile(r"/video/([A-Za-z0-9]+-[0-9]+[A-Za-z]?)")
CARD_RE = re.compile(
    r'<a href="/video/(?P<code>[A-Za-z0-9]+-[0-9]+[A-Za-z]?)"[^>]*class="video-item"(?P<body>.*?)</a>',
    re.S,
)
CAT_RE = re.compile(r'href="/categories/([a-z0-9-]+)/?"')
POSTER_RE = re.compile(r'class="video-poster"[^>]*src="([^"]+)"')
META_RE = re.compile(r'<div class="video-metadata">(.*?)</div>', re.S)
TITLE_RE = re.compile(r'<div class="video-title[^"]*">(.*?)</div>', re.S)
PAGE_RE = re.compile(r"page-(\d+)")


def get(path, retries=3, timeout=20):
    url = path if path.startswith("http") else HOST + path
    last = None
    for _ in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": HOST + "/"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.0)
    print(f"  [x] 抓取失败 {url}: {last}", file=sys.stderr)
    return ""


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


def parse_cards(html):
    """解析列表页卡片 → [{code,title,poster,studio,actress,detail_url}]"""
    items = []
    for m in CARD_RE.finditer(html):
        code = m.group("code").upper()
        body = m.group("body")
        poster = POSTER_RE.search(body)
        meta = META_RE.search(body)
        title = TITLE_RE.search(body)
        meta_txt = strip_tags(meta.group(1)) if meta else ""
        # 卡片元信息形如 "JUR-511 • MADONNA • Huziura Megu"
        parts = [p.strip() for p in meta_txt.split("•")] if meta_txt else []
        studio = parts[1] if len(parts) >= 3 else ""
        actress = parts[-1] if len(parts) >= 3 else ""
        items.append(
            {
                "code": code,
                "title": strip_tags(title.group(1)) if title else code,
                "poster": poster.group(1) if poster else "",
                "studio": studio,
                "actress": actress,
                "detail_url": f"{HOST}/video/{code}",
            }
        )
    return items


def max_page(html, current):
    pages = [int(n) for n in PAGE_RE.findall(html)]
    return max([current] + pages)


def crawl_listing(path_fn, label, max_pages=0, delay=0.3, stop_on_empty=True):
    """通用分页抓取；path_fn(page) -> 路径。返回 (items, pages_fetched)"""
    collected, seen_codes, seen_pages = [], set(), set()
    page = 1
    while True:
        path = path_fn(page)
        html = get(path)
        if not html:
            break
        items = parse_cards(html)
        # 结束条件：空页 / 重复页 / 达到上限
        sig = tuple(sorted(i["code"] for i in items))
        if not items or (sig and sig in seen_pages and stop_on_empty):
            break
        seen_pages.add(sig)
        fresh = 0
        for it in items:
            if it["code"] not in seen_codes:
                seen_codes.add(it["code"])
                collected.append(it)
                fresh += 1
        print(f"    {label} page-{page}: {len(items)} 条（新增 {fresh}，累计 {len(collected)}）", flush=True)
        total_pages = max_page(html, page)
        if max_pages and page >= max_pages:
            break
        if page >= total_pages and total_pages > 1:
            # 页脚给出了总页数，抓到最后一页即停
            if page >= total_pages:
                break
        if fresh == 0 and page > 1:
            break
        page += 1
        time.sleep(delay)
    return collected, page


def list_categories():
    html = get("/categories")
    return sorted(set(CAT_RE.findall(html)))


def main():
    ap = argparse.ArgumentParser(description="枚举 MemoJav 番号")
    ap.add_argument("--source", choices=["best", "categories", "all"], default="best")
    ap.add_argument("--categories", default="", help="逗号分隔的分类 slug，留空=全部")
    ap.add_argument("--max-pages", type=int, default=0, help="每个区块最多抓几页，0=全部")
    ap.add_argument("--delay", type=float, default=0.3, help="请求间隔秒")
    ap.add_argument("--workers", type=int, default=1, help="分类并发数（>1 时忽略 --delay 精度）")
    ap.add_argument("--out", default="memojav_codes", help="输出前缀，生成 <out>.txt / <out>.jsonl")
    ap.add_argument("--list-categories", action="store_true", help="只列出分类 slug 后退出")
    ap.add_argument("--append", action="store_true", help="追加到已存在的输出文件")
    args = ap.parse_args()

    if args.list_categories:
        cats = list_categories()
        print(f"共 {len(cats)} 个分类：")
        for c in cats:
            print(c)
        return

    all_items = {}
    order = []

    def add(items, source):
        for it in items:
            code = it["code"]
            if code not in all_items:
                it["source"] = source
                all_items[code] = it
                order.append(code)

    if args.source in ("best", "all"):
        print("[best] 抓取 /best/ ...")
        items, pages = crawl_listing(
            lambda p: "/best/" if p == 1 else f"/best/page-{p}",
            "best",
            args.max_pages,
            args.delay,
        )
        add(items, "best")
        print(f"  best 完成：{len(items)} 条 / {pages} 页")

    if args.source in ("categories", "all"):
        cats = [c.strip() for c in args.categories.split(",") if c.strip()]
        if not cats:
            cats = list_categories()
            print(f"[categories] 全部 {len(cats)} 个分类")
        else:
            print(f"[categories] 指定 {len(cats)} 个分类")

        def one(slug):
            return crawl_listing(
                lambda p: f"/categories/{slug}/" if p == 1 else f"/categories/{slug}/page-{p}",
                slug,
                args.max_pages,
                args.delay,
            )[0], slug

        if args.workers > 1:
            with ThreadPoolExecutor(max_workers=args.workers) as ex:
                for items, slug in ex.map(one, cats):
                    add(items, slug)
                    print(f"  [{slug}] {len(items)} 条")
        else:
            for slug in cats:
                items, _ = one(slug)
                add(items, slug)
                print(f"  [{slug}] {len(items)} 条")

    if not order:
        print("[x] 没有抓到任何番号", file=sys.stderr)
        sys.exit(1)

    txt_path = args.out + ".txt"
    jsonl_path = args.out + ".jsonl"
    mode = "a" if args.append else "w"
    with open(txt_path, mode, encoding="utf-8") as f:
        for code in order:
            f.write(f"{all_items[code]['source']}\t{code}\n")
    with open(jsonl_path, mode, encoding="utf-8") as f:
        for code in order:
            f.write(json.dumps(all_items[code], ensure_ascii=False) + "\n")

    print(f"\n完成：{len(order)} 个番号")
    print(f"  清单  {os.path.abspath(txt_path)}")
    print(f"  元信息 {os.path.abspath(jsonl_path)}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n中断", file=sys.stderr)
        sys.exit(130)
