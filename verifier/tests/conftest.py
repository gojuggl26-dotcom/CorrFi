import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "verifier"))
sys.path.insert(0, str(ROOT / "analysis" / "s00"))   # exact-rational reference from S00 (refmath.py)
