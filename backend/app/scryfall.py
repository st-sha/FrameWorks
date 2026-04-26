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
            set_type
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

    db.set_meta("scryfall_updated_at", upstream_updated)
    db.set_meta("scryfall_bulk_type", settings.scryfall_bulk_type)
    db.set_meta("scryfall_download_uri", entry["download_uri"])
    log.info("Scryfall ingest complete (updated_at=%s)", upstream_updated)
    return {"status": "refreshed", "data_version": upstream_updated}
