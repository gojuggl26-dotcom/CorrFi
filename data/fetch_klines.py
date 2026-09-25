"""Download spot 1-minute klines for the 5 venues x ETH/USDT, BTC/USDT into the normalized monthly store.

Usage:
  python data/fetch_klines.py --start 2024-03-01 --end 2026-09-25 [--venues binance,okx,...]
                              [--store data/store/1m] [--manifest data/manifests/klines_1m.json]

- One thread per venue (both symbols sequentially), with a per-venue request rate below the documented limits
  (docs/s02/01-venue-api-survey.md). HTTP 429 / 418 / 5xx / network errors are retried with backoff (Retry-After
  when the venue sends it); Bybit's 403 ("access too frequent") waits 10 minutes as its docs require. A backoff
  holds the whole venue client, not only the thread that saw the error (review S03-3).
- Resumable: a month already recorded as complete in the manifest (same range) is skipped.
- Every request is logged (URL, status, rows, seconds) to data/raw/logs/<venue>.jsonl.
- The manifest records per file: rows, expected minutes, first/last open_time, sha256, endpoint, fetch time.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aquacorr_data import SYMBOLS, VENUES  # noqa: E402
from aquacorr_data.store import month_path, write_month  # noqa: E402
from aquacorr_data.timeutil import iso, utc  # noqa: E402
from aquacorr_data.venues import ADAPTERS, VenueError  # noqa: E402

UA = "CorrFi-data/0.1 (research; public market data)"
REPO = Path(__file__).resolve().parents[1]


def month_windows(start: int, end: int):
    """(label, window_start, window_end) per UTC month intersecting [start, end)."""
    d = datetime.fromtimestamp(start, tz=timezone.utc).replace(day=1, hour=0, minute=0, second=0)
    while int(d.timestamp()) < end:
        nxt = d.replace(year=d.year + (d.month == 12), month=d.month % 12 + 1)
        yield d.strftime("%Y-%m"), max(start, int(d.timestamp())), min(end, int(nxt.timestamp()))
        d = nxt


class Client:
    """Per-venue HTTP client shared by the symbol threads: one request-rate budget, one log."""

    def __init__(self, venue: str, rate_per_s: float, log_path: Path):
        self.venue, self.interval = venue, 1.0 / rate_per_s
        self.next_at = 0.0
        self.lock = threading.Lock()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        self.log = open(log_path, "a", encoding="utf-8", newline="\n")

    def _pace(self):
        with self.lock:                      # reserve the next slot, then sleep outside the lock
            now = time.monotonic()
            slot = max(now, self.next_at)
            self.next_at = slot + self.interval
        if slot > now:
            time.sleep(slot - now)

    def _hold(self, seconds: float):
        """Push the client's next request slot out: every thread of this venue waits, not only the caller."""
        with self.lock:
            self.next_at = max(self.next_at, time.monotonic() + seconds)

    @staticmethod
    def _retry_after(headers) -> Optional[float]:
        v = headers.get("Retry-After") if headers is not None else None
        try:
            return float(v) if v is not None else None
        except ValueError:          # an HTTP date: fall back to the exponential backoff
            return None

    def get_json(self, url: str):
        backoff = 2.0
        for attempt in range(10):
            self._pace()
            t0 = time.monotonic()
            status, body, err, headers = None, b"", None, None
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    status, body = r.status, r.read()
            except urllib.error.HTTPError as e:
                status, body, headers = e.code, e.read(), e.headers
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                err = repr(e)
            dt = round(time.monotonic() - t0, 3)
            with self.lock:
                self.log.write(json.dumps({"ts": iso(int(time.time())), "url": url, "status": status,
                                           "bytes": len(body), "s": dt, "err": err,
                                           "attempt": attempt}) + "\n")
                self.log.flush()
            if status == 200:
                return json.loads(body)
            if status == 403 and self.venue == "bybit":
                self._hold(600)                      # Bybit: stop >= 10 minutes after a 403
            elif err is not None or status in (418, 429) or (status is not None and status >= 500):
                self._hold(self._retry_after(headers) or backoff)
                backoff = min(backoff * 2, 120)
            else:
                raise VenueError(f"{self.venue}: HTTP {status}: {body[:200]!r}")
        raise VenueError(f"{self.venue}: giving up after retries: {url}")


class Manifest:
    def __init__(self, path: Path):
        self.path, self.lock = path, threading.Lock()
        self.data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"files": {}}

    def done(self, key: str, w0: int, w1: int) -> bool:
        e = self.data["files"].get(key)
        return bool(e and e.get("complete") and e["window"] == [w0, w1])

    def put(self, key: str, entry: dict):
        with self.lock:
            self.data["files"][key] = entry
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, indent=1, sort_keys=True), encoding="utf-8",
                           newline="\n")
            tmp.replace(self.path)


MONTH_ATTEMPTS = 5   # API-level transient errors (e.g. Bybit retCode 10016 "internal error") retry the month


def run_symbol(venue: str, sym: str, client: Client, args, manifest: Manifest, errors: list):
    adapter = ADAPTERS[venue]
    for label, w0, w1 in month_windows(args.start, args.end):
        key = f"{venue}/{sym}/{label}"
        if manifest.done(key, w0, w1):
            continue
        t0 = time.time()
        for attempt in range(MONTH_ATTEMPTS):
            try:
                bars = adapter.fetch(client.get_json, sym, w0, w1, int(time.time()))
                break
            except Exception as e:
                print(f"retry {key} ({attempt + 1}/{MONTH_ATTEMPTS}): {e!r}", flush=True)
                time.sleep(10 * 2 ** attempt)
        else:  # keep other months/venues going; a rerun resumes
            errors.append((key, "gave up after retries"))
            print(f"FAIL {key}", flush=True)
            continue
        path = month_path(args.store, venue, sym, label)
        rows = write_month(path, bars)
        times = sorted(b.open_time for b in bars)
        manifest.put(key, {
            "venue": venue, "symbol": sym, "month": label, "window": [w0, w1],
            "window_iso": [iso(w0), iso(w1)], "rows": rows, "expected_minutes": (w1 - w0) // 60,
            "first": iso(times[0]) if times else None, "last": iso(times[-1]) if times else None,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "file": (path.relative_to(REPO) if path.is_relative_to(REPO) else path).as_posix(),
            "endpoint": adapter.URL,
            "fetched_at": iso(int(time.time())), "complete": True})
        print(f"ok   {key}: {rows}/{(w1 - w0) // 60} rows in {time.time() - t0:.0f}s", flush=True)


def run_venue(venue: str, args, manifest: Manifest, errors: list):
    client = Client(venue, ADAPTERS[venue].rate_per_s, REPO / "data" / "raw" / "logs" / f"{venue}.jsonl")
    threads = [threading.Thread(target=run_symbol, args=(venue, s, client, args, manifest, errors),
                                name=f"{venue}-{s}") for s in SYMBOLS]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, type=utc)
    ap.add_argument("--end", required=True, type=utc)
    ap.add_argument("--venues", default=",".join(VENUES))
    ap.add_argument("--store", type=Path, default=REPO / "data" / "store" / "1m")
    ap.add_argument("--manifest", type=Path, default=REPO / "data" / "manifests" / "klines_1m.json")
    args = ap.parse_args()
    if args.end > time.time():
        ap.error("--end must not be in the future")
    manifest, errors = Manifest(args.manifest), []
    threads = [threading.Thread(target=run_venue, args=(v, args, manifest, errors), name=v)
               for v in args.venues.split(",")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    print(f"done; {len(errors)} failed month(s)", flush=True)
    for key, e in errors:
        print(f"  {key}: {e}", flush=True)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
