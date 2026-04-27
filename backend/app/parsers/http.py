"""Shared HTTP fetch helper for importers.

Many MTG deck sites (Moxfield, Melee) sit behind Cloudflare and reject
requests whose TLS fingerprint or User-Agent doesn't look like a real
browser. We use `curl_cffi` to impersonate Chrome's TLS handshake when
available; otherwise we fall back to plain `httpx` and surface a clear
error if the host blocks us.

Each importer should call `browser_get(url, **opts)` for any host known
to require browser-like behaviour. For simple JSON APIs that don't
filter by fingerprint (Archidekt, CubeCobra, MTGTop8), keep using
`httpx` directly — we don't want to needlessly slow those down.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger(__name__)

try:  # pragma: no cover - exercised in production only
    from curl_cffi import requests as _curl_cffi  # type: ignore
    _HAVE_CURL_CFFI = True
except Exception:  # pragma: no cover
    _curl_cffi = None  # type: ignore
    _HAVE_CURL_CFFI = False


_DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


@dataclass
class FetchResponse:
    status_code: int
    text: str
    headers: dict[str, str]

    def json(self) -> Any:
        import json
        return json.loads(self.text)

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 400


def browser_get(
    url: str,
    *,
    timeout: float = 20.0,
    headers: dict[str, str] | None = None,
    impersonate: str = "chrome124",
) -> FetchResponse:
    """GET a URL, mimicking a real browser when possible.

    Tries curl_cffi (TLS impersonation) first; if not installed, falls
    back to httpx with a browser-ish UA. Either way, follows redirects
    up to 3 hops.
    """
    h = {"User-Agent": _DEFAULT_UA, "Accept": "*/*"}
    if headers:
        h.update(headers)

    if _HAVE_CURL_CFFI and _curl_cffi is not None:
        try:
            r = _curl_cffi.get(
                url,
                headers=h,
                timeout=timeout,
                impersonate=impersonate,
                allow_redirects=True,
            )
            text = r.text if isinstance(r.text, str) else r.text  # type: ignore[truthy-bool]
            return FetchResponse(
                status_code=int(r.status_code),
                text=text,
                headers={k: v for k, v in dict(r.headers).items()},
            )
        except Exception as e:  # pragma: no cover - network only
            log.warning("curl_cffi fetch failed for %s: %s; falling back to httpx", url, e)

    with httpx.Client(
        timeout=timeout,
        headers=h,
        follow_redirects=True,
        max_redirects=3,
    ) as client:
        r = client.get(url)
        return FetchResponse(
            status_code=r.status_code,
            text=r.text,
            headers={k: v for k, v in r.headers.items()},
        )
