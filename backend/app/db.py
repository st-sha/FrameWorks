"""DuckDB connection management and helpers."""
from __future__ import annotations

import logging
import threading
import unicodedata
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import duckdb

log = logging.getLogger(__name__)

# Single-process app; DuckDB is single-writer. We serialize writes with this lock
# but allow read queries to share the same connection (DuckDB is thread-safe for
# concurrent reads on a single connection as of 1.0+).
_lock = threading.RLock()
_conn: duckdb.DuckDBPyConnection | None = None
_db_path: Path | None = None


def init(db_path: Path) -> duckdb.DuckDBPyConnection:
    """Open (or reopen) the DuckDB database and ensure base schema exists."""
    global _conn, _db_path
    with _lock:
        if _conn is not None:
            _conn.close()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        _conn = duckdb.connect(str(db_path))
        _db_path = db_path
        _ensure_schema(_conn)
        log.info("DuckDB opened at %s", db_path)
        return _conn


def conn() -> duckdb.DuckDBPyConnection:
    if _conn is None:
        raise RuntimeError("DB not initialized. Call db.init() first.")
    return _conn


@contextmanager
def write_lock() -> Iterator[duckdb.DuckDBPyConnection]:
    """Serialize writers."""
    with _lock:
        yield conn()


@contextmanager
def read_lock() -> Iterator[duckdb.DuckDBPyConnection]:
    """Serialize reads against the shared connection.

    DuckDB's Python connection is not thread-safe — concurrent reads from
    FastAPI's threadpool plus the APScheduler refresh job would
    intermittently raise "No open result set" because cursors share state.
    Holding the same RLock as writes keeps every interaction on the
    connection serialized. Cheap enough for this single-user app.
    """
    with _lock:
        yield conn()


def _ensure_schema(c: duckdb.DuckDBPyConnection) -> None:
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS meta (
            key VARCHAR PRIMARY KEY,
            value VARCHAR
        );
        """
    )
    # printings + cards are created/replaced atomically during ingestion.
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS printings (
            oracle_id VARCHAR,
            name VARCHAR,
            name_normalized VARCHAR,
            "set" VARCHAR,
            set_name VARCHAR,
            collector_number VARCHAR,
            released_at DATE,
            frame VARCHAR,
            frame_effects VARCHAR[],
            border_color VARCHAR,
            full_art BOOLEAN,
            textless BOOLEAN,
            promo BOOLEAN,
            promo_types VARCHAR[],
            digital BOOLEAN,
            lang VARCHAR,
            layout VARCHAR,
            image_normal VARCHAR,
            image_art_crop VARCHAR,
            price_usd DOUBLE,
            nonfoil BOOLEAN,
            foil BOOLEAN,
            security_stamp VARCHAR,
            set_type VARCHAR,
            tournament_legal BOOLEAN
        );
        """
    )
    # Per-format legality columns. Added in a later schema rev; if the
    # printings table already exists from before, ALTER it to add the
    # missing columns. Defaults to TRUE so an un-refreshed DB doesn't
    # silently drop every printing when the user picks a format — they
    # just see no filtering until the next Scryfall refresh repopulates
    # the column with real values.
    _ensure_format_columns(c)
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS cards (
            oracle_id VARCHAR PRIMARY KEY,
            name VARCHAR,
            name_normalized VARCHAR
        );
        """
    )
    # Oracle-level gameplay columns (added in a later schema rev to support
    # Scryfall-syntax filtering on the frontend). Populated by the
    # Scryfall ingest; NULL until the next refresh runs.
    _ensure_oracle_columns(c)
    c.execute("CREATE INDEX IF NOT EXISTS idx_printings_oracle ON printings(oracle_id);")
    c.execute(
        "CREATE INDEX IF NOT EXISTS idx_cards_name_norm ON cards(name_normalized);"
    )


# Per-format legality columns. Order matches what the ingest SQL emits.
FORMAT_COLUMNS: tuple[str, ...] = (
    "legal_standard",
    "legal_pioneer",
    "legal_modern",
    "legal_legacy",
    "legal_vintage",
    "legal_commander",
    "legal_pauper",
)


def _ensure_format_columns(c: duckdb.DuckDBPyConnection) -> None:
    existing = {
        row[0]
        for row in c.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'printings'"
        ).fetchall()
    }
    for col in FORMAT_COLUMNS:
        if col not in existing:
            c.execute(f"ALTER TABLE printings ADD COLUMN {col} BOOLEAN DEFAULT TRUE;")


# Oracle-level gameplay columns added to `cards` so the frontend
# Scryfall-syntax evaluator can match `t:`, `o:`, `c:`, `mv:`, `pow:`, etc.
# All nullable so an un-refreshed DB still works (predicates that reference
# missing data will simply not match).
ORACLE_COLUMNS: tuple[tuple[str, str], ...] = (
    ("type_line", "VARCHAR"),
    ("oracle_text", "VARCHAR"),
    ("mana_cost", "VARCHAR"),
    ("cmc", "DOUBLE"),
    ("colors", "VARCHAR[]"),
    ("color_identity", "VARCHAR[]"),
    ("power", "VARCHAR"),
    ("toughness", "VARCHAR"),
    ("loyalty", "VARCHAR"),
    ("defense", "VARCHAR"),
    ("rarity", "VARCHAR"),
    ("keywords", "VARCHAR[]"),
    ("produced_mana", "VARCHAR[]"),
    ("layout", "VARCHAR"),
)


def _ensure_oracle_columns(c: duckdb.DuckDBPyConnection) -> None:
    existing = {
        row[0]
        for row in c.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'cards'"
        ).fetchall()
    }
    for col, ty in ORACLE_COLUMNS:
        if col not in existing:
            c.execute(f"ALTER TABLE cards ADD COLUMN {col} {ty};")


def normalize_name(name: str) -> str:
    """Normalize card name for fuzzy lookup.

    - lowercase
    - strip diacritics (Lim-Dûl -> lim-dul)
    - collapse whitespace
    - normalize split-card delimiter to ' // '
    """
    if not name:
        return ""
    nfkd = unicodedata.normalize("NFKD", name)
    stripped = "".join(ch for ch in nfkd if not unicodedata.combining(ch))
    s = stripped.lower().strip()
    s = s.replace("\u2019", "'").replace("`", "'")
    s = " ".join(s.split())
    # split cards and adventures use ' // '; normalize separator variants
    for sep in (" / ", "/", " // "):
        if sep in s and " // " not in s:
            s = s.replace(sep, " // ")
            break
    return s


def get_meta(key: str) -> str | None:
    # Wrap in the shared lock — DuckDB connections aren't thread-safe and
    # concurrent reads from FastAPI's threadpool + the APScheduler refresh
    # job would intermittently raise "No open result set" otherwise.
    with _lock:
        row = conn().execute("SELECT value FROM meta WHERE key = ?", [key]).fetchone()
    return row[0] if row else None


def set_meta(key: str, value: str) -> None:
    with write_lock() as c:
        c.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [key, value],
        )
