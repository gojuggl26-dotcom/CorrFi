"""Stream price points for a time range from the normalized monthly store (see store.py)."""
from __future__ import annotations

from collections import OrderedDict
from pathlib import Path
from typing import Iterator, Optional

from .grid import PricePoint, price_point
from .store import MinuteBar, month_key, month_path, read_month


class MonthCache:
    """Loads monthly files on demand and keeps the most recent few in memory (grid scans move forward)."""

    def __init__(self, root: Path, symbol: str, keep: int = 2):
        self.root, self.symbol, self.keep = Path(root), symbol, keep
        self._months: OrderedDict[tuple[str, str], dict[int, MinuteBar]] = OrderedDict()

    def _load(self, venue: str, month: str) -> dict[int, MinuteBar]:
        key = (venue, month)
        if key in self._months:
            self._months.move_to_end(key)
            return self._months[key]
        path = month_path(self.root, venue, self.symbol, month)
        rows = {b.open_time: b for b in read_month(path)} if path.exists() else {}
        self._months[key] = rows
        while len(self._months) > self.keep * 5:   # 5 venues
            self._months.popitem(last=False)
        return rows

    def __call__(self, venue: str, open_time: int) -> Optional[MinuteBar]:
        return self._load(venue, month_key(open_time)).get(open_time)


def grid_times(t_start: int, t_end: int, step: int) -> range:
    """Grid times in [t_start, t_end) that are multiples of step."""
    first = -(-t_start // step) * step
    return range(first, t_end, step)


def price_points(root: Path, symbol: str, venues: tuple[str, ...], t_start: int, t_end: int,
                 step: int) -> Iterator[PricePoint]:
    lookup = MonthCache(root, symbol)
    for t in grid_times(t_start, t_end, step):
        yield price_point(t, venues, lookup)
