"""Moxfield public deck importer."""
from __future__ import annotations

import re
from urllib.parse import urlparse

import httpx

from ..registry import register
from ..text import DecklistEntry, ParseResult

# Public IDs are alphanumeric, ~10 chars
_PATH_RE = re.compile(r"/decks/([A-Za-z0-9_-]+)")
API_TEMPLATE = "https://api2.moxfield.com/v3/decks/all/{public_id}"

# Moxfield board names -> our sections
_BOARD_MAP = {
    "mainboard": "mainboard",
    "sideboard": "sideboard",
    "commanders": "commander",
    "companions": "companion",
    "maybeboard": None,  # ignored
    "tokens": None,
}


class MoxfieldImporter:
    name = "moxfield"
    hosts = ("moxfield.com",)

    def fetch(self, url: str) -> ParseResult:
        path = urlparse(url).path
        m = _PATH_RE.search(path)
        if not m:
            raise ValueError(f"Could not extract Moxfield deck id from {url!r}")
        public_id = m.group(1)

        with httpx.Client(
            timeout=20,
            headers={"User-Agent": "Frameworks/0.1", "Accept": "application/json"},
            follow_redirects=True,
        ) as client:
            r = client.get(API_TEMPLATE.format(public_id=public_id))
            r.raise_for_status()
            data = r.json()

        result = ParseResult()
        boards = data.get("boards") or {}
        for board_name, section in _BOARD_MAP.items():
            if section is None:
                continue
            board = boards.get(board_name) or {}
            cards = board.get("cards") or {}
            for entry in cards.values():
                qty = int(entry.get("quantity", 0) or 0)
                card = entry.get("card") or {}
                name = card.get("name") or ""
                if qty <= 0 or not name:
                    continue
                result.entries.append(
                    DecklistEntry(name=name, qty=qty, section=section)
                )
        return result


register(MoxfieldImporter())
