"""Scryfall bulk-data ingestion."""
from __future__ import annotations

import logging
import shutil
import threading
from pathlib import Path

import duckdb
import httpx

from . import db
from .config import Settings

log = logging.getLogger(__name__)

BULK_INDEX_URL = "https://api.scryfall.com/bulk-data"
SETS_INDEX_URL = "https://api.scryfall.com/sets"

# Serializes refresh() calls so concurrent invocations (manual + scheduled)
# don't double-download or interleave ingest writes. Module-scoped so it
# spans the whole process; refresh() is short-lived enough that fairness
# / re-entrance aren't concerns.
_REFRESH_LOCK = threading.Lock()


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
        # Cap the bulk download at 1 hour. The default `None` lets a
        # wedged TCP connection stall the refresh forever, blocking
        # subsequent scheduled refreshes.
        with httpx.Client(headers=self._headers, timeout=httpx.Timeout(3600.0, connect=30.0)) as client:
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
            --   (a) the card's NAME is recognized in some standard format
            --       per Scryfall's `legalities` map. We accept ANY status
            --       except 'not_legal' \u2014 'legal', 'restricted', AND
            --       'banned' all signal "this is a real card with a
            --       known format presence." A banned card (e.g. Crusade,
            --       banned in Legacy/Vintage/Commander) is still a
            --       legitimate paper card; it's just currently disallowed,
            --       not a joke / un-set / collectors-only printing. Only
            --       acorn-stamp un-cards and similar oddities get
            --       'not_legal' across every format.
            --   (b) THIS specific printing is on a tournament-acceptable
            --       substrate: not silver/gold border, not 30A reproduction,
            --       not memorabilia set_type, not an acorn-stamped Unfinity
            --       card.
            -- Both halves are needed: (a) alone marks gold-border WC reprints
            -- as legal because the underlying card name is legal in Vintage;
            -- (b) alone marks Embiggen as illegal because Unfinity is
            -- set_type='funny', even though the printing is Vintage-legal.
            ((
                COALESCE(legalities.standard,    'not_legal') != 'not_legal'
             OR COALESCE(legalities.pioneer,     'not_legal') != 'not_legal'
             OR COALESCE(legalities.modern,      'not_legal') != 'not_legal'
             OR COALESCE(legalities.legacy,      'not_legal') != 'not_legal'
             OR COALESCE(legalities.vintage,     'not_legal') != 'not_legal'
             OR COALESCE(legalities.commander,   'not_legal') != 'not_legal'
             OR COALESCE(legalities.pauper,      'not_legal') != 'not_legal'
             OR COALESCE(legalities.duel,        'not_legal') != 'not_legal'
             OR COALESCE(legalities.brawl,       'not_legal') != 'not_legal'
             OR COALESCE(legalities.oathbreaker, 'not_legal') != 'not_legal'
             OR COALESCE(legalities.premodern,   'not_legal') != 'not_legal'
             OR COALESCE(legalities.oldschool,   'not_legal') != 'not_legal'
            )
            AND COALESCE(border_color, '') NOT IN ('silver', 'gold')
            AND COALESCE(set_type, '') != 'memorabilia'
            AND COALESCE(security_stamp, '') != 'acorn'
            AND "set" NOT IN ('30a', '30c')) AS tournament_legal,
            -- Per-format legality bits. A printing is legal in a format iff
            --   (a) the card name has status 'legal' or 'restricted' in
            --       Scryfall's `legalities` map for that format
            --       (banned cards are NOT legal for tournament play, so
            --       they are excluded here), AND
            --   (b) the substrate filter above passes (no silver/gold
            --       border, no memorabilia, no acorn, no 30A).
            -- The substrate clause is repeated rather than factored to a
            -- CTE so DuckDB can keep this as a single-pass projection.
            (COALESCE(legalities.standard, 'not_legal') IN ('legal', 'restricted')
             AND COALESCE(border_color, '') NOT IN ('silver', 'gold')
             AND COALESCE(set_type, '') != 'memorabilia'
             AND COALESCE(security_stamp, '') != 'acorn'
             AND "set" NOT IN ('30a', '30c')) AS legal_standard,
            (COALESCE(legalities.pioneer, 'not_legal') IN ('legal', 'restricted')
             AND COALESCE(border_color, '') NOT IN ('silver', 'gold')
             AND COALESCE(set_type, '') != 'memorabilia'
             AND COALESCE(security_stamp, '') != 'acorn'
             AND "set" NOT IN ('30a', '30c')) AS legal_pioneer,
            (COALESCE(legalities.modern, 'not_legal') IN ('legal', 'restricted')
             AND COALESCE(border_color, '') NOT IN ('silver', 'gold')
             AND COALESCE(set_type, '') != 'memorabilia'
             AND COALESCE(security_stamp, '') != 'acorn'
             AND "set" NOT IN ('30a', '30c')) AS legal_modern,
            (COALESCE(legalities.legacy, 'not_legal') IN ('legal', 'restricted')
             AND COALESCE(border_color, '') NOT IN ('silver', 'gold')
             AND COALESCE(set_type, '') != 'memorabilia'
             AND COALESCE(security_stamp, '') != 'acorn'
             AND "set" NOT IN ('30a', '30c')) AS legal_legacy,
            (COALESCE(legalities.vintage, 'not_legal') IN ('legal', 'restricted')
             AND COALESCE(border_color, '') NOT IN ('silver', 'gold')
             AND COALESCE(set_type, '') != 'memorabilia'
             AND COALESCE(security_stamp, '') != 'acorn'
             AND "set" NOT IN ('30a', '30c')) AS legal_vintage,
            (COALESCE(legalities.commander, 'not_legal') IN ('legal', 'restricted')
             AND COALESCE(border_color, '') NOT IN ('silver', 'gold')
             AND COALESCE(set_type, '') != 'memorabilia'
             AND COALESCE(security_stamp, '') != 'acorn'
             AND "set" NOT IN ('30a', '30c')) AS legal_commander,
            (COALESCE(legalities.pauper, 'not_legal') IN ('legal', 'restricted')
             AND COALESCE(border_color, '') NOT IN ('silver', 'gold')
             AND COALESCE(set_type, '') != 'memorabilia'
             AND COALESCE(security_stamp, '') != 'acorn'
             AND "set" NOT IN ('30a', '30c')) AS legal_pauper,
            -- Oracle-level gameplay fields. Selected per-printing here as
            -- staging columns (prefixed `_`) so the cards_new GROUP BY
            -- below can pluck ANY_VALUE per oracle_id; they are dropped
            -- from the runtime `printings` table after the swap so the
            -- printings shape stays narrow. DFC / split / adventure cards
            -- store gameplay data on `card_faces[]` rather than the top
            -- level — fall back to a face-aware concat so `t:`, `o:`,
            -- `c:`, `mv:` queries still match either face.
            COALESCE(
                type_line,
                array_to_string(
                    list_transform(card_faces, x -> COALESCE(x.type_line, '')),
                    ' // '
                )
            ) AS _type_line,
            COALESCE(
                oracle_text,
                array_to_string(
                    list_transform(card_faces, x -> COALESCE(x.oracle_text, '')),
                    chr(10) || '//' || chr(10)
                )
            ) AS _oracle_text,
            COALESCE(
                mana_cost,
                array_to_string(
                    list_transform(card_faces, x -> COALESCE(x.mana_cost, '')),
                    ' // '
                )
            ) AS _mana_cost,
            TRY_CAST(cmc AS DOUBLE) AS _cmc,
            COALESCE(
                colors,
                card_faces[1].colors,
                []::VARCHAR[]
            ) AS _colors,
            COALESCE(color_identity, []::VARCHAR[]) AS _color_identity,
            COALESCE(power,    card_faces[1].power)    AS _power,
            COALESCE(toughness, card_faces[1].toughness) AS _toughness,
            COALESCE(loyalty,  card_faces[1].loyalty)  AS _loyalty,
            COALESCE(defense,  card_faces[1].defense)  AS _defense,
            rarity,
            COALESCE(keywords, []::VARCHAR[]) AS _keywords,
            COALESCE(produced_mana, []::VARCHAR[]) AS _produced_mana
        FROM read_json_auto(
            '{json_path.as_posix()}',
            format='array',
            maximum_object_size=33554432
        )
        WHERE oracle_id IS NOT NULL
          AND name IS NOT NULL
          -- Exclude non-game pieces. Scryfall's `default_cards` bulk
          -- includes tokens (e.g. a "Tarmogoyf" creature token created
          -- by various cards) and emblems alongside real cards. They
          -- share names with real cards and pollute name-based resolution
          -- ("Tarmogoyf" the deck entry resolves to the token oracle_id
          -- instead of the real creature). Art-series cards and the
          -- "card" set type (which contains tokens/emblems) are also
          -- never legitimate decklist entries.
          AND COALESCE(layout, '') NOT IN (
              'token', 'double_faced_token', 'emblem', 'art_series'
          )
          AND COALESCE(set_type, '') != 'token';
        """
    )

    c.execute(
        """
        CREATE TABLE cards_new AS
        SELECT
            p.oracle_id,
            ANY_VALUE(p.name) AS name,
            ANY_VALUE(p.name_normalized) AS name_normalized,
            ANY_VALUE(p._type_line)      AS type_line,
            ANY_VALUE(p._oracle_text)    AS oracle_text,
            ANY_VALUE(p._mana_cost)      AS mana_cost,
            ANY_VALUE(p._cmc)            AS cmc,
            ANY_VALUE(p._colors)         AS colors,
            ANY_VALUE(p._color_identity) AS color_identity,
            ANY_VALUE(p._power)          AS power,
            ANY_VALUE(p._toughness)      AS toughness,
            ANY_VALUE(p._loyalty)        AS loyalty,
            ANY_VALUE(p._defense)        AS defense,
            ANY_VALUE(p.rarity)          AS rarity,
            ANY_VALUE(p._keywords)       AS keywords,
            ANY_VALUE(p._produced_mana)  AS produced_mana,
            ANY_VALUE(p.layout)          AS layout
        FROM printings_new p
        GROUP BY p.oracle_id;
        """
    )

    # Drop the staging-only oracle columns so the runtime `printings`
    # table keeps its narrow shape (these data live on `cards`).
    for col in (
        "_type_line", "_oracle_text", "_mana_cost", "_cmc", "_colors",
        "_color_identity", "_power", "_toughness", "_loyalty", "_defense",
        "_keywords", "_produced_mana", "rarity",
    ):
        c.execute(f"ALTER TABLE printings_new DROP COLUMN IF EXISTS {col};")

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
    # Serialize concurrent refresh attempts (manual via /api/admin/refresh
    # plus scheduled cron) so we don't double-download or interleave
    # ingest writes.
    with _REFRESH_LOCK:
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
