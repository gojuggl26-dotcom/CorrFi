"""Tests for the store-backed grid and the B §2.3 quality measures (synthetic data)."""
from aquacorr_data.build import grid_times, price_points
from aquacorr_data.grid import MISSING, WAD, ZERO_BASE
from aquacorr_data.quality import grid_quality, venue_acquisition
from aquacorr_data.store import MinuteBar, write_month

VENUES = ("binance", "okx", "bybit", "bitget", "kucoin")
T0 = 1_709_251_200            # 2024-03-01 00:00 UTC, a 5-minute boundary
FEB_LAST = T0 - 60            # 2024-02-29 23:59 bar feeds the 2024-03-01 00:00 price point


def bar(t, price, base="1"):
    return MinuteBar(t, price, price, price, price, base, str(int(price) * int(base)))


def test_grid_times_are_aligned_and_half_open():
    assert list(grid_times(T0 + 1, T0 + 901, 300)) == [T0 + 300, T0 + 600, T0 + 900]
    assert list(grid_times(T0, T0 + 900, 300)) == [T0, T0 + 300, T0 + 600]


def test_price_point_uses_previous_month_file_across_boundary(tmp_path):
    for v in VENUES:
        write_month(tmp_path / v / "ETHUSDT" / "2024-02.csv.gz", [bar(FEB_LAST, "3000")])
    pts = list(price_points(tmp_path, "ETHUSDT", VENUES, T0, T0 + 1, 300))
    assert len(pts) == 1 and pts[0].price_wad == 3000 * WAD and pts[0].n_valid_venues == 5


def test_acquisition_and_grid_quality(tmp_path):
    # 10 minutes of data; okx misses minute 3, bybit has zero volume at minute 4
    for v in VENUES:
        rows = []
        for i in range(10):
            if v == "okx" and i == 3:
                continue
            rows.append(bar(T0 + 60 * i, "2000", base="0" if (v == "bybit" and i == 4) else "1"))
        write_month(tmp_path / v / "ETHUSDT" / "2024-03.csv.gz", rows)
    acq = venue_acquisition(tmp_path, "ETHUSDT", VENUES, T0, T0 + 600)
    assert acq["binance"].rate == 1.0
    assert acq["okx"].valid == 9 and acq["okx"].reasons[MISSING] == 1
    assert acq["bybit"].valid == 9 and acq["bybit"].reasons[ZERO_BASE] == 1

    # 1-minute grid over the same data: t = T0 + 60 .. T0 + 600
    q = grid_quality(price_points(tmp_path, "ETHUSDT", VENUES, T0 + 60, T0 + 660, 60))
    assert q.points == 10 and q.valid_rate == 1.0 and not q.jumps_over_half
    assert q.venue_count_hist[4] == 2   # the two minutes where one venue was invalid


def test_vwap_outside_low_high_is_counted(tmp_path):
    # quote/base = 2100 but the bar's range is [2000, 2000] -> anomaly; exact boundary 2000 is fine
    rows = [MinuteBar(T0, "2000", "2000", "2000", "2000", "1", "2100"),
            MinuteBar(T0 + 60, "2000", "2000", "2000", "2000", "3", "6000")]
    for v in VENUES:
        write_month(tmp_path / v / "ETHUSDT" / "2024-03.csv.gz", rows)
    acq = venue_acquisition(tmp_path, "ETHUSDT", VENUES, T0, T0 + 120)
    assert all(a.vwap_outside_range == 1 and a.valid == 2 for a in acq.values())
    assert acq["okx"].by_month["2024-03"]["valid"] == 2


def test_jump_over_half_is_reported(tmp_path):
    for v in VENUES:
        write_month(tmp_path / v / "ETHUSDT" / "2024-03.csv.gz",
                    [bar(T0 + 240, "2000"), bar(T0 + 540, "4000")])
    q = grid_quality(price_points(tmp_path, "ETHUSDT", VENUES, T0 + 300, T0 + 601, 300))
    assert [t for t, _ in q.jumps_over_half] == [T0 + 600]
