"""Contract size gate (M §8.2.1 p.40, EIP-170 / EIP-3860): warn above 90% of the limit, fail above the limit.

Usage (from contracts/):
  python script/check_sizes.py               # runs `forge build --sizes --json --skip test --skip script`
  python script/check_sizes.py sizes.json    # checks a saved report (used by the tests of this script)
Exit code: 0 ok / warnings only, 1 a limit is exceeded, 2 the report could not be produced.
The local chain must never raise the limit (R §4.2 p.9, P5 p.18).
"""
import glob
import json
import os
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
    report = json.loads(proc.stdout)
    add_linked_libraries(report)
    return report


def add_linked_libraries(report: dict) -> None:
    """`forge build --sizes` leaves out some deployable libraries (e.g. ones with only external functions).
    The router's linked libraries (DEC-12) are deployed on their own, so measure every src/ artifact with code."""
    arts = {}
    linked = set()
    for path in glob.glob(os.path.join("out", "*.sol", "*.json")):
        with open(path, encoding="utf-8") as f:
            art = json.load(f)
        meta = art.get("metadata")
        target = meta.get("settings", {}).get("compilationTarget", {}) if isinstance(meta, dict) else {}
        src = next(iter(target), "")
        if not src.startswith("src/") or not os.path.exists(src):   # skip stale artifacts of deleted sources
            continue
        arts[os.path.splitext(os.path.basename(path))[0]] = art
        for libs in art.get("bytecode", {}).get("linkReferences", {}).values():
            linked.update(libs)
    for name in sorted(linked - set(report)):
        art = arts.get(name)
        if art is None:
            continue
        runtime = art["deployedBytecode"]["object"]
        init = art["bytecode"]["object"]
        report[name] = {"runtime_size": (len(runtime) - 2) // 2, "init_size": (len(init) - 2) // 2}


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
