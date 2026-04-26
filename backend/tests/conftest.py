"""Pytest configuration: add backend/ to sys.path so `import app...` works."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
