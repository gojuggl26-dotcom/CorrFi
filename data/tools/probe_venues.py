#!/usr/bin/env python3
"""S02 venue survey probe: spot 1-minute klines on Binance, OKX, Bybit, Bitget, KuCoin.

Scope (small probes only, no bulk download):
  * public REST endpoints only, no API keys, no orders;
  * a few dozen requests per venue at most, with a pause between requests;
  * bulk/historical download sites: listing queries, HEAD, a Range "peek" of the
    first few KB, and at most a handful of small (< 100 KB) daily files.

Python 3.13 standard library only.

Usage:
  python data/tools/probe_venues.py [binance okx bybit bitget kucoin] [--out DIR] [--no-illiquid]
  python data/tools/probe_venues.py okx bybit bitget kucoin --extras   # REST 1m depth (binary search),
                                                                       # bulk earliest dates, follow-ups
  python data/tools/probe_venues.py binance --illiquid-only            # no-trade-minute check only

Output:
  <out>/evidence.jsonl  one JSON record per HTTP request / analysis note
  <out>/summary.json    per-venue analysis results
  stdout                human-readable log (the same facts)
Default <out> is %TEMP%/corrfi_probe (outside the repository).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import statistics
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
import zlib
from decimal import Decimal, getcontext

getcontext().prec = 50

UTC = dt.timezone.utc
MIN = 60_000
UA = "Mozilla/5.0 (compatible; CorrFi-venue-probe/0.1; python-urllib)"


def ms(y, m, d, hh=0, mm=0):
    return int(dt.datetime(y, m, d, hh, mm, tzinfo=UTC).timestamp() * 1000)


T24 = ms(2024, 3, 1)  # 2024-03-01 00:00 UTC
T25 = ms(2025, 3, 1)  # 2025-03-01 00:00 UTC
NOW = int(time.time() * 1000)
NOW_MIN = NOW - NOW % MIN


def iso(t):
    """ISO-8601 UTC for a timestamp in s, ms or us (unit detected by magnitude)."""
    t = int(t)
    if t > 10**14:
        sec, unit = t / 1e6, "us"
    elif t > 10**11:
        sec, unit = t / 1e3, "ms"
    else:
        sec, unit = t, "s"
    return dt.datetime.fromtimestamp(sec, UTC).strftime("%Y-%m-%dT%H:%M:%SZ") + f"({unit})"


def to_ms(t):
    t = int(t)
    if t > 10**14:
        return t // 1000
    if t > 10**11:
        return t
    return t * 1000


# --------------------------------------------------------------------------- logging

class Evidence:
    def __init__(self, out_dir):
        os.makedirs(out_dir, exist_ok=True)
        self.path = os.path.join(out_dir, "evidence.jsonl")
        self.f = open(self.path, "a", encoding="utf-8")
        self.summary = {}
        self.latency = {}

    def write(self, rec):
        rec = {"at": dt.datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), **rec}
        self.f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
        self.f.flush()

    def note(self, venue, label, data):
        self.write({"venue": venue, "kind": "note", "label": label, "data": data})
        self.summary.setdefault(venue, {})[label] = data
        print(f"  [{venue}] {label}: {json.dumps(data, ensure_ascii=False, default=str)[:1500]}")


KEEP_HDR = ("limit", "weight", "retry", "content-length", "content-type", "last-modified",
            "x-cache", "server", "cf-ray", "content-range", "location", "etag", "accept-ranges",
            "x-amz", "date")


class Resp:
    def __init__(self, status, headers, body, elapsed, error, url):
        self.status, self.headers, self.body, self.elapsed, self.error, self.url = (
            status, headers, body, elapsed, error, url)

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8"))
        except Exception:
            return None

    def text(self, n=None):
        s = self.body.decode("utf-8", "replace")
        return s if n is None else s[:n]


class Http:
    def __init__(self, ev: Evidence, pause=0.25):
        self.ev, self.pause = ev, pause
        self.count = {}

    def req(self, venue, label, url, method="GET", data=None, headers=None, rng=None,
            max_read=None, pause=None, log_body=600):
        h = {"User-Agent": UA, "Accept": "*/*"}
        if headers:
            h.update(headers)
        if rng:
            h["Range"] = f"bytes={rng[0]}-{rng[1]}"
        body = None
        if data is not None:
            body = json.dumps(data).encode()
            h["Content-Type"] = "application/json"
        r = urllib.request.Request(url, data=body, headers=h, method=method)
        t0 = time.perf_counter()
        status, hdrs, raw, err, final = None, {}, b"", None, url
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:
                status = resp.status
                final = resp.geturl()
                hdrs = dict(resp.headers.items())
                raw = resp.read() if max_read is None else resp.read(max_read)
        except urllib.error.HTTPError as e:
            status = e.code
            hdrs = dict(e.headers.items()) if e.headers else {}
            try:
                raw = e.read()
            except Exception:
                raw = b""
        except Exception as e:  # DNS, TLS, timeout ...
            err = f"{type(e).__name__}: {e}"
        el = time.perf_counter() - t0
        self.count[venue] = self.count.get(venue, 0) + 1
        self.ev.latency.setdefault(venue, []).append(el)
        kept = {k: v for k, v in hdrs.items() if any(s in k.lower() for s in KEEP_HDR)}
        is_text = not (raw[:2] in (b"PK", b"\x1f\x8b"))
        self.ev.write({
            "venue": venue, "kind": "http", "label": label, "method": method, "url": url,
            "request_body": data, "range": rng, "status": status, "elapsed_s": round(el, 3),
            "final_url": final if final != url else None, "headers": kept, "body_len": len(raw),
            "body_head": raw[:log_body].decode("utf-8", "replace") if is_text else f"<binary {raw[:4]!r}>",
            "error": err,
        })
        print(f"[{venue}] {label}: {method} {url} -> {status} {len(raw)}B {el:.2f}s"
              + (f" ERR {err}" if err else ""))
        time.sleep(self.pause if pause is None else pause)
        return Resp(status, hdrs, raw, el, err, final)


# --------------------------------------------------------------------------- kline helpers

def D(x):
    return Decimal(str(x))


def norm(venue, row):
    """Normalise one REST kline row -> dict(t=open_ms, o,h,l,c, base, quote, extra)."""
    if venue == "binance":   # [openTime,o,h,l,c,vol,closeTime,quoteVol,n,takerBase,takerQuote,ignore]
        return dict(t=to_ms(row[0]), o=D(row[1]), h=D(row[2]), l=D(row[3]), c=D(row[4]),
                    base=D(row[5]), quote=D(row[7]), extra={"closeTime": row[6], "trades": row[8]})
    if venue == "okx":       # [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]
        return dict(t=to_ms(row[0]), o=D(row[1]), h=D(row[2]), l=D(row[3]), c=D(row[4]),
                    base=D(row[5]), quote=D(row[7]), extra={"volCcy": row[6], "confirm": row[8]})
    if venue == "bybit":     # [start,o,h,l,c,volume,turnover]
        return dict(t=to_ms(row[0]), o=D(row[1]), h=D(row[2]), l=D(row[3]), c=D(row[4]),
                    base=D(row[5]), quote=D(row[6]), extra={})
    if venue == "bitget":    # [ts,o,h,l,c,baseVolume,usdtVolume,quoteVolume]
        return dict(t=to_ms(row[0]), o=D(row[1]), h=D(row[2]), l=D(row[3]), c=D(row[4]),
                    base=D(row[5]), quote=D(row[7] if len(row) > 7 else row[6]),
                    extra={"usdtVolume": row[6] if len(row) > 6 else None})
    if venue == "kucoin":    # [time(s),open,close,high,low,volume,turnover]
        return dict(t=to_ms(row[0]), o=D(row[1]), c=D(row[2]), h=D(row[3]), l=D(row[4]),
                    base=D(row[5]), quote=D(row[6]), extra={})
    raise ValueError(venue)


def analyze(rows):
    """rows: list of normalised dicts in the order returned."""
    if not rows:
        return {"count": 0}
    ts = [r["t"] for r in rows]
    diffs = [b - a for a, b in zip(ts, ts[1:])]
    order = ("asc" if all(d > 0 for d in diffs) else "desc" if all(d < 0 for d in diffs)
             else "unsorted") if diffs else "single"
    st = sorted(ts)
    gaps = [(iso(a), iso(b)) for a, b in zip(st, st[1:]) if b - a != MIN]
    bad, zero, ok = [], 0, 0
    for r in rows:
        if r["base"] == 0:
            zero += 1
            continue
        v = r["quote"] / r["base"]
        if r["l"] <= v <= r["h"]:
            ok += 1
        else:
            bad.append((iso(r["t"]), str(r["l"]), str(v), str(r["h"])))
    ex = rows[0]
    ex_v = (ex["quote"] / ex["base"]) if ex["base"] else None
    return {
        "count": len(rows), "order": order, "first": iso(ts[0]), "last": iso(ts[-1]),
        "min": iso(st[0]), "max": iso(st[-1]), "all_1m_step": not gaps, "gaps": gaps[:5],
        "n_gaps": len(gaps), "vwap_in_[l,h]": ok, "vwap_outside": bad[:5], "zero_base_vol": zero,
        "example": {"t": iso(ex["t"]), "o": str(ex["o"]), "h": str(ex["h"]), "l": str(ex["l"]),
                    "c": str(ex["c"]), "base": str(ex["base"]), "quote": str(ex["quote"]),
                    "quote/base": (f"{ex_v:.10f}" if ex_v is not None else None), **ex["extra"]},
    }


def compare(file_rows, rest_rows):
    """Compare normalised file rows with REST rows for the same open times."""
    fr = {r["t"]: r for r in file_rows}
    res = {"compared": 0, "equal": 0, "diff": []}
    for r in rest_rows:
        f = fr.get(r["t"])
        if not f:
            continue
        res["compared"] += 1
        keys = ("o", "h", "l", "c", "base", "quote")
        if all(f[k] == r[k] for k in keys):
            res["equal"] += 1
        else:
            res["diff"].append({"t": iso(r["t"]),
                                **{k: (str(f[k]), str(r[k])) for k in keys if f[k] != r[k]}})
    res["diff"] = res["diff"][:3]
    return res


# --------------------------------------------------------------------------- file helpers

def zip_csv_rows(raw):
    z = zipfile.ZipFile(io.BytesIO(raw))
    names = z.namelist()
    txt = z.read(names[0]).decode("utf-8-sig")
    return names, list(csv.reader(io.StringIO(txt)))


def xlsx_rows(raw):
    """Minimal .xlsx reader (inline strings / numbers / shared strings) for sheet1."""
    x = zipfile.ZipFile(io.BytesIO(raw))
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    shared = []
    if "xl/sharedStrings.xml" in x.namelist():
        sroot = ET.fromstring(x.read("xl/sharedStrings.xml"))
        shared = ["".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t"))
                  for si in sroot.findall("m:si", ns)]
    root = ET.fromstring(x.read("xl/worksheets/sheet1.xml"))
    out = []
    for row in root.iter(f"{{{ns['m']}}}row"):
        vals = []
        for c in row.findall("m:c", ns):
            t = c.get("t")
            if t == "inlineStr":
                vals.append("".join(e.text or "" for e in c.iter(f"{{{ns['m']}}}t")))
            elif t == "s":
                vals.append(shared[int(c.find("m:v", ns).text)])
            else:
                v = c.find("m:v", ns)
                vals.append(v.text if v is not None else "")
        out.append(vals)
    return out


def peek_zip(raw):
    """Decompress the beginning of the first member of a (possibly truncated) zip."""
    if raw[:4] != b"PK\x03\x04":
        return None
    method = int.from_bytes(raw[8:10], "little")
    n = int.from_bytes(raw[26:28], "little")
    e = int.from_bytes(raw[28:30], "little")
    name = raw[30:30 + n].decode("utf-8", "replace")
    data = raw[30 + n + e:]
    if method == 8:
        data = zlib.decompressobj(-15).decompress(data)
    return name, data.decode("utf-8", "replace").splitlines()[:4]


def peek_gz(raw):
    data = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(raw)
    return data.decode("utf-8", "replace").splitlines()[:4]


def s3_list(H, venue, label, base, prefix, marker=None):
    q = {"delimiter": "/", "prefix": prefix}
    if marker:
        q["marker"] = marker
    r = H.req(venue, label, base + "?" + urllib.parse.urlencode(q), log_body=300)
    if r.status != 200:
        return {"status": r.status}
    root = ET.fromstring(r.body)
    ns = {"s": "http://s3.amazonaws.com/doc/2006-03-01/"}
    keys = [(c.find("s:Key", ns).text, int(c.find("s:Size", ns).text),
             c.find("s:LastModified", ns).text) for c in root.findall("s:Contents", ns)]
    prefixes = [p.find("s:Prefix", ns).text for p in root.findall("s:CommonPrefixes", ns)]
    trunc = (root.find("s:IsTruncated", ns).text == "true")
    return {"status": 200, "n_keys": len(keys), "truncated": trunc,
            "first_keys": keys[:3], "last_keys": keys[-3:], "prefixes": prefixes[:40]}


def file_summary(rows, header):
    return {"header": header, "n_rows": len(rows),
            "first_row": rows[0] if rows else None, "last_row": rows[-1] if rows else None}


# =========================================================================== BINANCE

def probe_binance(H, ev, illiquid=True):
    V = "binance"
    B = "https://api.binance.com/api/v3"
    r = H.req(V, "server time", f"{B}/time")
    server = (r.json() or {}).get("serverTime")
    r = H.req(V, "exchangeInfo rateLimits", f"{B}/exchangeInfo?symbol=ETHUSDT", log_body=300)
    j = r.json() or {}
    ev.note(V, "rateLimits(exchangeInfo)", j.get("rateLimits"))
    ev.note(V, "used-weight header", {k: v for k, v in r.headers.items() if "weight" in k.lower()})
    rest_2024 = {}
    for sym in ("ETHUSDT", "BTCUSDT"):
        for lab, t in (("2024-03-01", T24), ("2025-03-01", T25)):
            r = H.req(V, f"{sym} klines {lab}", f"{B}/klines?symbol={sym}&interval=1m&startTime={t}&limit=5")
            rows = [norm(V, x) for x in (r.json() or [])] if r.status == 200 else []
            ev.note(V, f"{sym} REST {lab} x5", {"status": r.status, **analyze(rows),
                                                  "raw_first": (r.json() or [None])[0] if r.status == 200 else r.text(300)})
        r = H.req(V, f"{sym} klines latest", f"{B}/klines?symbol={sym}&interval=1m&limit=3")
        raw = r.json() or []
        if raw:
            last = raw[-1]
            ev.note(V, f"{sym} latest (in-progress check)", {
                "serverTime": iso(server) if server else None, "last_open": iso(last[0]),
                "last_closeTime": iso(last[6]), "closeTime>server": (last[6] > server) if server else None,
                "order": analyze([norm(V, x) for x in raw])["order"]})
        r = H.req(V, f"{sym} klines earliest", f"{B}/klines?symbol={sym}&interval=1m&startTime=0&limit=1")
        raw = r.json() or []
        ev.note(V, f"{sym} earliest 1m via REST", {"status": r.status, "first_open": iso(raw[0][0]) if raw else None})
        r = H.req(V, f"{sym} klines page 1000", f"{B}/klines?symbol={sym}&interval=1m&startTime={T24}&limit=1000")
        rows = [norm(V, x) for x in (r.json() or [])] if r.status == 200 else []
        rest_2024[sym] = rows
        a = analyze(rows)
        a.pop("example", None)
        ev.note(V, f"{sym} REST page limit=1000 from 2024-03-01", a)
    r = H.req(V, "limit=1001", f"{B}/klines?symbol=ETHUSDT&interval=1m&startTime={T24}&limit=1001")
    ev.note(V, "limit=1001 behaviour", {"status": r.status, "n": len(r.json() or []) if r.status == 200 else None,
                                         "body": r.text(200) if r.status != 200 else None})
    r = H.req(V, "endTime only", f"{B}/klines?symbol=ETHUSDT&interval=1m&endTime={T24 + 5 * MIN - 1}&limit=3")
    ev.note(V, "endTime-only (backward paging)", {"status": r.status, "opens": [iso(x[0]) for x in (r.json() or [])]})

    # ---- bulk: data.binance.vision
    DV = "https://data.binance.vision/data/spot"
    S3 = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision"
    for sym in ("ETHUSDT", "BTCUSDT"):
        u = f"{DV}/monthly/klines/{sym}/1m/{sym}-1m-2024-03.zip"
        r = H.req(V, f"{sym} monthly 2024-03 HEAD", u, method="HEAD")
        ev.note(V, f"{sym} bulk monthly 2024-03", {"url": u, "status": r.status,
                                                   "size": r.headers.get("Content-Length"),
                                                   "last_modified": r.headers.get("Last-Modified")})
        r = H.req(V, f"{sym} monthly CHECKSUM", u + ".CHECKSUM")
        ev.note(V, f"{sym} monthly 2024-03 CHECKSUM", {"status": r.status, "text": r.text(120).strip()})
        u = f"{DV}/daily/klines/{sym}/1m/{sym}-1m-2024-03-01.zip"
        r = H.req(V, f"{sym} daily 2024-03-01 GET", u)
        if r.status == 200:
            names, rows = zip_csv_rows(r.body)
            has_header = not rows[0][0].isdigit()
            data = rows[1:] if has_header else rows
            fr = [norm(V, x) for x in data]
            a = analyze(fr)
            a.pop("example", None)
            ev.note(V, f"{sym} bulk daily 2024-03-01", {"url": u, "member": names, "has_header": has_header,
                                                        **file_summary(data, rows[0] if has_header else None), **a,
                                                        "vs_REST": compare(fr, rest_2024.get(sym, []))})
    for lab, d in (("2025-03-01", "2025-03-01"),):
        u = f"{DV}/daily/klines/ETHUSDT/1m/ETHUSDT-1m-{d}.zip"
        r = H.req(V, f"ETHUSDT daily {lab} GET", u)
        if r.status == 200:
            names, rows = zip_csv_rows(r.body)
            ev.note(V, f"ETHUSDT bulk daily {lab} (timestamp unit check)", {
                "first_row": rows[0], "open_time_digits": len(rows[0][0]), "open_time": iso(rows[0][0]),
                "n_rows": len(rows)})
    # latest monthly / daily availability
    for lab, u in (("monthly 2026-08", f"{DV}/monthly/klines/ETHUSDT/1m/ETHUSDT-1m-2026-08.zip"),
                   ("daily 2026-09-24", f"{DV}/daily/klines/ETHUSDT/1m/ETHUSDT-1m-2026-09-24.zip"),
                   ("daily 2026-09-25", f"{DV}/daily/klines/ETHUSDT/1m/ETHUSDT-1m-2026-09-25.zip")):
        r = H.req(V, f"ETHUSDT {lab} HEAD", u, method="HEAD")
        ev.note(V, f"latest availability {lab}", {"status": r.status, "size": r.headers.get("Content-Length"),
                                                   "last_modified": r.headers.get("Last-Modified")})
    lst = s3_list(H, V, "S3 list monthly 1m ETHUSDT", S3, "data/spot/monthly/klines/ETHUSDT/1m/")
    ev.note(V, "S3 listing monthly/klines/ETHUSDT/1m", lst)
    # trade-level data (aggTrades / trades) for one day
    for kind in ("aggTrades", "trades"):
        u = f"{DV}/daily/{kind}/ETHUSDT/ETHUSDT-{kind}-2024-06-15.zip"
        r = H.req(V, f"{kind} 2024-06-15 HEAD", u, method="HEAD")
        info = {"url": u, "status": r.status, "size": r.headers.get("Content-Length")}
        r2 = H.req(V, f"{kind} 2024-06-15 peek", u, rng=(0, 8191))
        if r2.status in (200, 206):
            info["peek"] = peek_zip(r2.body)
            info["range_status"] = r2.status
        ev.note(V, f"trade-level {kind} ETHUSDT 2024-06-15", info)

    if illiquid:
        illiquid_binance(H, ev)


def illiquid_binance(H, ev):
    """No-trade minutes: are they omitted or returned with zero volume? (least-traded USDT pair)"""
    V = "binance"
    B = "https://api.binance.com/api/v3"
    r = H.req(V, "ticker 24hr all (illiquid pick)", f"{B}/ticker/24hr?type=MINI", log_body=200)
    tick = r.json() or []
    cand = [t for t in tick if t.get("symbol", "").endswith("USDT") and int(t.get("count", 0) or 0) > 0]
    cand.sort(key=lambda t: int(t["count"]))
    ev.note(V, "illiquid candidates", {"n_usdt_pairs_traded_24h": len(cand),
                                        "lowest5": [(t["symbol"], t["count"]) for t in cand[:5]]})
    if cand:
        s = cand[0]["symbol"]
        r = H.req(V, f"illiquid {s} klines", f"{B}/klines?symbol={s}&interval=1m&startTime={NOW_MIN - 180 * MIN}&limit=180")
        rows = [norm(V, x) for x in (r.json() or [])]
        a = analyze(rows)
        ev.note(V, "no-trade minute behaviour (illiquid pair)", {
            "symbol": s, "24h_trades": cand[0]["count"], "requested": 180, "returned": a["count"],
            "n_gaps": a["n_gaps"], "zero_base_vol_rows": a["zero_base_vol"],
            "zero_row_example": next(([iso(x["t"]), str(x["o"]), str(x["c"]), str(x["base"]), str(x["quote"])]
                                      for x in rows if x["base"] == 0), None)})


# =========================================================================== OKX

def probe_okx(H, ev, illiquid=True):
    V = "okx"
    O = "https://www.okx.com/api/v5"
    rest_2024 = {}
    for inst in ("ETH-USDT", "BTC-USDT"):
        for lab, t in (("2024-03-01", T24), ("2025-03-01", T25)):
            r = H.req(V, f"{inst} history-candles {lab}",
                      f"{O}/market/history-candles?instId={inst}&bar=1m&after={t + 5 * MIN}&limit=5")
            j = r.json() or {}
            rows = [norm(V, x) for x in j.get("data", [])]
            ev.note(V, f"{inst} REST {lab} x5", {"status": r.status, "code": j.get("code"), "msg": j.get("msg"),
                                                 **analyze(rows), "raw_first": (j.get("data") or [None])[0]})
        r = H.req(V, f"{inst} candles latest", f"{O}/market/candles?instId={inst}&bar=1m&limit=3")
        j = r.json() or {}
        ev.note(V, f"{inst} latest (in-progress check)", {
            "now": iso(NOW), "rows": [(iso(x[0]), "confirm=" + x[8]) for x in j.get("data", [])]})
        r = H.req(V, f"{inst} history-candles page 300",
                  f"{O}/market/history-candles?instId={inst}&bar=1m&after={T24 + 300 * MIN}&limit=300")
        j = r.json() or {}
        rows = [norm(V, x) for x in j.get("data", [])]
        rest_2024[inst] = rows
        a = analyze(rows)
        a.pop("example", None)
        a["confirm_values"] = sorted({x[8] for x in j.get("data", [])})
        ev.note(V, f"{inst} REST page limit=300 ending 2024-03-01 05:00", a)
    r = H.req(V, "limit=301", f"{O}/market/history-candles?instId=ETH-USDT&bar=1m&after={T24 + 400 * MIN}&limit=301")
    j = r.json() or {}
    ev.note(V, "limit=301 behaviour", {"status": r.status, "code": j.get("code"), "msg": j.get("msg"),
                                        "n": len(j.get("data", []))})
    r = H.req(V, "history-candles 2018", f"{O}/market/history-candles?instId=ETH-USDT&bar=1m&after={ms(2018, 1, 1, 0, 5)}&limit=5")
    j = r.json() or {}
    ev.note(V, "ETH-USDT 1m at 2018-01-01 (depth check)", {"status": r.status, "code": j.get("code"),
                                                          "rows": [iso(x[0]) for x in j.get("data", [])]})
    r = H.req(V, "candles endpoint old", f"{O}/market/candles?instId=ETH-USDT&bar=1m&after={T25 + 5 * MIN}&limit=5")
    j = r.json() or {}
    ev.note(V, "/market/candles (recent-only endpoint) at 2025-03-01", {"status": r.status, "code": j.get("code"),
                                                                       "n": len(j.get("data", []))})

    # ---- bulk: /api/v5/public/market-data-history
    MDH = f"{O}/public/market-data-history"
    q = dict(module="2", instType="SPOT", instIdList="ETH-USDT,BTC-USDT", dateAggrType="daily",
             begin=str(T24), end=str(T24 + 86400_000))
    r = H.req(V, "market-data-history candles daily 2024-03-01", MDH + "?" + urllib.parse.urlencode(q), pause=0.5, log_body=1500)
    j = r.json() or {}
    files = []
    for d in (j.get("data") or [{}])[0].get("details", []):
        for g in d.get("groupDetails", []):
            files.append({"inst": d.get("instId"), "file": g.get("filename"), "dateTs": iso(g.get("dateTs") or g.get("dataTs") or 0),
                          "sizeMB": g.get("sizeMB"), "url": g.get("url")})
    ev.note(V, "bulk module=2 daily listing", {"status": r.status, "code": j.get("code"), "files": files})
    q.update(dateAggrType="monthly", begin=str(T24), end=str(ms(2024, 3, 31)))
    r = H.req(V, "market-data-history candles monthly 2024-03", MDH + "?" + urllib.parse.urlencode(q), pause=0.5, log_body=1500)
    j = r.json() or {}
    mfiles = [{"inst": d.get("instId"), "file": g.get("filename"), "sizeMB": g.get("sizeMB"), "url": g.get("url")}
              for d in (j.get("data") or [{}])[0].get("details", []) for g in d.get("groupDetails", [])]
    ev.note(V, "bulk module=2 monthly listing", {"status": r.status, "code": j.get("code"), "files": mfiles})
    q.update(dateAggrType="daily", begin=str(NOW - 6 * 86400_000), end=str(NOW))
    r = H.req(V, "market-data-history candles daily latest", MDH + "?" + urllib.parse.urlencode(q), pause=0.5, log_body=300)
    j = r.json() or {}
    lf = sorted({g.get("filename") for d in (j.get("data") or [{}])[0].get("details", []) for g in d.get("groupDetails", [])})
    ev.note(V, "bulk module=2 latest daily files (last 6 days query)", {"files": lf})
    q = dict(module="1", instType="SPOT", instIdList="ETH-USDT", dateAggrType="daily",
             begin=str(ms(2024, 6, 15)), end=str(ms(2024, 6, 15)))
    r = H.req(V, "market-data-history trades daily 2024-06-15", MDH + "?" + urllib.parse.urlencode(q), pause=0.5, log_body=800)
    j = r.json() or {}
    tfiles = [{"file": g.get("filename"), "sizeMB": g.get("sizeMB"), "url": g.get("url")}
              for d in (j.get("data") or [{}])[0].get("details", []) for g in d.get("groupDetails", [])]
    ev.note(V, "bulk module=1 (trades) listing ETH-USDT 2024-06-15", {"status": r.status, "files": tfiles})
    # download one small daily candle file and compare with REST
    for f in files:
        if f["inst"] == "ETH-USDT" and f["file"].endswith("2024-03-01.zip"):
            r = H.req(V, "daily candle file GET", f["url"])
            if r.status == 200:
                names, rows = zip_csv_rows(r.body)
                hdr, data = rows[0], rows[1:]
                ix = {k: i for i, k in enumerate(hdr)}
                fr = [dict(t=int(x[ix["open_time"]]), o=D(x[ix["open"]]), h=D(x[ix["high"]]), l=D(x[ix["low"]]),
                           c=D(x[ix["close"]]), base=D(x[ix["vol"]]), quote=D(x[ix["vol_quote"]]), extra={})
                      for x in data]
                a = analyze(fr)
                a.pop("example", None)
                ev.note(V, "bulk daily candle file ETH-USDT 2024-03-01", {
                    "member": names, **file_summary(data, hdr), **a,
                    "confirm_values": sorted({x[ix["confirm"]] for x in data}),
                    "vol_ccy==vol_quote": all(x[ix["vol_ccy"]] == x[ix["vol_quote"]] for x in data),
                    "vs_REST": compare(fr, rest_2024.get("ETH-USDT", []))})
    for m in mfiles[:1]:
        r = H.req(V, "monthly candle file HEAD", m["url"], method="HEAD")
        ev.note(V, "bulk monthly candle file HEAD", {"url": m["url"], "status": r.status,
                                                     "size": r.headers.get("Content-Length")})
    for t in tfiles[:1]:
        r = H.req(V, "trades file HEAD", t["url"], method="HEAD")
        info = {"url": t["url"], "status": r.status, "size": r.headers.get("Content-Length")}
        r2 = H.req(V, "trades file peek", t["url"], rng=(0, 8191))
        if r2.status in (200, 206):
            info["range_status"] = r2.status
            info["peek"] = peek_zip(r2.body)
        ev.note(V, "trade-level file ETH-USDT 2024-06-15", info)

    if illiquid:
        illiquid_okx(H, ev)


def zero_example(rows):
    return next(([iso(x["t"]), str(x["o"]), str(x["c"]), str(x["base"]), str(x["quote"])]
                 for x in rows if x["base"] == 0), None)


def illiquid_okx(H, ev):
    V = "okx"
    O = "https://www.okx.com/api/v5"
    r = H.req(V, "tickers SPOT (illiquid pick)", f"{O}/market/tickers?instType=SPOT", log_body=200)
    tick = (r.json() or {}).get("data", [])
    cand = [t for t in tick if t["instId"].endswith("-USDT") and D(t.get("volCcy24h") or 0) > 0]
    cand.sort(key=lambda t: D(t["volCcy24h"]))
    if cand:
        s = cand[0]["instId"]
        r = H.req(V, f"illiquid {s} candles", f"{O}/market/candles?instId={s}&bar=1m&limit=180")
        rows = [norm(V, x) for x in (r.json() or {}).get("data", [])]
        a = analyze(rows)
        ev.note(V, "no-trade minute behaviour (illiquid pair)", {
            "instId": s, "24h_quote_vol": cand[0]["volCcy24h"], "requested": 180, "returned": a["count"],
            "n_gaps": a["n_gaps"], "zero_base_vol_rows": a["zero_base_vol"], "zero_row_example": zero_example(rows)})


# =========================================================================== BYBIT

def probe_bybit(H, ev, illiquid=True):
    V = "bybit"
    Y = "https://api.bybit.com/v5/market"
    for sym in ("ETHUSDT", "BTCUSDT"):
        for lab, t in (("2024-03-01", T24), ("2025-03-01", T25)):
            r = H.req(V, f"{sym} kline {lab}",
                      f"{Y}/kline?category=spot&symbol={sym}&interval=1&start={t}&end={t + 4 * MIN}&limit=5")
            j = r.json() or {}
            lst = (j.get("result") or {}).get("list", [])
            ev.note(V, f"{sym} REST {lab} x5", {"status": r.status, "retCode": j.get("retCode"),
                                                **analyze([norm(V, x) for x in lst]),
                                                "raw_first": lst[0] if lst else None})
        r = H.req(V, f"{sym} kline latest", f"{Y}/kline?category=spot&symbol={sym}&interval=1&limit=2")
        j = r.json() or {}
        lst = (j.get("result") or {}).get("list", [])
        ev.note(V, f"{sym} latest (in-progress check)", {"now": iso(NOW), "server_time": iso(j.get("time", 0)),
                                                          "rows": [iso(x[0]) for x in lst]})
        r = H.req(V, f"{sym} kline page 1000",
                  f"{Y}/kline?category=spot&symbol={sym}&interval=1&start={T24}&end={T24 + 999 * MIN}&limit=1000")
        lst = ((r.json() or {}).get("result") or {}).get("list", [])
        a = analyze([norm(V, x) for x in lst])
        a.pop("example", None)
        ev.note(V, f"{sym} REST page limit=1000 from 2024-03-01", {"headers": {k: v for k, v in r.headers.items()
                                                                               if "limit" in k.lower()}, **a})
        r = H.req(V, f"{sym} monthly earliest", f"{Y}/kline?category=spot&symbol={sym}&interval=M&start=0&limit=1000")
        lst = ((r.json() or {}).get("result") or {}).get("list", [])
        ev.note(V, f"{sym} earliest monthly bar", {"oldest": iso(lst[-1][0]) if lst else None, "n": len(lst)})
        if lst:
            t0 = to_ms(lst[-1][0])
            r = H.req(V, f"{sym} 1m at listing month",
                      f"{Y}/kline?category=spot&symbol={sym}&interval=1&start={t0}&end={t0 + 86400_000}&limit=1000")
            l2 = ((r.json() or {}).get("result") or {}).get("list", [])
            ev.note(V, f"{sym} 1m in first listed month (depth check)", {"n": len(l2),
                                                                         "oldest": iso(l2[-1][0]) if l2 else None})
    r = H.req(V, "start only", f"{Y}/kline?category=spot&symbol=ETHUSDT&interval=1&start={T24}&limit=5")
    lst = ((r.json() or {}).get("result") or {}).get("list", [])
    ev.note(V, "start-only semantics (no end)", {"rows": [iso(x[0]) for x in lst]})
    r = H.req(V, "limit=1001", f"{Y}/kline?category=spot&symbol=ETHUSDT&interval=1&start={T24}&end={T24 + 1100 * MIN}&limit=1001")
    j = r.json() or {}
    ev.note(V, "limit=1001 behaviour", {"retCode": j.get("retCode"), "retMsg": j.get("retMsg"),
                                         "n": len((j.get("result") or {}).get("list", []))})

    # ---- bulk: public.bybit.com (spot trades only)
    for sym in ("ETHUSDT", "BTCUSDT"):
        u = f"https://public.bybit.com/spot/{sym}/{sym}_2024-03-01.csv.gz"
        r = H.req(V, f"{sym} spot trades 2024-03-01 HEAD", u, method="HEAD")
        info = {"url": u, "status": r.status, "size": r.headers.get("Content-Length"),
                "last_modified": r.headers.get("Last-Modified")}
        if sym == "ETHUSDT":
            r2 = H.req(V, "spot trades peek", u, rng=(0, 8191))
            if r2.status in (200, 206):
                info["range_status"] = r2.status
                info["peek"] = peek_gz(r2.body)
        ev.note(V, f"bulk spot trades {sym} 2024-03-01", info)
    r = H.req(V, "history-data page", "https://www.bybit.com/derivatives/en/history-data", log_body=100)
    ev.note(V, "history-data web page", {"status": r.status, "final_url": r.url,
                                         "len": len(r.body), "title": r.text()[r.text().find("<title>"):r.text().find("</title>")][:120]})

    if illiquid:
        illiquid_bybit(H, ev)


def illiquid_bybit(H, ev):
    V = "bybit"
    Y = "https://api.bybit.com/v5/market"
    r = H.req(V, "tickers spot (illiquid pick)", f"{Y}/tickers?category=spot", log_body=200)
    tick = ((r.json() or {}).get("result") or {}).get("list", [])
    cand = [t for t in tick if t["symbol"].endswith("USDT") and D(t.get("turnover24h") or 0) > 0]
    cand.sort(key=lambda t: D(t["turnover24h"]))
    if cand:
        s = cand[0]["symbol"]
        r = H.req(V, f"illiquid {s} kline",
                  f"{Y}/kline?category=spot&symbol={s}&interval=1&start={NOW_MIN - 180 * MIN}&end={NOW_MIN - MIN}&limit=1000")
        rows = [norm(V, x) for x in ((r.json() or {}).get("result") or {}).get("list", [])]
        a = analyze(rows)
        ev.note(V, "no-trade minute behaviour (illiquid pair)", {
            "symbol": s, "24h_turnover": cand[0]["turnover24h"], "requested": 180, "returned": a["count"],
            "n_gaps": a["n_gaps"], "zero_base_vol_rows": a["zero_base_vol"], "zero_row_example": zero_example(rows)})


# =========================================================================== BITGET

def bitget_v2(H, ev, label, path, **params):
    u = f"https://api.bitget.com/api/v2/spot/market/{path}?" + urllib.parse.urlencode(params)
    r = H.req("bitget", label, u, pause=0.12)
    j = r.json() or {}
    data = j.get("data") if isinstance(j.get("data"), list) else []
    return r, j, data


def probe_bitget(H, ev, illiquid=True):
    V = "bitget"
    for sym in ("ETHUSDT", "BTCUSDT"):
        for lab, t in (("2024-03-01", T24), ("2025-03-01", T25)):
            r, j, d = bitget_v2(H, ev, f"{sym} candles {lab}", "candles", symbol=sym, granularity="1min",
                                startTime=t, endTime=t + 5 * MIN, limit=5)
            ev.note(V, f"{sym} REST candles {lab}", {"status": r.status, "code": j.get("code"), "msg": j.get("msg"),
                                                     **analyze([norm(V, x) for x in d])})
            r, j, d = bitget_v2(H, ev, f"{sym} history-candles {lab}", "history-candles", symbol=sym,
                                granularity="1min", endTime=t + 5 * MIN, limit=5)
            ev.note(V, f"{sym} REST history-candles {lab}", {"status": r.status, "code": j.get("code"),
                                                             "msg": j.get("msg"), **analyze([norm(V, x) for x in d]),
                                                             "raw_first": d[0] if d else None})
        r, j, d = bitget_v2(H, ev, f"{sym} candles latest", "candles", symbol=sym, granularity="1min", limit=3)
        ev.note(V, f"{sym} latest (in-progress check)", {"now": iso(NOW), "requestTime": iso(j.get("requestTime", 0)),
                                                          "rows": [iso(x[0]) for x in d], "raw_last": d[-1] if d else None})
    # depth of 1min history: candles vs history-candles, endTime stepping back
    depth = {}
    for days in (20, 29, 31, 35, 45, 60, 90, 180, 365):
        t = NOW_MIN - days * 86400_000
        r, j, d = bitget_v2(H, ev, f"candles endTime=now-{days}d", "candles", symbol="ETHUSDT", granularity="1min",
                            endTime=t, limit=5)
        r2, j2, d2 = bitget_v2(H, ev, f"history-candles endTime=now-{days}d", "history-candles", symbol="ETHUSDT",
                               granularity="1min", endTime=t, limit=5)
        depth[f"now-{days}d ({iso(t)})"] = {
            "candles": {"code": j.get("code"), "msg": j.get("msg"), "n": len(d), "first": iso(d[0][0]) if d else None,
                        "last": iso(d[-1][0]) if d else None},
            "history-candles": {"code": j2.get("code"), "msg": j2.get("msg"), "n": len(d2),
                                "first": iso(d2[0][0]) if d2 else None, "last": iso(d2[-1][0]) if d2 else None}}
    ev.note(V, "1min depth scan ETHUSDT (endTime stepping back)", depth)
    for lim in (200, 201, 1000):
        r, j, d = bitget_v2(H, ev, f"history-candles limit={lim}", "history-candles", symbol="ETHUSDT",
                            granularity="1min", endTime=NOW_MIN - 10 * 86400_000, limit=lim)
        a = analyze([norm(V, x) for x in d])
        ev.note(V, f"history-candles limit={lim}", {"code": j.get("code"), "msg": j.get("msg"), "n": len(d),
                                                    "order": a.get("order"), "first": a.get("first"),
                                                    "last": a.get("last"), "n_gaps": a.get("n_gaps"),
                                                    "vwap_in_[l,h]": a.get("vwap_in_[l,h]"),
                                                    "vwap_outside": a.get("vwap_outside")})
    for lim in (1000, 1001):
        r, j, d = bitget_v2(H, ev, f"candles limit={lim}", "candles", symbol="ETHUSDT", granularity="1min",
                            endTime=NOW_MIN - 2 * 86400_000, limit=lim)
        a = analyze([norm(V, x) for x in d])
        ev.note(V, f"candles limit={lim}", {"code": j.get("code"), "msg": j.get("msg"), "n": len(d),
                                            "order": a.get("order"), "first": a.get("first"), "last": a.get("last"),
                                            "n_gaps": a.get("n_gaps"), "vwap_in_[l,h]": a.get("vwap_in_[l,h]"),
                                            "example": a.get("example")})
    # UTA (v3) market endpoint, for completeness
    for path in ("candles", "history-candles"):
        u = (f"https://api.bitget.com/api/v3/market/{path}?" +
             urllib.parse.urlencode(dict(category="SPOT", symbol="ETHUSDT", interval="1m",
                                         endTime=T24 + 5 * MIN, limit=5)))
        r = H.req(V, f"v3 {path} 2024-03-01", u, pause=0.12)
        ev.note(V, f"v3 /api/v3/market/{path} at 2024-03-01", {"status": r.status, "body": r.text(400)})

    # ---- bulk: www.bitget.com/data-download (API used by the page)
    WEB = "https://www.bitget.com/v1/statistics/public/download"
    files = {}
    for sym in ("ETH/USDT", "BTC/USDT"):
        body = {"displaySymbol": sym, "businessLine": 1, "businessType": 1, "dateType": 1,
                "beginTimeStr": "2024-03-01", "endTimeStr": "2024-03-02"}
        r = H.req(V, f"data-download list {sym} day 2024-03-01", f"{WEB}/getPublicDataV2", method="POST", data=body,
                  log_body=1200, pause=0.5)
        files[sym] = (r.json() or {}).get("data") or []
        ev.note(V, f"bulk kline listing {sym} 2024-03-01..02 (dateType=1 day)",
                {"status": r.status, "request": body, "files": files[sym]})
    body = {"displaySymbol": "ETH/USDT", "businessLine": 1, "businessType": 1, "dateType": 2,
            "beginTimeStr": "2024-03-01", "endTimeStr": "2024-03-31"}
    r = H.req(V, "data-download list month 2024-03", f"{WEB}/getPublicDataV2", method="POST", data=body, log_body=1200, pause=0.5)
    ev.note(V, "bulk kline listing ETH/USDT month 2024-03 (dateType=2)", {"status": r.status, "data": (r.json() or {}).get("data")})
    recent_begin = (dt.datetime.fromtimestamp(NOW / 1000, UTC) - dt.timedelta(days=6)).strftime("%Y-%m-%d")
    recent_end = dt.datetime.fromtimestamp(NOW / 1000, UTC).strftime("%Y-%m-%d")
    body = {"displaySymbol": "ETH/USDT", "businessLine": 1, "businessType": 1, "dateType": 1,
            "beginTimeStr": recent_begin, "endTimeStr": recent_end}
    r = H.req(V, "data-download list recent days", f"{WEB}/getPublicDataV2", method="POST", data=body, log_body=1500, pause=0.5)
    recent = (r.json() or {}).get("data") or []
    ev.note(V, "bulk kline listing ETH/USDT recent (lag check)", {"request": body,
                                                                 "dates": [f.get("dateTimeStr") for f in recent]})
    body = {"displaySymbol": "ETH/USDT", "businessLine": 1, "businessType": 1, "dateType": 1,
            "beginTimeStr": "2018-01-01", "endTimeStr": "2018-01-07"}
    r = H.req(V, "data-download list 2018", f"{WEB}/getPublicDataV2", method="POST", data=body, log_body=600, pause=0.5)
    ev.note(V, "bulk kline listing ETH/USDT 2018-01-01..07", {"dates": [f.get("dateTimeStr") for f in (r.json() or {}).get("data") or []]})
    for bt, lab in ((2, "transactions"), (3, "depth")):
        for b, e in (("2024-03-01", "2024-03-02"), (recent_begin, recent_end)):
            body = {"displaySymbol": "ETH/USDT", "businessLine": 1, "businessType": bt, "dateType": 1,
                    "beginTimeStr": b, "endTimeStr": e}
            if bt == 3:
                body["deptType"] = 1
            r = H.req(V, f"data-download list {lab} {b}", f"{WEB}/getPublicDataV2", method="POST", data=body,
                      log_body=800, pause=0.5)
            d = (r.json() or {}).get("data") or []
            ev.note(V, f"bulk businessType={bt} ({lab}) {b}..{e}", {"n_files": len(d), "first": d[0] if d else None})
    # download one 2024 daily kline file + one recent file (compare recent file with REST)
    def load_xlsx_zip(url, label):
        r = H.req(V, label, url, pause=0.5)
        if r.status != 200:
            return r, None, None
        z = zipfile.ZipFile(io.BytesIO(r.body))
        member = z.namelist()[0]
        rows = xlsx_rows(z.read(member)) if member.endswith(".xlsx") else list(csv.reader(io.StringIO(z.read(member).decode())))
        return r, member, rows

    def rows_to_norm(rows):
        hdr = [h.strip().lower() for h in rows[0]]
        ix = {k: i for i, k in enumerate(hdr)}
        return hdr, [dict(t=to_ms(int(Decimal(x[ix["timestamp"]]))), o=D(x[ix["open"]]), h=D(x[ix["high"]]),
                          l=D(x[ix["low"]]), c=D(x[ix["close"]]), base=D(x[ix["basevolume"]]),
                          quote=D(x[ix["usdtvolume"]]), extra={}) for x in rows[1:]]

    f24 = [f for f in files.get("ETH/USDT", []) if f.get("dateTimeStr") == "2024-03-01"]
    if f24:
        r, member, rows = load_xlsx_zip(f24[0]["fileUrl"], "kline file 2024-03-01 GET")
        if rows:
            hdr, fr = rows_to_norm(rows)
            a = analyze(fr)
            a.pop("example", None)
            ev.note(V, "bulk kline file ETH/USDT 2024-03-01", {"url": f24[0]["fileUrl"], "zip_member": member,
                                                               "size": len(r.body), "header": hdr,
                                                               "first_row": rows[1], "last_row": rows[-1], **a})
    if len(recent) >= 2:
        pick = sorted(recent, key=lambda f: f["dateTimeStr"])[-2]
        r, member, rows = load_xlsx_zip(pick["fileUrl"], f"kline file {pick['dateTimeStr']} GET")
        if rows:
            hdr, fr = rows_to_norm(rows)
            a = analyze(fr)
            a.pop("example", None)
            # REST for the first 200 minutes of that file
            t_first = min(x["t"] for x in fr)
            r2, j2, d2 = bitget_v2(H, ev, "history-candles for file compare", "history-candles", symbol="ETHUSDT",
                                   granularity="1min", endTime=t_first + 200 * MIN, limit=200)
            rest = [norm(V, x) for x in d2]
            ev.note(V, f"bulk kline file ETH/USDT {pick['dateTimeStr']} vs REST", {
                "url": pick["fileUrl"], **a, "vs_REST_history-candles": compare(fr, rest),
                "REST_quoteVolume_vs_usdtVolume_equal": all(x[6] == x[7] for x in d2) if d2 and len(d2[0]) > 7 else None})

    if illiquid:
        illiquid_bitget(H, ev)


def illiquid_bitget(H, ev):
    V = "bitget"
    r, j, d = bitget_v2(H, ev, "tickers (illiquid pick)", "tickers")
    cand = [t for t in d if t["symbol"].endswith("USDT") and D(t.get("usdtVolume") or 0) > 0]
    cand.sort(key=lambda t: D(t["usdtVolume"]))
    if cand:
        s = cand[0]["symbol"]
        r, j, d = bitget_v2(H, ev, f"illiquid {s} candles", "candles", symbol=s, granularity="1min",
                            startTime=NOW_MIN - 180 * MIN, endTime=NOW_MIN - MIN, limit=1000)
        rows = [norm(V, x) for x in d]
        a = analyze(rows)
        ev.note(V, "no-trade minute behaviour (illiquid pair)", {
            "symbol": s, "24h_usdtVolume": cand[0]["usdtVolume"], "requested": 180, "returned": a["count"],
            "n_gaps": a.get("n_gaps"), "zero_base_vol_rows": a.get("zero_base_vol"),
            "zero_row_example": zero_example(rows)})


# =========================================================================== KUCOIN

def probe_kucoin(H, ev, illiquid=True):
    V = "kucoin"
    K = "https://api.kucoin.com/api/v1/market/candles"
    rest_2024 = {}
    for sym in ("ETH-USDT", "BTC-USDT"):
        for lab, t in (("2024-03-01", T24), ("2025-03-01", T25)):
            s = t // 1000
            r = H.req(V, f"{sym} candles {lab}", f"{K}?type=1min&symbol={sym}&startAt={s}&endAt={s + 300}", pause=0.4)
            j = r.json() or {}
            d = j.get("data") or []
            ev.note(V, f"{sym} REST {lab} [startAt, startAt+300]", {
                "status": r.status, "code": j.get("code"), **analyze([norm(V, x) for x in d]),
                "raw_first": d[0] if d else None,
                "ratelimit_headers": {k: v for k, v in r.headers.items() if "ratelimit" in k.lower()}})
        s = NOW_MIN // 1000
        r = H.req(V, f"{sym} candles latest", f"{K}?type=1min&symbol={sym}&startAt={s - 180}&endAt={s + 60}", pause=0.4)
        d = (r.json() or {}).get("data") or []
        ev.note(V, f"{sym} latest (in-progress check)", {"now": iso(NOW), "rows": [iso(x[0]) for x in d]})
        s = T24 // 1000
        r = H.req(V, f"{sym} candles page 1500", f"{K}?type=1min&symbol={sym}&startAt={s}&endAt={s + 1500 * 60}", pause=0.4)
        d = (r.json() or {}).get("data") or []
        rows = [norm(V, x) for x in d]
        rest_2024[sym] = rows
        a = analyze(rows)
        a.pop("example", None)
        ev.note(V, f"{sym} REST page [2024-03-01, +1500min]", a)
    s = ms(2018, 1, 1) // 1000
    r = H.req(V, "candles 2018", f"{K}?type=1min&symbol=ETH-USDT&startAt={s}&endAt={s + 300}", pause=0.4)
    d = (r.json() or {}).get("data") or []
    ev.note(V, "ETH-USDT 1m at 2018-01-01 (depth check)", {"status": r.status, "rows": [iso(x[0]) for x in d]})
    r = H.req(V, "candles 1week earliest", f"{K}?type=1week&symbol=ETH-USDT&startAt=1&endAt={ms(2019, 1, 1) // 1000}", pause=0.4)
    d = (r.json() or {}).get("data") or []
    ev.note(V, "ETH-USDT earliest weekly bar (listing)", {"oldest": iso(d[-1][0]) if d else None, "n": len(d)})

    # ---- bulk: historical-data.kucoin.com (S3 style listing)
    KB = "https://historical-data.kucoin.com"
    ev.note(V, "S3 list data/", s3_list(H, V, "S3 list data/", KB, "data/"))
    ev.note(V, "S3 list data/spot/", s3_list(H, V, "S3 list data/spot/", KB, "data/spot/"))
    ev.note(V, "S3 list data/spot/daily/", s3_list(H, V, "S3 list data/spot/daily/", KB, "data/spot/daily/"))
    ev.note(V, "S3 list data/spot/monthly/", s3_list(H, V, "S3 list data/spot/monthly/", KB, "data/spot/monthly/"))
    for sym in ("ETHUSDT", "BTCUSDT"):
        ev.note(V, f"S3 list daily klines {sym} 1m (first page)",
                s3_list(H, V, f"S3 list daily {sym} 1m", KB, f"data/spot/daily/klines/{sym}/1m/"))
    ev.note(V, "S3 list daily klines ETHUSDT 1m (from 2026-09-20)",
            s3_list(H, V, "S3 list daily ETHUSDT 1m recent", KB, "data/spot/daily/klines/ETHUSDT/1m/",
                    marker="data/spot/daily/klines/ETHUSDT/1m/ETHUSDT-1m-2026-09-20"))
    ev.note(V, "S3 list monthly klines ETHUSDT 1m",
            s3_list(H, V, "S3 list monthly ETHUSDT 1m", KB, "data/spot/monthly/klines/ETHUSDT/1m/"))
    for sym, rsym in (("ETHUSDT", "ETH-USDT"), ("BTCUSDT", "BTC-USDT")):
        u = f"{KB}/data/spot/daily/klines/{sym}/1m/{sym}-1m-2024-03-01.zip"
        r = H.req(V, f"{sym} daily 2024-03-01 GET", u, pause=0.4)
        if r.status == 200:
            names, rows = zip_csv_rows(r.body)
            hdr, data = rows[0], rows[1:]
            fr = [norm(V, x) for x in data]
            a = analyze(fr)
            a.pop("example", None)
            ev.note(V, f"bulk daily kline file {sym} 2024-03-01", {"url": u, "member": names, "header": hdr,
                                                                   "n_rows": len(data), "first_row": data[0], **a,
                                                                   "vs_REST": compare(fr, rest_2024.get(rsym, []))})
    for sym in ("ETHUSDT",):
        lst = s3_list(H, V, "S3 list daily trades", KB, f"data/spot/daily/trades/{sym}/",
                      marker=f"data/spot/daily/trades/{sym}/{sym}-trades-2024-06-14")
        ev.note(V, f"S3 list daily trades {sym} (from 2024-06-14)", lst)
        u = f"{KB}/data/spot/daily/trades/{sym}/{sym}-trades-2024-06-15.zip"
        r = H.req(V, "trades 2024-06-15 HEAD", u, method="HEAD", pause=0.4)
        info = {"url": u, "status": r.status, "size": r.headers.get("Content-Length")}
        if r.status == 200:
            r2 = H.req(V, "trades peek", u, rng=(0, 8191), pause=0.4)
            if r2.status in (200, 206):
                info["range_status"] = r2.status
                info["peek"] = peek_zip(r2.body)
        ev.note(V, f"trade-level file {sym} 2024-06-15", info)

    if illiquid:
        illiquid_kucoin(H, ev)


def illiquid_kucoin(H, ev):
    V = "kucoin"
    K = "https://api.kucoin.com/api/v1/market/candles"
    r = H.req(V, "allTickers (illiquid pick)", "https://api.kucoin.com/api/v1/market/allTickers", log_body=200, pause=0.4)
    tick = ((r.json() or {}).get("data") or {}).get("ticker", [])
    cand = [t for t in tick if t["symbol"].endswith("-USDT") and D(t.get("volValue") or 0) > 0]
    cand.sort(key=lambda t: D(t["volValue"]))
    if cand:
        sname = cand[0]["symbol"]
        s = NOW_MIN // 1000
        r = H.req(V, f"illiquid {sname} candles", f"{K}?type=1min&symbol={sname}&startAt={s - 180 * 60}&endAt={s - 60}", pause=0.4)
        d = (r.json() or {}).get("data") or []
        rows = [norm(V, x) for x in d]
        a = analyze(rows)
        ev.note(V, "no-trade minute behaviour (illiquid pair)", {
            "symbol": sname, "24h_volValue": cand[0]["volValue"], "requested": 180, "returned": a["count"],
            "n_gaps": a.get("n_gaps"), "zero_base_vol_rows": a.get("zero_base_vol"),
            "zero_row_example": zero_example(rows)})


# =========================================================================== extras (--extras)
# Earliest 1m depth via REST (binary search by day, monotone "data exists" predicate) and a few
# follow-up checks. ~10-20 requests per venue.

DAY = 86400_000


def bsearch_first_day(pred, lo, hi):
    """lo: day-start ms where pred is False, hi: day-start ms where pred is True -> first True day."""
    steps = []
    while hi - lo > DAY:
        mid = lo + ((hi - lo) // DAY // 2) * DAY
        ok = pred(mid)
        steps.append((iso(mid)[:10], ok))
        if ok:
            hi = mid
        else:
            lo = mid
    return hi, steps


def extras_binance(H, ev):
    ev.note("binance", "extras", "earliest 1m already obtained from startTime=0 (2017-08-17)")


def extras_okx(H, ev):
    V = "okx"
    O = "https://www.okx.com/api/v5"

    def pred(t):  # any 1m candle before t+1d ?
        r = H.req(V, f"depth {iso(t)[:10]}", f"{O}/market/history-candles?instId=ETH-USDT&bar=1m&after={t + DAY}&limit=1")
        return bool((r.json() or {}).get("data"))
    first, steps = bsearch_first_day(pred, ms(2018, 1, 1), T24)
    r = H.req(V, "depth confirm", f"{O}/market/history-candles?instId=ETH-USDT&bar=1m&after={first + DAY}&limit=300")
    d = (r.json() or {}).get("data") or []
    ev.note(V, "REST 1m earliest ETH-USDT (binary search)", {"first_day_with_data": iso(first)[:10], "steps": steps,
                                                           "oldest_row_in_that_day": iso(d[-1][0]) if d else None})
    q = dict(module="2", instType="SPOT", instIdList="ETH-USDT", dateAggrType="monthly",
             begin=str(ms(2023, 1, 1)), end=str(ms(2023, 10, 1)))
    r = H.req(V, "bulk candles monthly 2023", f"{O}/public/market-data-history?" + urllib.parse.urlencode(q), pause=0.5)
    j = r.json() or {}
    fl = sorted(g.get("filename") for d in (j.get("data") or [{}])[0].get("details", []) for g in d.get("groupDetails", []))
    ev.note(V, "bulk module=2 monthly files ETH-USDT 2023-01..2023-10", {"files": fl})


def extras_bybit(H, ev):
    V = "bybit"
    Y = "https://api.bybit.com/v5/market"

    def pred(t):
        r = H.req(V, f"depth {iso(t)[:10]}", f"{Y}/kline?category=spot&symbol=ETHUSDT&interval=1&start={t}&end={t + DAY}&limit=1000")
        return bool(((r.json() or {}).get("result") or {}).get("list"))
    first, steps = bsearch_first_day(pred, ms(2021, 7, 1), T24)
    r = H.req(V, "depth confirm", f"{Y}/kline?category=spot&symbol=ETHUSDT&interval=1&start={first}&end={first + DAY}&limit=1000")
    lst = ((r.json() or {}).get("result") or {}).get("list", [])
    ev.note(V, "REST 1m earliest ETHUSDT (binary search)", {"first_day_with_data": iso(first)[:10], "steps": steps,
                                                          "oldest_row": iso(lst[-1][0]) if lst else None,
                                                          "rows_that_day": len(lst)})
    r = H.req(V, "public.bybit.com spot ETHUSDT listing", "https://public.bybit.com/spot/ETHUSDT/", log_body=200)
    import re
    names = re.findall(r'href="([^"]+\.csv\.gz)"', r.text())
    monthly = [n for n in names if re.search(r"-\d{4}-\d{2}\.csv\.gz$", n)]
    daily = [n for n in names if re.search(r"_\d{4}-\d{2}-\d{2}\.csv\.gz$", n)]
    ev.note(V, "public.bybit.com/spot/ETHUSDT listing", {"n_files": len(names), "monthly_first_last": monthly[:1] + monthly[-1:],
                                                         "n_monthly": len(monthly), "daily_first_last": daily[:1] + daily[-1:],
                                                         "n_daily": len(daily)})


def extras_bitget(H, ev):
    V = "bitget"

    def pred(t):
        r, j, d = bitget_v2(H, ev, f"depth {iso(t)[:10]}", "history-candles", symbol="ETHUSDT", granularity="1min",
                            endTime=t + DAY, limit=1)
        return bool(d)
    first, steps = bsearch_first_day(pred, ms(2018, 1, 1), T24)
    r, j, d = bitget_v2(H, ev, "depth confirm", "history-candles", symbol="ETHUSDT", granularity="1min",
                        endTime=first + DAY, limit=200)
    ev.note(V, "REST history-candles 1min earliest ETHUSDT (binary search)",
            {"first_day_with_data": iso(first)[:10], "steps": steps, "rows": len(d),
             "oldest_row": iso(d[0][0]) if d else None})
    # bulk files: earliest kline / trades file date (7-day listing windows)
    WEB = "https://www.bitget.com/v1/statistics/public/download/getPublicDataV2"

    def lister(bt):
        def p(t):
            b = dt.datetime.fromtimestamp(t / 1000, UTC)
            body = {"displaySymbol": "ETH/USDT", "businessLine": 1, "businessType": bt, "dateType": 1,
                    "beginTimeStr": b.strftime("%Y-%m-%d"), "endTimeStr": (b + dt.timedelta(days=6)).strftime("%Y-%m-%d")}
            r = H.req(V, f"bulk bt={bt} list {body['beginTimeStr']}", WEB, method="POST", data=body, pause=0.5, log_body=300)
            return bool((r.json() or {}).get("data"))
        return p
    for bt, lab, lo, hi in ((1, "kline", ms(2018, 1, 1), T24), (2, "transactions", T24, ms(2026, 9, 19))):
        first, steps = bsearch_first_day(lister(bt), lo, hi)
        ev.note(V, f"bulk {lab} earliest week (binary search, 7-day windows)",
                {"first_window_start_with_files": iso(first)[:10], "note": "file exists within [start, start+6d]",
                 "steps": steps})
    # 2024 REST vs 2024 file (UTC+8 day file 2024-03-01 = 2024-02-29T16:00Z..)
    r = H.req(V, "kline file 2024-03-01 GET (compare)", "https://img.bitgetimg.com/online/kline/ETHUSDT/ETHUSDT_SP_1min_20240301.zip", pause=0.5)
    if r.status == 200:
        z = zipfile.ZipFile(io.BytesIO(r.body))
        rows = xlsx_rows(z.read(z.namelist()[0]))
        hdr = [h.strip().lower() for h in rows[0]]
        ix = {k: i for i, k in enumerate(hdr)}
        fr = [dict(t=to_ms(int(Decimal(x[ix["timestamp"]]))), o=D(x[ix["open"]]), h=D(x[ix["high"]]), l=D(x[ix["low"]]),
                   c=D(x[ix["close"]]), base=D(x[ix["basevolume"]]), quote=D(x[ix["usdtvolume"]]), extra={}) for x in rows[1:]]
        t0 = min(x["t"] for x in fr)
        r2, j2, d2 = bitget_v2(H, ev, "history-candles 2024 compare", "history-candles", symbol="ETHUSDT",
                               granularity="1min", endTime=t0 + 200 * MIN, limit=200)
        ev.note(V, "bulk file 2024-03-01 vs REST history-candles", compare(fr, [norm(V, x) for x in d2]))
    # endTime semantics
    t = T25 + 5 * MIN
    r, j, d = bitget_v2(H, ev, "history-candles endTime semantics", "history-candles", symbol="ETHUSDT",
                        granularity="1min", endTime=t, limit=3)
    r2, j2, d2 = bitget_v2(H, ev, "history-candles startTime ignored?", "history-candles", symbol="ETHUSDT",
                           granularity="1min", startTime=T25, endTime=t, limit=3)
    ev.note(V, "history-candles endTime=2025-03-01T00:05 limit=3", {"rows": [iso(x[0]) for x in d],
                                                                    "with_startTime": [iso(x[0]) for x in d2],
                                                                    "code2": j2.get("code"), "msg2": j2.get("msg")})
    peek_bitget_trades(H, ev)


def peek_bitget_trades(H, ev, day="2024-06-15"):
    """List Bitget spot trade files for one day and peek at the first part (columns, time zone)."""
    V = "bitget"
    body = {"displaySymbol": "ETH/USDT", "businessLine": 1, "businessType": 2, "dateType": 1,
            "beginTimeStr": day, "endTimeStr": day}
    r = H.req(V, f"bulk trades list {day}", "https://www.bitget.com/v1/statistics/public/download/getPublicDataV2",
              method="POST", data=body, pause=0.5, log_body=1500)
    files = (r.json() or {}).get("data") or []
    info = {"n_parts": len(files), "files": [f.get("fileUrl") for f in files]}
    if files:
        u = files[0]["fileUrl"]
        r = H.req(V, "trades part HEAD", u, method="HEAD", pause=0.5)
        info["part1_size"] = r.headers.get("Content-Length")
        r2 = H.req(V, "trades part peek", u, rng=(0, 16383), pause=0.5)
        info["range_status"] = r2.status
        pk = peek_zip(r2.body) if r2.status in (200, 206) else None
        info["peek_member"] = pk[0] if pk else None
        info["peek_lines"] = pk[1] if pk and not pk[0].endswith(".xlsx") else "(xlsx: not line-readable in a peek)"
    ev.note(V, f"bulk trades ETH/USDT {day}", info)


def extras_kucoin(H, ev):
    V = "kucoin"
    K = "https://api.kucoin.com/api/v1/market/candles"

    def pred(t):
        s = t // 1000
        r = H.req(V, f"depth {iso(t)[:10]}", f"{K}?type=1min&symbol=ETH-USDT&startAt={s}&endAt={s + 86400}", pause=0.4)
        return bool((r.json() or {}).get("data"))
    first, steps = bsearch_first_day(pred, ms(2018, 1, 1), T24)
    s = first // 1000
    r = H.req(V, "depth confirm", f"{K}?type=1min&symbol=ETH-USDT&startAt={s}&endAt={s + 86400}", pause=0.4)
    d = (r.json() or {}).get("data") or []
    ev.note(V, "REST 1m earliest ETH-USDT (binary search)", {"first_day_with_data": iso(first)[:10], "steps": steps,
                                                           "rows_that_day": len(d), "oldest_row": iso(d[-1][0]) if d else None})
    KB = "https://historical-data.kucoin.com"
    ev.note(V, "S3 list daily trades ETHUSDT (first page)",
            s3_list(H, V, "S3 list daily trades first", KB, "data/spot/daily/trades/ETHUSDT/"))
    # no-trade minutes on a thinly traded (not dead) pair
    r = H.req(V, "allTickers (thin pick)", "https://api.kucoin.com/api/v1/market/allTickers", log_body=200, pause=0.4)
    tick = ((r.json() or {}).get("data") or {}).get("ticker", [])
    cand = [t for t in tick if t["symbol"].endswith("-USDT") and D(t.get("volValue") or 0) > 0]
    cand.sort(key=lambda t: D(t["volValue"]))
    for frac in (0.1, 0.25):
        c = cand[int(len(cand) * frac)]
        s = NOW_MIN // 1000
        r = H.req(V, f"thin {c['symbol']} candles", f"{K}?type=1min&symbol={c['symbol']}&startAt={s - 180 * 60}&endAt={s - 60}", pause=0.4)
        d = (r.json() or {}).get("data") or []
        rows = [norm(V, x) for x in d]
        a = analyze(rows)
        ev.note(V, f"no-trade minute behaviour (pair at {int(frac * 100)}th pct of 24h volValue)", {
            "symbol": c["symbol"], "24h_volValue": c["volValue"], "requested": 179, "returned": a["count"],
            "n_gaps": a.get("n_gaps"), "gaps_example": a.get("gaps"), "zero_base_vol_rows": a.get("zero_base_vol")})


# =========================================================================== main

PROBES = {"binance": probe_binance, "okx": probe_okx, "bybit": probe_bybit,
          "bitget": probe_bitget, "kucoin": probe_kucoin}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("venues", nargs="*", default=list(PROBES), choices=list(PROBES))
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "corrfi_probe"))
    ap.add_argument("--no-illiquid", action="store_true", help="skip the no-trade-minute probe on an illiquid pair")
    ap.add_argument("--illiquid-only", action="store_true", help="run only the no-trade-minute probe")
    ap.add_argument("--extras", action="store_true",
                    help="run only the follow-up checks (REST 1m depth binary search, bulk earliest, etc.)")
    args = ap.parse_args()
    ev = Evidence(args.out)
    H = Http(ev)
    print(f"probe start {iso(NOW)}; evidence -> {ev.path}")
    for v in args.venues:
        print(f"===== {v}")
        try:
            if args.extras:
                globals()[f"extras_{v}"](H, ev)
            elif args.illiquid_only:
                globals()[f"illiquid_{v}"](H, ev)
            else:
                PROBES[v](H, ev, illiquid=not args.no_illiquid)
        except Exception as e:  # keep going with other venues; record the failure
            import traceback
            ev.note(v, "PROBE_EXCEPTION", {"error": f"{type(e).__name__}: {e}", "tb": traceback.format_exc()[-1500:]})
        lat = ev.latency.get(v, [])
        ev.note(v, "request_stats", {"requests": H.count.get(v, 0),
                                     "median_latency_s": round(statistics.median(lat), 3) if lat else None})
    spath = os.path.join(args.out, "summary.json")
    prev = {}
    if os.path.exists(spath):
        try:
            prev = json.load(open(spath, encoding="utf-8"))
        except Exception:
            prev = {}
    for venue, notes in ev.summary.items():  # merge per label so partial re-runs do not drop earlier notes
        prev.setdefault(venue, {}).update(notes)
    with open(spath, "w", encoding="utf-8") as f:
        json.dump(prev, f, ensure_ascii=False, indent=1, default=str)
    print(f"summary -> {spath}")


if __name__ == "__main__":
    main()
