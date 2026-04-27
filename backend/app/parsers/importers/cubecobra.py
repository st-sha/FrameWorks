"""CubeCobra cube importer.

Accepts URLs like:
  https://cubecobra.com/cube/list/<id>
  https://cubecobra.com/cube/overview/<id>
  https://cubecobra.com/cube/playtest/<id>
  https://cubecobra.com/cube/blog/<id>
  https://cubecobra.com/c/<id>     (short link)

The id can be a UUID or a custom short slug. We hit the documented
plain-text endpoint:

  GET /cube/api/cubelist/<id>  -> newline-separated mainboard card names
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

import httpx

from ..registry import register
from ..text import DecklistEntry, ParseResult

# Accept any /cube/<section>/<id> path or the /c/<id> short link. The id is
# the last non-empty path segment.
_PATH_RE = re.compile(r"/(?:cube/[^/]+|c)/([^/?#]+)")
CUBELIST_TEMPLATE = "https://cubecobra.com/cube/api/cubelist/{cube_id}"


class CubeCobraImporter:
    name = "cubecobra"
    hosts = ("cubecobra.com",)

    def fetch(self, url: str) -> ParseResult:
        path = urlparse(url).path
        m = _PATH_RE.search(path)
        if not m:
            raise ValueError(f"Could not extract CubeCobra cube id from {url!r}")
        cube_id = m.group(1)

        with httpx.Client(
            timeout=30,
            headers={"User-Agent": "Frameworks/0.1"},
            follow_redirects=True,
            max_redirects=3,
        ) as client:
            r = client.get(CUBELIST_TEMPLATE.format(cube_id=cube_id))
            r.raise_for_status()
            text = r.text

        result = ParseResult()
        # Cubes are typically singleton, but the export occasionally
        # contains the same card twice (split across sections, or as a
        # genuine multi-copy slot). Aggregate so a card appearing N
        # times is emitted once with qty=N rather than N entries with
        # qty=1 (which downstream code treats as separate slots).
        from collections import Counter
        counts: Counter[str] = Counter()
        for line in text.splitlines():
            name = line.strip()
            if not name:
                continue
            counts[name] += 1
        for name, qty in counts.items():
            result.entries.append(DecklistEntry(name=name, qty=qty, section="mainboard"))
        return result


register(CubeCobraImporter())
