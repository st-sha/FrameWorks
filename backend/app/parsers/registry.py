"""URL importer registry."""
from __future__ import annotations

import logging
from typing import Protocol
from urllib.parse import urlparse

from .text import ParseResult

log = logging.getLogger(__name__)


class Importer(Protocol):
    name: str
    hosts: tuple[str, ...]

    def fetch(self, url: str) -> ParseResult: ...


_REGISTRY: list[Importer] = []


def register(importer: Importer) -> Importer:
    # Normalize host suffixes once so URL matching (which lowercases
    # the request host) doesn't accidentally fail on importers that
    # registered with mixed-case hosts.
    try:
        importer.hosts = tuple(h.lower() for h in importer.hosts)  # type: ignore[misc]
    except (AttributeError, TypeError):
        pass
    _REGISTRY.append(importer)
    return importer


def list_importers() -> list[dict]:
    return [{"name": i.name, "hosts": list(i.hosts)} for i in _REGISTRY]


def import_from_url(url: str) -> ParseResult:
    host = (urlparse(url).hostname or "").lower()
    if not host:
        raise ValueError(f"Could not parse URL: {url!r}")
    # exact or suffix match
    for imp in _REGISTRY:
        for h in imp.hosts:
            if host == h or host.endswith("." + h):
                log.info("Importing decklist from %s via %s", url, imp.name)
                return imp.fetch(url)
    raise ValueError(f"No importer registered for host {host!r}")


# Register built-in importers (import for side effect).
from . import importers  # noqa: E402,F401
