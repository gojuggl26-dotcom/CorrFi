import hashlib

import pytest

from aquacorr_data.store import MinuteBar, month_key, month_path, read_month, write_month


def sample(n=5, start=1_709_251_200):  # 2024-03-01 00:00:00 UTC
    return [MinuteBar(start + 60 * i, "1", "2", "0.5", "1.5", f"{i}.25", f"{i * 3}.125") for i in range(n)]


def test_roundtrip_sorted_and_exact_strings(tmp_path):
    p = month_path(tmp_path, "binance", "ETHUSDT", "2024-03")
    rows = sample()
    assert write_month(p, reversed(rows)) == 5
    assert list(read_month(p)) == rows


def test_month_key_is_utc():
    assert month_key(1_709_251_200) == "2024-03"
    assert month_key(1_709_251_200 - 60) == "2024-02"


def test_deterministic_bytes(tmp_path):
    a, b = tmp_path / "a.csv.gz", tmp_path / "b.csv.gz"
    write_month(a, sample())
    write_month(b, sample())
    assert hashlib.sha256(a.read_bytes()).digest() == hashlib.sha256(b.read_bytes()).digest()


def test_conflicting_duplicates_rejected(tmp_path):
    rows = sample(2)
    clash = MinuteBar(rows[0].open_time, "9", "9", "9", "9", "9", "9")
    with pytest.raises(ValueError):
        write_month(tmp_path / "x.csv.gz", rows + [clash])


def test_identical_duplicates_collapse(tmp_path):
    rows = sample(3)
    assert write_month(tmp_path / "x.csv.gz", rows + rows[:1]) == 3


def test_open_time_must_be_minute_aligned():
    with pytest.raises(ValueError):
        MinuteBar(1_709_251_201, "1", "1", "1", "1", "1", "1")
