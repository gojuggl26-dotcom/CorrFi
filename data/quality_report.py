"""B §2.3 (p.4) data-quality report over the fetched range.

Usage: python data/quality_report.py --start 2024-03-01 --end 2026-09-25 [--store data/store/1m]
Writes data/reports/quality_<start>_<end>.json and prints a Markdown summary.

Grid times: the 5-minute price point at t uses the bar opening at t - 60, so with data starting at `start`
the first computable point is start + 300 (5-minute grid) and the last is `end` (bar end - 60).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aquacorr_data import BAR_SECONDS, SYMBOLS, VENUES  # noqa: E402
from aquacorr_data.build import price_points  # noqa: E402
from aquacorr_data.grid import BAD_QUOTE, MISSING, ZERO_BASE  # noqa: E402
from aquacorr_data.quality import DISPERSION_THRESHOLDS, grid_quality, venue_acquisition  # noqa: E402

REPO = Path(__file__).resolve().parents[1]


def utc(s: str) -> int:
    return int(datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def iso(t: int) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--store", type=Path, default=REPO / "data" / "store" / "1m")
    args = ap.parse_args()
    t0, t1 = utc(args.start), utc(args.end)
    report = {"range": [args.start, args.end], "store": str(args.store), "symbols": {}}
    valid_by_symbol = {}
    for sym in SYMBOLS:
        acq = venue_acquisition(args.store, sym, VENUES, t0, t1)
        pts = list(price_points(args.store, sym, VENUES, t0 + BAR_SECONDS, t1 + 1, BAR_SECONDS))
        q = grid_quality(pts)
        valid_by_symbol[sym] = {p.t: p.valid for p in pts}
        venues = {}
        for v, a in acq.items():
            months = {m: dict(c) for m, c in sorted(a.by_month.items())}
            worst = sorted(months.items(), key=lambda kv: kv[1].get("valid", 0) / max(1, sum(kv[1].values())))[:3]
            venues[v] = {"minutes": a.minutes, "valid": a.valid, "rate": a.rate,
                         "missing": a.reasons[MISSING], "zero_base_volume": a.reasons[ZERO_BASE],
                         "non_positive_quote": a.reasons[BAD_QUOTE], "vwap_outside_low_high": a.vwap_outside_range,
                         "worst_months": worst,
                         "max_dispersion": [q.max_dispersion.get(v, (None, None))[0],
                                            iso(q.max_dispersion[v][1]) if v in q.max_dispersion else None],
                         "dispersion_over": {str(k): q.dispersion_over[v][k] for k in DISPERSION_THRESHOLDS}}
        report["symbols"][sym] = {
            "venues": venues,
            "grid_5m": {"points": q.points, "valid": q.valid, "valid_rate": q.valid_rate,
                        "venue_count_hist": dict(sorted(q.venue_count_hist.items())),
                        "jumps_over_half": [[iso(t), r] for t, r in q.jumps_over_half],
                        "invalid_times": [iso(t) for t in q.invalid_times[:200]],
                        "invalid_count": len(q.invalid_times)}}
    # bar k (return) validity needs both assets at k-1 and k (M §2.5.3)
    times = sorted(valid_by_symbol[SYMBOLS[0]])
    ok = sum(1 for a, b in zip(times, times[1:]) if all(valid_by_symbol[s][a] and valid_by_symbol[s][b]
                                                          for s in SYMBOLS))
    report["returns_5m"] = {"bars": len(times) - 1, "valid": ok, "valid_rate": ok / (len(times) - 1)}

    out = REPO / "data" / "reports" / f"quality_{args.start}_{args.end}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1), encoding="utf-8", newline="\n")

    print(f"# quality {args.start} .. {args.end}  ({out.relative_to(REPO).as_posix()})\n")
    for sym, s in report["symbols"].items():
        g = s["grid_5m"]
        print(f"## {sym}: 5m points {g['points']:,}, valid {g['valid_rate']:.4%} (>= 99.5%), "
              f"|ln|>0.5: {len(g['jumps_over_half'])}, venue counts {g['venue_count_hist']}")
        print("| venue | rate (>=99%) | missing | zero vol | quote<=0 | vwap∉[l,h] | max disp | >10bp | >50bp | >100bp |")
        print("|---|---|---|---|---|---|---|---|---|---|")
        for v, d in s["venues"].items():
            o = d["dispersion_over"]
            md = d["max_dispersion"]
            print(f"| {v} | {d['rate']:.4%} | {d['missing']:,} | {d['zero_base_volume']:,} | {d['non_positive_quote']} "
                  f"| {d['vwap_outside_low_high']} | {md[0]:.2e} @{md[1]} | {o[str(0.001)]:,} | {o[str(0.005)]:,} "
                  f"| {o[str(0.01)]:,} |" if md[0] is not None else f"| {v} | {d['rate']:.4%} | … |")
        print()
    r = report["returns_5m"]
    print(f"returns (both assets valid at k-1 and k): {r['valid']:,}/{r['bars']:,} = {r['valid_rate']:.4%}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
