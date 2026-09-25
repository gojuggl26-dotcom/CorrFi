"""Extract the text of the three spec PDFs (M / R / B) with page markers, for searching and citing.

The PDFs themselves are the only spec source and are not modified. Figures are not extracted.
Output goes to .cache/spec-text/ (git-ignored).

Usage: python tools/extract_pdf_text.py [SPEC_DIR]
       SPEC_DIR defaults to %USERPROFILE%/Downloads
Requires: pypdf
"""
import os
import sys
from pathlib import Path

from pypdf import PdfReader

SPECS = {
    "M": "AquaCorr_MVP_設計書_v0.5.pdf",
    "R": "AquaCorr_7D_リプレイ・デモ設計書_v0.4.pdf",
    "B": "AquaCorr_バックテスト計画書_v0.3.pdf",
}
EXPECTED_PAGES = {"M": 44, "R": 21, "B": 13}


def main() -> int:
    spec_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(os.environ["USERPROFILE"]) / "Downloads"
    out_dir = Path(__file__).resolve().parents[1] / ".cache" / "spec-text"
    out_dir.mkdir(parents=True, exist_ok=True)
    for key, name in SPECS.items():
        reader = PdfReader(spec_dir / name)
        if len(reader.pages) != EXPECTED_PAGES[key]:
            print(f"{key}: expected {EXPECTED_PAGES[key]} pages, got {len(reader.pages)}", file=sys.stderr)
            return 1
        with open(out_dir / f"{key}.txt", "w", encoding="utf-8", newline="\n") as f:
            for i, page in enumerate(reader.pages, 1):
                f.write(f"\n===== {key} PAGE {i} =====\n")
                f.write(page.extract_text() or "")
        print(f"{key}: {len(reader.pages)} pages -> {out_dir / (key + '.txt')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
