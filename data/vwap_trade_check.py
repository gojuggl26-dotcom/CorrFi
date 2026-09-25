"""B §2.3 VWAP validity: compare 1-minute VWAPs from trade data with the stored 1-minute klines.

Procedure fixed before looking at results: docs/s02/02-acquisition-and-processing.md §3.
Usage: python data/vwap_trade_check.py [--days 2024-03-15,...] [--venues binance,...]
Trade files are cached under data/raw/trades/ (git-ignored). Report: data/reports/vwap_trades_check.json
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, getcontext
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aquacorr_data import SYMBOLS, VENUES  # noqa: E402
from aquacorr_data.store import month_key, month_path, read_month  # noqa: E402

getcontext().prec = 60
REPO = Path(__file__).resolve().parents[1]
CACHE = REPO / "data" / "raw" / "trades"
UA = {"User-Agent": "CorrFi-data/0.1 (research; public market data)"}
DAYS = ["2024-03-15", "2024-05-15", "2024-08-15", "2024-11-15", "2025-02-15", "2025-05-15", "2025-08-15",
        "2025-11-15", "2026-02-15", "2026-05-15", "2026-08-15"]
BITGET_TRADES_FROM = "2024-04-07"


def http(url: str, data: bytes | None = None, headers: dict | None = None) -> bytes:
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - network retries
            if attempt == 5:
                raise
            print(f"  retry {url[:90]}: {e!r}", flush=True)
            time.sleep(2 ** attempt)
        finally:
            time.sleep(0.3)
    raise AssertionError


def cached(name: str, url: str, data: bytes | None = None, headers: dict | None = None) -> bytes:
    path = CACHE / name
    if path.exists():
        return path.read_bytes()
    body = http(url, data, headers)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return body


def utc_ms(day: str) -> int:
    return int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def next_day(day: str) -> str:
    return (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")


def zip_members(body: bytes):
    with zipfile.ZipFile(io.BytesIO(body)) as z:
        for name in z.namelist():
            yield name, z.read(name)


# ---- per-venue trade loaders: yield (time_ms, price_str, base_qty_str) -----------------------------------------

def trades_binance(sym: str, day: str):
    url = f"https://data.binance.vision/data/spot/daily/aggTrades/{sym}/{sym}-aggTrades-{day}.zip"
    body = cached(f"binance/{sym}-aggTrades-{day}.zip", url)
    want = cached(f"binance/{sym}-aggTrades-{day}.zip.CHECKSUM", url + ".CHECKSUM").decode().split()[0]
    if hashlib.sha256(body).hexdigest() != want:
        raise ValueError(f"binance checksum mismatch {sym} {day}")
    for _, raw in zip_members(body):
        for row in csv.reader(io.StringIO(raw.decode())):
            t = int(row[5])
            yield (t // 1000 if t >= 10**15 else t), row[1], row[2]      # µs from 2025-01-01


def trades_bybit(sym: str, day: str):
    body = cached(f"bybit/{sym}_{day}.csv.gz", f"https://public.bybit.com/spot/{sym}/{sym}_{day}.csv.gz")
    r = csv.DictReader(io.StringIO(gzip.decompress(body).decode()))
    for row in r:
        yield int(Decimal(row["timestamp"])), row["price"], row["volume"]


def trades_kucoin(sym: str, day: str):
    url = f"https://historical-data.kucoin.com/data/spot/daily/trades/{sym}/{sym}-trades-{day}.zip"
    body = cached(f"kucoin/{sym}-trades-{day}.zip", url)
    for _, raw in zip_members(body):
        for row in csv.DictReader(io.StringIO(raw.decode())):
            yield int(row["trade_time"]), row["price"], row["size"]


def trades_okx(sym: str, day: str):
    inst = sym[:-4] + "-USDT"
    q = dict(module="1", instType="SPOT", instIdList=inst, dateAggrType="daily",
             begin=str(utc_ms(day)), end=str(utc_ms(next_day(day))))
    listing = json.loads(cached(f"okx/list-{inst}-{day}.json",
                                "https://www.okx.com/api/v5/public/market-data-history?" + urllib.parse.urlencode(q)))
    urls = sorted({g["url"] for d in listing["data"][0]["details"] if d.get("instId") == inst
                   for g in d["groupDetails"]})
    if len(urls) < 2:
        raise ValueError(f"okx: expected 2 UTC+8 daily files for {inst} {day}, got {urls}")
    for url in urls:
        body = cached(f"okx/{Path(urllib.parse.urlparse(url).path).name}", url)
        for _, raw in zip_members(body):
            for row in csv.DictReader(io.StringIO(raw.decode())):
                yield int(row["created_time"]), row["price"], row["size"]


def trades_bitget(sym: str, day: str):
    display = sym[:-4] + "/USDT"
    body = json.dumps({"displaySymbol": display, "businessLine": 1, "businessType": 2, "dateType": 1,
                       "beginTimeStr": day, "endTimeStr": next_day(day)}).encode()
    listing = json.loads(cached(f"bitget/list-{sym}-{day}.json",
                                "https://www.bitget.com/v1/statistics/public/download/getPublicDataV2",
                                data=body, headers={"Content-Type": "application/json"}))
    urls = [f["fileUrl"] for f in listing.get("data") or []]
    if not urls:
        raise ValueError(f"bitget: no trade files for {sym} {day}")
    for url in urls:
        name = "-".join(Path(urllib.parse.urlparse(url).path).parts[-3:])
        for _, raw in zip_members(cached(f"bitget/{name}", url)):
            for row in csv.DictReader(io.StringIO(raw.decode())):
                yield int(row["timestamp"]), row["price"], row["size(base)"]


LOADERS = {"binance": trades_binance, "bybit": trades_bybit, "kucoin": trades_kucoin, "okx": trades_okx,
           "bitget": trades_bitget}


def minute_vwaps_from_trades(venue: str, sym: str, day: str):
    lo, hi = utc_ms(day), utc_ms(next_day(day))
    quote, base = defaultdict(Decimal), defaultdict(Decimal)
    n = 0
    for t, price, qty in LOADERS[venue](sym, day):
        if lo <= t < hi:
            m = t // 60_000 * 60
            p, q = Decimal(price), Decimal(qty)
            quote[m] += p * q
            base[m] += q
            n += 1
    return quote, base, n


def kline_vwaps(venue: str, sym: str, day: str):
    lo, hi = utc_ms(day) // 1000, utc_ms(next_day(day)) // 1000
    path = month_path(REPO / "data" / "store" / "1m", venue, sym, month_key(lo))
    out = {}
    for b in read_month(path):
        if lo <= b.open_time < hi and Decimal(b.base_volume) > 0:
            out[b.open_time] = (Decimal(b.quote_volume), Decimal(b.base_volume))
    return out


def compare(venue: str, sym: str, day: str) -> dict:
    tq, tb, n_trades = minute_vwaps_from_trades(venue, sym, day)
    kl = kline_vwaps(venue, sym, day)
    diffs = []
    for m, (kq, kb) in kl.items():
        if tb.get(m, 0) > 0:
            diffs.append(abs((tq[m] / tb[m]) / (kq / kb) - 1) * 10_000)
    diffs.sort()
    return {
        "trades": n_trades, "minutes_compared": len(diffs),
        "only_in_klines": sum(1 for m in kl if tb.get(m, 0) <= 0),
        "only_in_trades": sum(1 for m, v in tb.items() if v > 0 and m not in kl),
        "max_bp": float(diffs[-1]) if diffs else None,
        "p99_bp": float(diffs[int(0.99 * (len(diffs) - 1))]) if diffs else None,
        "over_1bp": sum(1 for d in diffs if d >= 1),
        "base_volume_ratio": float(sum(tb.values()) / sum(kb for _, kb in kl.values())) if kl else None,
        "pass": bool(diffs) and diffs[-1] < 1,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", default=",".join(DAYS))
    ap.add_argument("--venues", default=",".join(VENUES))
    args = ap.parse_args()
    report = {"procedure": "docs/s02/02-acquisition-and-processing.md §3", "results": {}}
    for day in args.days.split(","):
        for venue in args.venues.split(","):
            if venue == "bitget" and day < BITGET_TRADES_FROM:
                report["results"][f"{venue}/{day}"] = {"skipped": "no Bitget trade files before 2024-04-07"}
                continue
            for sym in SYMBOLS:
                key = f"{venue}/{sym}/{day}"
                try:
                    res = compare(venue, sym, day)
                except Exception as e:  # noqa: BLE001 - record and continue
                    res = {"error": repr(e)[:300], "pass": False}
                report["results"][key] = res
                print(f"{key:<32} " + (f"max {res['max_bp']:.4f} bp, p99 {res['p99_bp']:.4f}, "
                                       f"n {res['minutes_compared']}, over1bp {res['over_1bp']}, "
                                       f"vol ratio {res['base_volume_ratio']:.6f} -> "
                                       f"{'PASS' if res['pass'] else 'FAIL'}" if 'max_bp' in res and res['max_bp'] is not None
                                       else str(res)), flush=True)
    out = REPO / "data" / "reports" / "vwap_trades_check.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1), encoding="utf-8", newline="\n")
    graded = [r for r in report["results"].values() if "skipped" not in r]
    print(f"passed {sum(r['pass'] for r in graded)}/{len(graded)}; report {out.relative_to(REPO).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
