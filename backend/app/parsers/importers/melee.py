"""Melee.gg decklist importer.

Melee has no documented public API; this scrapes the public decklist page
and falls back to text parsing of the embedded plain-text export. If the
page layout changes, raise a clear error so the UI can show a "paste raw
decklist instead" hint.
"""
from __future__ import annotations

import re

from bs4 import BeautifulSoup

from ..http import browser_get
from ..registry import register
from ..text import DecklistEntry, ParseResult, parse_text

# A decklist page uses a guid path under /Decklist/View/<guid>
_DECK_RE = re.compile(r"/Decklist/View/([0-9a-fA-F\-]{36})")


class MeleeImporter:
    name = "melee"
    hosts = ("melee.gg",)

    def fetch(self, url: str) -> ParseResult:
        m = _DECK_RE.search(url)
        if not m:
            raise ValueError(f"Could not extract Melee decklist id from {url!r}")

        # Melee blocks generic UAs / TLS fingerprints with 403; use the
        # browser-impersonating fetcher.
        r = browser_get(
            url,
            headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Upgrade-Insecure-Requests": "1",
            },
        )
        if r.status_code == 403:
            raise RuntimeError(
                "Melee.gg returned 403 Forbidden. The site may be "
                "rate-limiting or blocking server requests \u2014 please "
                "copy the decklist text from the page instead."
            )
        if not r.ok:
            raise RuntimeError(
                f"Melee returned HTTP {r.status_code} for {url!r}"
            )
        html = r.text

        # Strategy 0: Melee embeds the full text export in <pre id="decklist-text">.
        soup0 = BeautifulSoup(html, "lxml")
        pre = soup0.find("pre", id="decklist-text")
        if pre:
            txt = pre.get_text("\n").strip()
            if _looks_like_decklist(txt):
                return parse_text(txt)

        # Strategy 1: any other textarea/pre with decklist-shaped contents.
        soup = BeautifulSoup(html, "lxml")
        candidate_text: str | None = None
        for sel in ("textarea", "pre"):
            for el in soup.find_all(sel):
                txt = el.get_text("\n").strip()
                if _looks_like_decklist(txt):
                    candidate_text = txt
                    break
            if candidate_text:
                break

        if candidate_text:
            return parse_text(candidate_text)

        # Strategy 2: extract from the rendered card tables. Melee groups cards
        # under headings (Mainboard, Sideboard, Commander).
        result = ParseResult()
        current = "mainboard"
        for el in soup.select("h3, h4, table tr"):
            tag = el.name.lower()
            if tag in ("h3", "h4"):
                heading = el.get_text(" ", strip=True).lower()
                if "sideboard" in heading:
                    current = "sideboard"
                elif "commander" in heading:
                    current = "commander"
                elif "companion" in heading:
                    current = "companion"
                else:
                    current = "mainboard"
                continue
            cells = [c.get_text(" ", strip=True) for c in el.find_all("td")]
            if len(cells) < 2:
                continue
            qty_str, name = cells[0], cells[1]
            if not qty_str.isdigit():
                continue
            qty = int(qty_str)
            if qty <= 0 or not name:
                continue
            result.entries.append(
                DecklistEntry(name=name, qty=qty, section=current)  # type: ignore[arg-type]
            )

        if not result.entries:
            raise RuntimeError(
                "Could not parse Melee decklist page. The site layout may have "
                "changed -- please paste the raw decklist text instead."
            )
        return result


def _looks_like_decklist(txt: str) -> bool:
    if not txt or len(txt.splitlines()) < 4:
        return False
    digit_lines = sum(
        1 for ln in txt.splitlines() if ln.strip() and ln.strip()[0].isdigit()
    )
    return digit_lines >= 4


register(MeleeImporter())
