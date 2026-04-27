"""Smoke-test each importer against a known-good public URL.

Run from repo root:  .venv\\Scripts\\python.exe scripts\\smoke_importers.py
"""
from __future__ import annotations

import sys
import traceback
from pathlib import Path

# Allow running from repo root without installing the package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app.parsers import import_from_url  # noqa: E402

SAMPLES = [
    # (label, url, expected_min_entries)
    ("moxfield", "https://www.moxfield.com/decks/Nk4y30XRX0yTpfM6irsBIA", 50),
    ("archidekt", "https://archidekt.com/decks/4135828/precon_quick_draw", 50),
    ("cubecobra", "https://cubecobra.com/cube/list/oldmancube", 200),
    ("mtgtop8", "https://mtgtop8.com/event?e=64421&d=585320", 20),
    # Melee deck IDs change frequently; populate manually before running.
    # ("melee", "https://melee.gg/Decklist/View/<guid>", 30),
]


def main() -> int:
    fails = 0
    for label, url, expected in SAMPLES:
        print(f"\n=== {label}: {url} ===")
        try:
            result = import_from_url(url)
        except Exception as e:
            print(f"  FAIL: {type(e).__name__}: {e}")
            traceback.print_exc()
            fails += 1
            continue
        n = len(result.entries)
        total_qty = sum(e.qty for e in result.entries)
        sections = {e.section for e in result.entries}
        sample = ", ".join(f"{e.qty} {e.name}" for e in result.entries[:3])
        print(f"  OK: {n} entries, {total_qty} cards, sections={sorted(sections)}")
        print(f"  sample: {sample}")
        if n < expected:
            print(f"  WARN: only {n} entries, expected >= {expected}")
            fails += 1
        if result.warnings:
            print(f"  warnings: {result.warnings[:5]}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
