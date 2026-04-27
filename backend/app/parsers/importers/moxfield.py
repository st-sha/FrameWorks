"""Moxfield public deck importer."""
from __future__ import annotations

import re
from urllib.parse import urlparse

from ..http import browser_get
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

        # Moxfield's api is fronted by Cloudflare and blocks plain Python
        # HTTP clients with a 403 challenge page. browser_get() uses
        # curl_cffi's TLS impersonation when available so the request
        # looks like Chrome at the TLS layer too.
        r = browser_get(
            API_TEMPLATE.format(public_id=public_id),
            headers={
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
                "Origin": "https://www.moxfield.com",
                "Referer": "https://www.moxfield.com/",
            },
        )
        if r.status_code == 404:
            raise ValueError(
                f"Moxfield deck {public_id!r} not found. The deck may be "
                "private or deleted."
            )
        if r.status_code in (401, 403):
            raise RuntimeError(
                f"Moxfield returned {r.status_code} for deck {public_id!r}. "
                "Cloudflare is blocking the request \u2014 try installing "
                "`curl_cffi` for TLS impersonation, or paste the decklist "
                "text instead."
            )
        if not r.ok:
            raise RuntimeError(
                f"Moxfield returned HTTP {r.status_code} for deck {public_id!r}"
            )
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
