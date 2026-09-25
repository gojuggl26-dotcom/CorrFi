"""Contract size gate (M §8.2.1 p.40, EIP-170 / EIP-3860): warn above 90% of the limit, fail above the limit.

Usage (from contracts/):
  python script/check_sizes.py               # runs `forge build --sizes --json --skip test --skip script`
  python script/check_sizes.py sizes.json    # checks a saved report (used by the tests of this script)
Exit code: 0 ok / warnings only, 1 a limit is exceeded, 2 the report could not be produced.
The local chain must never raise the limit (R §4.2 p.9, P5 p.18).
"""
import json
import subprocess
import sys

RUNTIME_LIMIT = 24_576
INIT_LIMIT = 49_152
WARN_RATIO = 0.90


def load(argv):
    if len(argv) > 1:
        with open(argv[1], encoding="utf-8") as f:
            return json.load(f)
    proc = subprocess.run(["forge", "build", "--sizes", "--json", "--skip", "test", "--skip", "script"],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode not in (0, 1):   # forge exits 1 itself when a contract exceeds the limit
        print(proc.stderr, file=sys.stderr)
        sys.exit(2)
    return json.loads(proc.stdout)


def check(report: dict) -> int:
    status = 0
    for name, s in sorted(report.items()):
        for kind, size, limit in (("runtime", s["runtime_size"], RUNTIME_LIMIT), ("init", s["init_size"], INIT_LIMIT)):
            ratio = size / limit
            tag = "FAIL" if size > limit else "WARN" if ratio > WARN_RATIO else "ok"
            if tag != "ok" or kind == "runtime":
                print(f"{tag:<4} {name:<40} {kind:<7} {size:>7,} / {limit:,} B ({ratio:.1%})")
            if tag == "FAIL":
                status = 1
    if not report:
        print("ok   (no deployable contracts yet)")
    return status


if __name__ == "__main__":
    sys.exit(check(load(sys.argv)))
