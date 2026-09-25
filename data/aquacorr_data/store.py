"""Normalized storage of 1-minute spot bars.

One gzip CSV per venue / symbol / UTC month:  <root>/<venue>/<SYMBOL>/<YYYY-MM>.csv.gz
Columns: open_time,open,high,low,close,base_volume,quote_volume

- open_time: integer seconds (UTC) of the bar OPEN; the bar covers [open_time, open_time + 60).
- Prices and volumes are kept as the decimal strings delivered by the venue (no float round-trip),
  following R §3.1.2 p.7 ("二進浮動小数点を経由しない").
- Rows are sorted by open_time and unique. Minutes a venue did not return are simply absent.
"""
from __future__ import annotations

import csv
import gzip
import io
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator

COLUMNS = ("open_time", "open", "high", "low", "close", "base_volume", "quote_volume")


@dataclass(frozen=True)
class MinuteBar:
    open_time: int
    open: str
    high: str
    low: str
    close: str
    base_volume: str
    quote_volume: str

    def __post_init__(self) -> None:
        if self.open_time % 60 != 0:
            raise ValueError(f"open_time {self.open_time} is not on a minute boundary")


def month_key(open_time: int) -> str:
    return datetime.fromtimestamp(open_time, tz=timezone.utc).strftime("%Y-%m")


def month_path(root: Path, venue: str, symbol: str, month: str) -> Path:
    return Path(root) / venue / symbol / f"{month}.csv.gz"


def write_month(path: Path, bars: Iterable[MinuteBar]) -> int:
    """Write bars (any order, duplicates must agree) sorted and de-duplicated. Returns row count."""
    by_time: dict[int, MinuteBar] = {}
    for b in bars:
        prev = by_time.get(b.open_time)
        if prev is not None and prev != b:
            raise ValueError(f"conflicting duplicate bar at {b.open_time}: {prev} vs {b}")
        by_time[b.open_time] = b
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    # empty filename and mtime=0 keep the gzip header content-only, so file hashes are reproducible
    with open(tmp, "wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as gz, \
            io.TextIOWrapper(gz, encoding="utf-8", newline="") as text:
        w = csv.writer(text, lineterminator="\n")
        w.writerow(COLUMNS)
        for t in sorted(by_time):
            b = by_time[t]
            w.writerow((b.open_time, b.open, b.high, b.low, b.close, b.base_volume, b.quote_volume))
    tmp.replace(path)
    return len(by_time)


def read_month(path: Path) -> Iterator[MinuteBar]:
    with gzip.open(path, mode="rt", encoding="utf-8", newline="") as f:
        r = csv.reader(f)
        header = next(r)
        if tuple(header) != COLUMNS:
            raise ValueError(f"{path}: unexpected header {header}")
        last = None
        for row in r:
            bar = MinuteBar(int(row[0]), *row[1:])
            if last is not None and bar.open_time <= last:
                raise ValueError(f"{path}: rows not strictly increasing at {bar.open_time}")
            last = bar.open_time
            yield bar
