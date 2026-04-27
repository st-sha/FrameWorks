"""MTGTop8 public deck importer.

mtgtop8 deck pages have URLs like
    https://mtgtop8.com/event?e=12345&d=67890
where the deck id is the `d` query parameter. The site exposes a plain-text
MTGO export at /mtgo?d=ID — that's what we fetch and feed through the
existing text parser (it understands `SB: ` sideboard prefixes natively).
"""
from __future__ import annotations

import re
from urllib.parse import urlparse, parse_qs

import httpx

from ..registry import register
from ..text import parse_text, ParseResult

EXPORT_TEMPLATE = "https://mtgtop8.com/mtgo?d={deck_id}"


def _extract_deck_id(url: str) -> str | None:
    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    for key in ("d", "deck"):
        vals = qs.get(key)
        if vals and vals[0]:
            return re.sub(r"[^A-Za-z0-9]", "", vals[0]) or None
    return None


class MtgTop8Importer:
    name = "mtgtop8"
    hosts = ("mtgtop8.com",)

    def fetch(self, url: str) -> ParseResult:
        deck_id = _extract_deck_id(url)
        if not deck_id:
            raise ValueError(f"Could not extract MTGTop8 deck id from {url!r}")

        with httpx.Client(
            timeout=20,
            headers={
                # mtgtop8 returns 406 if the User-Agent looks like a bot or
                # the Accept header is too narrow, so present as a normal
                # browser and accept anything.
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0 Safari/537.36 DeckAesthetics/0.1"
                ),
                "Accept": "*/*",
            },
            follow_redirects=True,
            max_redirects=3,
        ) as client:
            r = client.get(EXPORT_TEMPLATE.format(deck_id=deck_id))
            r.raise_for_status()
            text = r.text

        if not text.strip():
            raise ValueError(f"MTGTop8 returned an empty export for deck {deck_id}")
        return parse_text(text)


register(MtgTop8Importer())
