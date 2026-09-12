#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_strm_manifest.py — 从清单批量生成 .strm 短链接文件（memojavstrm 版）

与 javstrm/scripts/gen_strm_manifest.py 完全一致的工作流：
  1. 读清单文件（每行 "source<TAB>番号"）
  2. HEAD 验证短链接服务能解析该番号（302 = 可播放）
  3. 可播放 → 写入 <番号>.strm，内容 = <前缀>/<番号>
  4. 解析不出 → 记入 failed_codes.txt

用法:
  python3 gen_strm_manifest.py memojav_codes.txt --out strm_dir
  python3 gen_strm_manifest.py memojav_codes.txt --out strm_dir --skip-existing
  python3 gen_strm_manifest.py memojav_codes.txt --out strm_dir --no-verify
  STRM_PREFIX=https://memojavstrm.emby-59f.workers.dev python3 gen_strm_manifest.py ...
"""
import argparse
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

STRM_PREFIX = os.environ.get(
    "STRM_PREFIX", "https://memojavstrm.emby-59f.workers.dev"
).rstrip("/")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """禁止自动跟随重定向，直接看到 302/404"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def test(code, timeout=25, refresh=False, retries=2):
    """HEAD 短链接（不跟随重定向）：302=可解析(成功)，404=解析不出(失败)"""
    url = f"{STRM_PREFIX}/{code}" + ("?refresh=1" if refresh else "")
    opener = urllib.request.build_opener(NoRedirect)
    for attempt in range(retries):
        req = urllib.request.Request(url, headers=UA, method="HEAD")
        try:
            with opener.open(req, timeout=timeout) as resp:
                return resp.status in (200, 206, 302)
        except urllib.error.HTTPError as e:
            if e.code == 302:
                return True
            if e.code == 404:
                return False
            # 429/5xx → 退避重试
            if attempt + 1 < retries:
                time.sleep(1.5 * (attempt + 1))
        except Exception:  # noqa: BLE001
            if attempt + 1 < retries:
                time.sleep(1.5 * (attempt + 1))
    return False


def test_parallel(codes, workers=20, refresh=False):
    results = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(test, c, 25, refresh): c for c in codes}
        for fut in futs:
            results[futs[fut]] = fut.result()
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest", help="清单文件 (source<TAB>番号)")
    ap.add_argument("--out", default=".", help="strm 输出目录")
    ap.add_argument("--no-verify", action="store_true", help="跳过短链接验证，全部生成")
    ap.add_argument("--refresh", action="store_true", help="验证时带 ?refresh=1 绕过 Worker 缓存")
    ap.add_argument("--skip-existing", action="store_true", help="已存在的 strm 直接算成功（续跑加速）")
    ap.add_argument("--start", type=int, default=0, help="从第几条开始（断点续跑）")
    ap.add_argument("--end", type=int, default=None, help="处理到第几条为止（分批）")
    ap.add_argument("--workers", type=int, default=20, help="并发数")
    ap.add_argument("--batch", type=int, default=200, help="每批条数")
    args = ap.parse_args()

    with open(args.manifest, encoding="utf-8") as f:
        lines = [ln.strip() for ln in f if ln.strip()]

    # 去重 + 兼容 "source<TAB>番号" 与纯番号两种格式
    seen, codemap = set(), []
    for line in lines:
        zone, code = (line.split("\t", 1) if "\t" in line else ("", line))
        code = code.strip().upper()
        if code and code not in seen:
            seen.add(code)
            codemap.append((zone.strip(), code))

    total = len(codemap)
    os.makedirs(args.out, exist_ok=True)
    written, failed = 0, []
    print(f"清单 {total} 个番号；前缀 {STRM_PREFIX}；输出 {os.path.abspath(args.out)}")

    if args.no_verify:
        for _, code in codemap:
            with open(os.path.join(args.out, f"{code}.strm"), "w", encoding="utf-8") as f:
                f.write(f"{STRM_PREFIX}/{code}\n")
            written += 1
        print(f"\n完成(未验证): 生成 {written} 个 strm → {args.out}")
        return

    end = args.end if args.end is not None else total
    failed_path = os.path.join(args.out, "failed_codes.txt")
    for i in range(args.start, min(end, total), args.batch):
        batch = codemap[i : i + args.batch]
        todo = []
        for zone, code in batch:
            fpath = os.path.join(args.out, f"{code}.strm")
            if args.skip_existing and os.path.exists(fpath):
                written += 1
            else:
                todo.append((zone, code))
        results = test_parallel([c for _, c in todo], args.workers, args.refresh) if todo else {}
        for zone, code in todo:
            if results.get(code):
                with open(os.path.join(args.out, f"{code}.strm"), "w", encoding="utf-8") as f:
                    f.write(f"{STRM_PREFIX}/{code}\n")
                written += 1
            else:
                failed.append((zone, code))
        print(f"  进度 {min(i + args.batch, end)}/{end}, 已生成 {written}, 失败 {len(failed)}", flush=True)

    print(f"\n完成: 生成(含已存在) {written} 个 strm → {args.out}")
    if failed:
        mode = "a" if args.start > 0 else "w"
        with open(failed_path, mode, encoding="utf-8") as f:
            for zone, code in failed:
                f.write(f"{zone}\t{code}\n")
        print(f"失败 {len(failed)} 个 → {failed_path}")


if __name__ == "__main__":
    main()
