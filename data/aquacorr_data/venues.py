"""REST adapters for spot 1-minute klines on the five venues (M §2.5.1 p.8).

Endpoint semantics were measured in docs/s02/01-venue-api-survey.md (2026-09-25). Each adapter returns every
closed 1-minute bar with open_time in [start, end) (seconds, UTC), mapped to MinuteBar with the venue's own
decimal strings. Pagination is time-driven, so minutes a venue does not return are simply absent.

| venue   | endpoint (spot, 1m)                          | page  | order  | base / quote columns       |
|---------|----------------------------------------------|-------|--------|----------------------------|
| binance | /api/v3/klines   startTime/endTime (ms, incl)| 1000  | asc    | [5] / [7]                  |
| okx     | /api/v5/market/history-candles after (excl)  | 300   | desc   | [5] vol / [7] volCcyQuote  |
| bybit   | /v5/market/kline category=spot start/end incl| 1000  | desc   | [5] volume / [6] turnover  |
| bitget  | /api/v2/spot/market/history-candles endTime excl | 200 | asc  | [5] base / [7] quoteVolume |
| kucoin  | /api/v1/market/candles startAt/endAt (s) [ , )| 1500 | desc   | [5] volume / [6] turnover; order o,c,h,l |
"""
from __future__ import annotations

from typing import Callable
from urllib.parse import urlencode

from .store import MinuteBar

GetJson = Callable[[str], object]
MIN = 60


class VenueError(RuntimeError):
    """The venue answered with an API-level error (not retried automatically)."""


def _closed(t: int, now: int) -> bool:
    return t + MIN <= now


class Binance:
    name, rate_per_s = "binance", 8.0
    URL = "https://api.binance.com/api/v3/klines"

    @staticmethod
    def symbol(sym: str) -> str:
        return sym

    def fetch(self, get_json: GetJson, sym: str, start: int, end: int, now: int) -> list[MinuteBar]:
        out, cursor = [], start
        while cursor < end:
            q = dict(symbol=self.symbol(sym), interval="1m", startTime=cursor * 1000,
                     endTime=end * 1000 - 1, limit=1000)
            rows = get_json(f"{self.URL}?{urlencode(q)}")
            if not isinstance(rows, list):
                raise VenueError(f"binance: unexpected response {str(rows)[:200]}")
            if not rows:
                break
            for r in rows:
                t = int(r[0]) // 1000
                if start <= t < end and _closed(t, now):
                    out.append(MinuteBar(t, r[1], r[2], r[3], r[4], r[5], r[7]))
            last = int(rows[-1][0]) // 1000
            if last < cursor:
                raise VenueError("binance: pagination did not advance")
            cursor = last + MIN
        return out


class Okx:
    name, rate_per_s = "okx", 8.0
    URL = "https://www.okx.com/api/v5/market/history-candles"

    @staticmethod
    def symbol(sym: str) -> str:
        return sym[:-4] + "-USDT"

    def fetch(self, get_json: GetJson, sym: str, start: int, end: int, now: int) -> list[MinuteBar]:
        out, cursor = [], end            # 'after' returns bars strictly older than cursor, newest first
        while cursor > start:
            q = dict(instId=self.symbol(sym), bar="1m", after=cursor * 1000, limit=300)
            resp = get_json(f"{self.URL}?{urlencode(q)}")
            if resp.get("code") != "0":
                raise VenueError(f"okx: {str(resp)[:200]}")
            data = resp["data"]
            if not data:
                break
            for r in data:
                t = int(r[0]) // 1000
                if start <= t < end and r[8] == "1" and _closed(t, now):
                    out.append(MinuteBar(t, r[1], r[2], r[3], r[4], r[5], r[7]))
            oldest = min(int(r[0]) // 1000 for r in data)
            if oldest >= cursor:
                raise VenueError("okx: pagination did not advance")
            cursor = oldest
        return out


class Bybit:
    name, rate_per_s = "bybit", 8.0
    URL = "https://api.bybit.com/v5/market/kline"

    @staticmethod
    def symbol(sym: str) -> str:
        return sym

    def fetch(self, get_json: GetJson, sym: str, start: int, end: int, now: int) -> list[MinuteBar]:
        out, cursor = [], start
        while cursor < end:
            last = min(cursor + 999 * MIN, end - MIN)       # start and end are both inclusive
            q = dict(category="spot", symbol=self.symbol(sym), interval="1", start=cursor * 1000,
                     end=last * 1000, limit=1000)
            resp = get_json(f"{self.URL}?{urlencode(q)}")
            if resp.get("retCode") != 0:
                raise VenueError(f"bybit: {str(resp)[:200]}")
            for r in resp["result"]["list"]:
                t = int(r[0]) // 1000
                if cursor <= t <= last and _closed(t, now):
                    out.append(MinuteBar(t, r[1], r[2], r[3], r[4], r[5], r[6]))
            cursor = last + MIN
        return out


class Bitget:
    name, rate_per_s = "bitget", 8.0
    URL = "https://api.bitget.com/api/v2/spot/market/history-candles"

    @staticmethod
    def symbol(sym: str) -> str:
        return sym

    def fetch(self, get_json: GetJson, sym: str, start: int, end: int, now: int) -> list[MinuteBar]:
        out, cursor = [], end            # endTime is exclusive; returns the 200 bars before it, ascending
        while cursor > start:
            q = dict(symbol=self.symbol(sym), granularity="1min", endTime=cursor * 1000, limit=200)
            resp = get_json(f"{self.URL}?{urlencode(q)}")
            if resp.get("code") != "00000":
                raise VenueError(f"bitget: {str(resp)[:200]}")
            data = resp["data"]
            if not data:
                break
            for r in data:
                t = int(r[0]) // 1000
                if start <= t < end and _closed(t, now):
                    out.append(MinuteBar(t, r[1], r[2], r[3], r[4], r[5], r[7]))
            oldest = min(int(r[0]) // 1000 for r in data)
            if oldest >= cursor:
                raise VenueError("bitget: pagination did not advance")
            cursor = oldest
        return out


class Kucoin:
    name, rate_per_s = "kucoin", 5.0
    URL = "https://api.kucoin.com/api/v1/market/candles"

    @staticmethod
    def symbol(sym: str) -> str:
        return sym[:-4] + "-USDT"

    def fetch(self, get_json: GetJson, sym: str, start: int, end: int, now: int) -> list[MinuteBar]:
        out, cursor = [], start
        while cursor < end:
            stop = min(cursor + 1500 * MIN, end)            # [startAt, endAt), seconds
            q = dict(type="1min", symbol=self.symbol(sym), startAt=cursor, endAt=stop)
            resp = get_json(f"{self.URL}?{urlencode(q)}")
            if resp.get("code") != "200000":
                raise VenueError(f"kucoin: {str(resp)[:200]}")
            for r in resp["data"]:
                t = int(r[0])
                if cursor <= t < stop and _closed(t, now):
                    # KuCoin column order: time, open, close, high, low, volume(base), turnover(quote)
                    out.append(MinuteBar(t, r[1], r[3], r[4], r[2], r[5], r[6]))
            cursor = stop
        return out


ADAPTERS = {a.name: a for a in (Binance(), Okx(), Bybit(), Bitget(), Kucoin())}
