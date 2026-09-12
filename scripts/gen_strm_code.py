#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_strm_code.py — 按番号生成 Emby 可直接在线播放的 .strm（memojavstrm 短链接版）

.strm 文件 = 一行播放 URL 的文本文件。Emby 扫描到后直接拉流转播，无需下载视频。
短链接模式下内容为固定 URL（永不过期），真实播放地址由 CF Worker 每次访问时解析：

    https://memojavstrm.emby-59f.workers.dev/<番号>

用法：
    python3 gen_strm_code.py ROE-552 SDNM-561          # 逐个处理
    python3 gen_strm_code.py -f codes.txt              # 从文件读取番号
    python3 gen_strm_code.py -f codes.txt -o /media/jav
    python3 gen_strm_code.py -f codes.txt --no-verify  # 不验证，全部生成
    python3 gen_strm_code.py -f codes.txt --refresh    # 验证时绕过 Worker 缓存
"""
import argparse
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

DEFAULT_PREFIX = "https://memojavstrm.emby-59f.workers.dev"
UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def parse_code(raw):
    code = (raw or "").strip().upper()
    for ext in (".STRM", ".MP4", ".MKV", ".M3U8"):
        if code.endswith(ext):
            code = code[: -len(ext)]
    return code


def verify(prefix, code, refresh=False, timeout=25):
    """HEAD 短链接（不跟随重定向）：302 → 可解析"""
    url = f"{prefix.rstrip('/')}/{code}" + ("?refresh=1" if refresh else "")
    opener = urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, headers=UA, method="HEAD")
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status in (200, 206, 302)
    except urllib.error.HTTPError as e:
        return e.code == 302
    except Exception:  # noqa: BLE001
        return False


def write_strm(path, prefix, code):
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"{prefix.rstrip('/')}/{code}\n")


def main():
    ap = argparse.ArgumentParser(description="MemoJav 生成 Emby 在线播放 .strm 文件")
    ap.add_argument("codes", nargs="*", help="番号列表")
    ap.add_argument("-f", "--file", help="番号列表文件（每行一个，支持 source<TAB>番号）")
    ap.add_argument("-o", "--outdir", default=".", help="strm 输出目录")
    ap.add_argument(
        "-u",
        "--url-prefix",
        default=DEFAULT_PREFIX,
        help="短链接前缀（默认 memojavstrm Worker）",
    )
    ap.add_argument("--no-verify", action="store_true", help="跳过验证，全部生成")
    ap.add_argument("--refresh", action="store_true", help="验证时带 ?refresh=1 绕过缓存")
    ap.add_argument("--skip-existing", action="store_true", help="已存在的 strm 跳过")
    ap.add_argument("--workers", type=int, default=16, help="并发验证数")
    args = ap.parse_args()

    codes = [parse_code(c) for c in args.codes]
    if args.file:
        with open(args.file, encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                codes.append(parse_code(ln.split("\t")[-1]))

    codes = [c for c in dict.fromkeys(codes) if c]
    if not codes:
        print(__doc__)
        sys.exit(1)

    os.makedirs(args.outdir, exist_ok=True)
    prefix = args.url_prefix.rstrip("/")

    if args.skip_existing:
        codes = [c for c in codes if not os.path.exists(os.path.join(args.outdir, f"{c}.strm"))]
        if not codes:
            print("全部已存在，无需处理")
            return

    ok, bad, skipped = 0, [], 0
    if args.no_verify:
        for code in codes:
            write_strm(os.path.join(args.outdir, f"{code}.strm"), prefix, code)
            ok += 1
            print(f"  ✔ {code}.strm -> {prefix}/{code}")
    else:
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            results = list(ex.map(lambda c: (c, verify(prefix, c, args.refresh)), codes))
        for code, good in results:
            if good:
                write_strm(os.path.join(args.outdir, f"{code}.strm"), prefix, code)
                ok += 1
                print(f"  ✔ {code}.strm -> {prefix}/{code}")
            else:
                bad.append(code)
                print(f"  ✘ {code} 解析不出（404），未生成")

    print(f"\n完成: 生成 {ok} 个，失败 {len(bad)} 个 → {os.path.abspath(args.outdir)}")
    if bad:
        failed_path = os.path.join(args.outdir, "failed_codes.txt")
        with open(failed_path, "w", encoding="utf-8") as f:
            for code in bad:
                f.write(f"{code}\n")
        print(f"失败清单 → {failed_path}")


if __name__ == "__main__":
    main()
