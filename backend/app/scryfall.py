"""Scryfall bulk-data ingestion."""
from __future__ import annotations

import logging
import shutil
from pathlib import Path

import duckdb
import httpx

from . import db
from .config import Settings

log = logging.getLogger(__name__)

BULK_INDEX_URL = "https://api.scryfall.com/bulk-data"
SETS_INDEX_URL = "https://api.scryfall.com/sets"


class ScryfallClient:
    def __init__(self, user_agent: str, bulk_type: str):
        self.user_agent = user_agent
        self.bulk_type = bulk_type
        self._headers = {
            "User-Agent": user_agent,
            "Accept": "application/json",
        }

    def get_bulk_entry(self) -> dict:
        with httpx.Client(headers=self._headers, timeout=30) as client:
            r = client.get(BULK_INDEX_URL)
            r.raise_for_status()
            data = r.json()
        for entry in data.get("data", []):
            if entry.get("type") == self.bulk_type:
                return entry
        raise RuntimeError(f"Scryfall bulk type {self.bulk_type!r} not found in index")

    def get_sets(self) -> list[dict]:
        """Fetch the full /sets index. Used to populate set_code->icon_svg_uri
        so the UI can render the proper symbol for sets whose code differs
        from their svg filename (e.g. h2r -> mh2.svg)."""
        with httpx.Client(headers=self._headers, timeout=30) as client:
            r = client.get(SETS_INDEX_URL)
            r.raise_for_status()
            data = r.json()
        return data.get("data", []) or []

    def download(self, url: str, dest: Path) -> None:
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        with httpx.Client(headers=self._headers, timeout=None) as client:
            with client.stream("GET", url) as r:
                r.raise_for_status()
                with tmp.open("wb") as f:
                    for chunk in r.iter_bytes(chunk_size=1024 * 256):
                        f.write(chunk)
        shutil.move(str(tmp), str(dest))


def _ingest_into_temp(c: duckdb.DuckDBPyConnection, json_path: Path) -> None:
    """Load Scryfall bulk JSON into staging tables.

    Scryfall fields used (all optional in source -> SQL NULL on absence):
      object, id, oracle_id, name, set, set_name, collector_number, released_at,
      frame, frame_effects (list), border_color, full_art, textless, promo,
      promo_types (list), digital, lang, layout, image_uris (struct).
    """
    c.execute("DROP TABLE IF EXISTS printings_new;")
    c.execute("DROP TABLE IF EXISTS cards_new;")

    # `read_json_auto` infers schema; force `format='array'` because Scryfall bulk
    # is a single big JSON array.
    c.execute(
        f"""
        CREATE TABLE printings_new AS
        SELECT
            oracle_id,
            name,
            lower(strip_accents(trim(regexp_replace(name, '\\s+', ' ', 'g')))) AS name_normalized,
            "set",
            set_name,
            collector_number,
            TRY_CAST(released_at AS DATE) AS released_at,
            frame,
            COALESCE(frame_effects, []::VARCHAR[]) AS frame_effects,
            border_color,
            COALESCE(full_art, false) AS full_art,
            COALESCE(textless, false) AS textless,
            COALESCE(promo, false) AS promo,
            COALESCE(promo_types, []::VARCHAR[]) AS promo_types,
            COALESCE(digital, false) AS digital,
            lang,
            layout,
            TRY_CAST(
                COALESCE(image_uris.normal,
                         card_faces[1].image_uris.normal)
                AS VARCHAR
            ) AS image_normal,
            TRY_CAST(
                COALESCE(image_uris.art_crop,
                         card_faces[1].image_uris.art_crop)
                AS VARCHAR
            ) AS image_art_crop,
            TRY_CAST(prices.usd AS DOUBLE) AS price_usd,
            COALESCE(nonfoil, false) AS nonfoil,
            COALESCE(foil, false) AS foil,
            security_stamp,
            set_type,
            -- A printing is tournament-legal iff BOTH:
            --   (a) the card's NAME is legal/restricted in some standard
            --       format per Scryfall's `legalities` map (oracle-level
            --       — every reprint of Lightning Bolt qualifies even from
            --       gold-border WC sets), AND
            --   (b) THIS specific printing is on a tournament-acceptable
            --       substrate: not silver/gold border, not 30A reproduction,
            --       not memorabilia set_type, not an acorn-stamped Unfinity
            --       card.
            -- Both halves are needed: (a) alone marks gold-border WC reprints
            -- as legal because the underlying card name is legal in Vintage;
            -- (b) alone marks Embiggen as illegal because Unfinity is
            -- set_type='funny', even though the printing is Vintage-legal.
            ((
                legalities.standard  IN ('legal','restricted')
             OR legalities.pioneer   IN ('legal','restricted')
             OR legalities.modern    IN ('legal','restricted')
             OR legalities.legacy    IN ('legal','restricted')
             OR legalities.vintage   IN ('legal','restricted')
             OR legalities.commander IN ('legal','restricted')
             OR legalities.pauper    IN ('legal','restricted')
             OR legalities.duel      IN ('legal','restricted')
             OR legalities.brawl     IN ('legal','restricted')
             OR legalities.oathbreaker IN ('legal','restricted')
            )
            AND COALESCE(border_color, '') NOT IN ('silver', 'gold')
            AND COALESCE(set_type, '') != 'memorabilia'
            AND COALESCE(security_stamp, '') != 'acorn'
            AND "set" NOT IN ('30a', '30c')) AS tournament_legal
        FROM read_json_auto(
            '{json_path.as_posix()}',
            format='array',
            maximum_object_size=33554432
        )
        WHERE oracle_id IS NOT NULL
          AND name IS NOT NULL;
        """
    )

    c.execute(
        """
        CREATE TABLE cards_new AS
        SELECT
            oracle_id,
            ANY_VALUE(name) AS name,
            ANY_VALUE(name_normalized) AS name_normalized
        FROM printings_new
        GROUP BY oracle_id;
        """
    )

    # Atomic-ish swap (DuckDB DDL inside a transaction).
    c.execute("BEGIN TRANSACTION;")
    try:
        c.execute("DROP TABLE IF EXISTS printings;")
        c.execute("DROP TABLE IF EXISTS cards;")
        c.execute("ALTER TABLE printings_new RENAME TO printings;")
        c.execute("ALTER TABLE cards_new RENAME TO cards;")
        c.execute("CREATE INDEX idx_printings_oracle ON printings(oracle_id);")
        c.execute("CREATE INDEX idx_cards_name_norm ON cards(name_normalized);")
        c.execute("COMMIT;")
    except Exception:
        c.execute("ROLLBACK;")
        raise


def refresh(settings: Settings, force: bool = False) -> dict:
    """Check upstream, download if changed, ingest. Returns a status dict."""
    client = ScryfallClient(settings.user_agent, settings.scryfall_bulk_type)
    entry = client.get_bulk_entry()
    upstream_updated = entry["updated_at"]
    current = db.get_meta("scryfall_updated_at")

    if not force and current == upstream_updated:
        log.info("Scryfall data up-to-date (updated_at=%s)", upstream_updated)
        return {"status": "skipped", "data_version": current}

    log.info(
        "Refreshing Scryfall bulk %s (current=%s upstream=%s)",
        settings.scryfall_bulk_type,
        current,
        upstream_updated,
    )
    cache = settings.bulk_cache_path
    cache.parent.mkdir(parents=True, exist_ok=True)
    client.download(entry["download_uri"], cache)

    with db.write_lock() as c:
        _ingest_into_temp(c, cache)
        # Also fetch + ingest the /sets index so the UI can resolve each
        # printing's set code to the correct Scryfall icon SVG (some sets
        # like h2r reuse mh2's icon, etc.).
        try:
            sets_data = client.get_sets()
            _ingest_sets(c, sets_data)
        except Exception as e:  # pragma: no cover
            log.warning("Failed to refresh /sets index: %s", e)

    db.set_meta("scryfall_updated_at", upstream_updated)
    db.set_meta("scryfall_bulk_type", settings.scryfall_bulk_type)
    db.set_meta("scryfall_download_uri", entry["download_uri"])
    log.info("Scryfall ingest complete (updated_at=%s)", upstream_updated)
    return {"status": "refreshed", "data_version": upstream_updated}


def _ingest_sets(c: duckdb.DuckDBPyConnection, sets: list[dict]) -> None:
    """Replace the `sets` table with `(code, name, icon_svg_uri)` rows."""
    c.execute("DROP TABLE IF EXISTS sets;")
    c.execute(
        """
        CREATE TABLE sets (
            code VARCHAR PRIMARY KEY,
            name VARCHAR,
            icon_svg_uri VARCHAR
        );
        """
    )
    rows = [
        (s.get("code"), s.get("name"), s.get("icon_svg_uri"))
        for s in sets
        if s.get("code")
    ]
    if rows:
        c.executemany(
            "INSERT INTO sets (code, name, icon_svg_uri) VALUES (?, ?, ?);",
            rows,
        )
