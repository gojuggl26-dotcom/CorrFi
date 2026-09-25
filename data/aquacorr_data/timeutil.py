"""UTC date / time helpers shared by the data scripts (review S03-15: they used to be defined in each script)."""
from __future__ import annotations

from datetime import datetime, timezone


def utc(day: str) -> int:
    """'YYYY-MM-DD' (UTC midnight) -> Unix seconds."""
    return int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def iso(t: int, *, seconds: bool = True) -> str:
    """Unix seconds -> 'YYYY-MM-DDTHH:MM:SSZ' (or 'YYYY-MM-DDTHH:MMZ' with seconds=False, for grid times)."""
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ" if seconds else "%Y-%m-%dT%H:%MZ")
