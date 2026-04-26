"""Archidekt public deck importer."""
from __future__ import annotations

import re
from urllib.parse import urlparse

import httpx

from ..registry import register
from ..text import DecklistEntry, ParseResult

_PATH_RE = re.compile(r"/decks/(\d+)")
API_TEMPLATE = "https://archidekt.com/api/decks/{deck_id}/"

# Archidekt category strings (case-insensitive) we treat as sideboard/etc.
_CATEGORY_MAP = {
    "sideboard": "sideboard",
    "commander": "commander",
    "companion": "companion",
    "maybeboard": None,  # ignored
}


class ArchidektImporter:
    name = "archidekt"
    hosts = ("archidekt.com",)

    def fetch(self, url: str) -> ParseResult:
        path = urlparse(url).path
        m = _PATH_RE.search(path)
        if not m:
            raise ValueError(f"Could not extract Archidekt deck id from {url!r}")
        deck_id = m.group(1)

        with httpx.Client(
            timeout=20,
            headers={"User-Agent": "Frameworks/0.1", "Accept": "application/json"},
            follow_redirects=True,
        ) as client:
            r = client.get(API_TEMPLATE.format(deck_id=deck_id))
            r.raise_for_status()
            data = r.json()

        result = ParseResult()
        for card in data.get("cards", []):
            qty = int(card.get("quantity", 0) or 0)
            name = ((card.get("card") or {}).get("oracleCard") or {}).get("name")
            if not name:
                # Older shape
                name = (card.get("card") or {}).get("name")
            if qty <= 0 or not name:
                continue
            categories = card.get("categories") or []
            section = "mainboard"
            skip = False
            for cat in categories:
                mapped = _CATEGORY_MAP.get(cat.lower())
                if mapped is None and cat.lower() in _CATEGORY_MAP:
                    skip = True
                    break
                if mapped is not None:
                    section = mapped
                    break
            if skip:
                continue
            result.entries.append(DecklistEntry(name=name, qty=qty, section=section))
        return result


register(ArchidektImporter())
