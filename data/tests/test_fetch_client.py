import threading
import time

from aquacorr_data.timeutil import iso, utc
from fetch_klines import Client


def test_time_helpers():
    t = utc("2024-03-01")
    assert t == 1_709_251_200
    assert iso(t + 61) == "2024-03-01T00:01:01Z"
    assert iso(t + 61, seconds=False) == "2024-03-01T00:01Z"


def test_backoff_holds_every_thread_of_the_venue(tmp_path):
    # review S03-3: a 429 seen by one symbol thread must also pause the other thread of the same venue
    c = Client("okx", 1000.0, tmp_path / "okx.jsonl")
    c._pace()
    c._hold(0.3)
    waited = []

    def other():
        t0 = time.monotonic()
        c._pace()
        waited.append(time.monotonic() - t0)

    th = threading.Thread(target=other)
    th.start()
    th.join()
    assert waited[0] >= 0.25


def test_retry_after_header():
    assert Client._retry_after({"Retry-After": "7"}) == 7.0
    assert Client._retry_after({"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}) is None
    assert Client._retry_after({}) is None
    assert Client._retry_after(None) is None
