"""Run every S00 check and store its stdout under analysis/s00/results/. Exits non-zero if any check fails.

Run: python analysis/s00/run_all.py   (Python 3.13 standard library only)
"""
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHECKS = ["chk_appendix_a.py", "chk_split_hu.py", "chk_sigma_bar_batch.py", "chk_endpoint.py",
          "chk_doc_arithmetic.py"]


def main() -> int:
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    failed = []
    for name in CHECKS:
        proc = subprocess.run([sys.executable, name], cwd=HERE, capture_output=True, text=True,
                              encoding="utf-8", env=env)
        (out / name.replace(".py", ".txt")).write_text(proc.stdout + proc.stderr, encoding="utf-8",
                                                       newline="\n")
        status = "PASS" if proc.returncode == 0 else f"FAIL ({proc.returncode})"
        print(f"{status:<10} {name}")
        if proc.returncode != 0:
            failed.append(name)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
