"""Decklist analysis: which aesthetics is each card available in?"""
from __future__ import annotations

import hashlib
import logging
import threading
from collections import OrderedDict, defaultdict
from functools import lru_cache
from typing import Iterable

from . import db
from .parsers.text import DecklistEntry
from .rulesets import Aesthetic

log = logging.getLogger(__name__)

# Sort key for "basic" detection (exclude by default).
BASIC_LANDS = {
    "plains", "island", "swamp", "mountain", "forest",
    "snow-covered plains", "snow-covered island", "snow-covered swamp",
    "snow-covered mountain", "snow-covered forest", "wastes",
}

# Set codes / set_type values that mark a printing as "not legal in any
# standard tournament paper format." Used as a fallback when the per-
# printing `tournament_legal` column from Scryfall's `legalities` map
# isn't available (e.g. a fresh DB before refresh, or older bulk data).
_NON_TOURNAMENT_BORDERS = {"silver", "gold"}
_NON_TOURNAMENT_SET_TYPES = {"funny", "memorabilia"}
_NON_TOURNAMENT_SETS = {"30a", "30c"}


def _is_tournament_legal(p: dict) -> bool:
    """Return True iff the printing is legal in some standard paper format.

    Authoritative source is Scryfall's per-printing `legalities` struct,
    which we cache as a `tournament_legal` BOOLEAN at ingest. That field
    correctly handles awkward cases like:
      - Embiggen reprints in The List (legal) vs the original silver-
        border Unstable printing (not legal).
      - Black-border Heroes / Tales reprints in eternal-legal supplemental
        sets even though their parent set_type is 'memorabilia'.
      - Acorn-stamped Unfinity cards (not legal) sitting alongside the
        non-acorn ones from the same set (legal).

    Falls back to a coarse heuristic only when the column is missing."""
    val = p.get("tournament_legal")
    if val is not None:
        return bool(val)
    # Heuristic fallback (pre-refresh / very old DB).
    if p.get("border_color") in _NON_TOURNAMENT_BORDERS:
        return False
    if p.get("set_type") in _NON_TOURNAMENT_SET_TYPES:
        return False
    if p.get("set") in _NON_TOURNAMENT_SETS:
        return False
    return True


def _resolve_names(entries: list[DecklistEntry]) -> tuple[dict[str, str], list[str]]:
    """Map normalized name -> oracle_id. Returns (resolved, unresolved_names).

    Excludes non-game printings (tokens, emblems, art-series) so that a
    decklist entry like "Tarmogoyf" never resolves to the Tarmogoyf
    *token* oracle_id (which Scryfall's `default_cards` bulk includes
    alongside the real creature). Filtering on `printings.layout` rather
    than `cards.layout` works on un-refreshed DBs from before the oracle
    columns were added.
    """
    if not entries:
        return {}, []
    names_norm = sorted({db.normalize_name(e.name) for e in entries if e.name})
    placeholders = ", ".join(["?"] * len(names_norm))
    with db.read_lock() as c:
        rows = c.execute(
            f"""
            SELECT DISTINCT c.name_normalized, c.oracle_id
            FROM cards c
            WHERE c.name_normalized IN ({placeholders})
              AND EXISTS (
                  SELECT 1 FROM printings p
                  WHERE p.oracle_id = c.oracle_id
                    AND COALESCE(p.layout, '') NOT IN (
                        'token', 'double_faced_token', 'emblem', 'art_series'
                    )
                    AND COALESCE(p.set_type, '') != 'token'
              )
            """,
            names_norm,
        ).fetchall()
    resolved = {row[0]: row[1] for row in rows}

    # Try fallback: split-card names where user typed only the front face.
    missing = [n for n in names_norm if n not in resolved]
    if missing:
        with db.read_lock() as c:
            for nm in list(missing):
                # Escape LIKE wildcards in card names; otherwise an entry
                # like `Smelt_` or `Mind%Bend` would match unintended rows.
                esc = nm.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                row = c.execute(
                    """
                    SELECT c.oracle_id FROM cards c
                    WHERE c.name_normalized LIKE ? ESCAPE '\\'
                      AND EXISTS (
                          SELECT 1 FROM printings p
                          WHERE p.oracle_id = c.oracle_id
                            AND COALESCE(p.layout, '') NOT IN (
                                'token', 'double_faced_token', 'emblem', 'art_series'
                            )
                            AND COALESCE(p.set_type, '') != 'token'
                      )
                    LIMIT 1
                    """,
                    [f"{esc} // %"],
                ).fetchone()
                if row:
                    resolved[nm] = row[0]
                    missing.remove(nm)

    return resolved, missing


# Oracle-level gameplay fields surfaced on PerCardRow so the frontend
# Scryfall-syntax filter can match `t:`, `o:`, `c:`, `mv:`, `pow:`, etc.
# Order matches the SELECT in `_fetch_oracle_data` exactly.
_ORACLE_FIELDS: tuple[str, ...] = (
    "type_line", "oracle_text", "mana_cost", "cmc",
    "colors", "color_identity",
    "power", "toughness", "loyalty", "defense",
    "rarity", "keywords", "produced_mana", "layout",
)


def _fetch_oracle_data(oracle_ids: list[str]) -> dict[str, dict]:
    """Bulk-fetch oracle-level gameplay fields for a set of oracle_ids.

    Returns `{oracle_id: {field: value, ...}}`. Missing oracles or NULL
    columns are silently omitted; the frontend evaluator treats absence
    as "predicate doesn't match" rather than erroring.

    The set of columns SELECTed is intersected with the live `cards`
    table schema so an un-migrated DB (older bulk data, or a unit-test
    fixture that constructs `cards` by hand) still works — predicates
    that need the missing columns simply won't match.
    """
    if not oracle_ids:
        return {}
    with db.read_lock() as c:
        existing = {
            row[0]
            for row in c.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'cards'"
            ).fetchall()
        }
        present = [f for f in _ORACLE_FIELDS if f in existing]
        if not present:
            return {}
        placeholders = ", ".join(["?"] * len(oracle_ids))
        cols = ", ".join(present)
        rows = c.execute(
            f"SELECT oracle_id, {cols} FROM cards WHERE oracle_id IN ({placeholders})",
            list(oracle_ids),
        ).fetchall()
    out: dict[str, dict] = {}
    for row in rows:
        oid = row[0]
        d: dict = {}
        for i, name in enumerate(present, start=1):
            v = row[i]
            if v is None:
                continue
            d[name] = v
        out[oid] = d
    return out


# Per-strategy SQL fragment that contributes ONE primary sort key. Multiple
# fragments can be chained in the order the user specified to express
# layered preferences. A final always-on tiebreaker tail picks a sensible
# printing when the primaries tie.
#
# A preference "spec" is a string of the form "kind" or "kind:value".
_TIEBREAKER_TAIL = "(lang = 'en') DESC, released_at DESC NULLS LAST"

_BORDER_VALUES = {"black", "white", "silver", "gold", "borderless"}
_FRAME_VALUES = {"1993", "1997", "2003", "2015", "future"}
_LANG_PATTERN = {"en", "es", "fr", "de", "it", "pt", "ja", "ko", "ru", "zhs", "zht", "he", "la", "grc", "ar", "sa", "ph"}


def _py_sort_key_for(spec: str):
    """Return a (printing_dict -> sortable) function representing one
    preference fragment. Lower values sort first.

    Pulls from the unified `_SPEC_TABLE` so SQL and Python rankings stay
    in lockstep — a single bug fix to a spec lands in both query paths."""
    handler = _resolve_spec(spec)
    return handler[1] if handler else None


def _neg_iso(s: str | None) -> str:
    """Return a string that sorts in REVERSE ISO-date order (for "latest")."""
    if not s:
        return ""
    # Negate by character complement on each digit/letter — for ISO strings
    # of fixed length this gives proper reverse-sort behavior.
    return "".join(chr(255 - ord(ch)) for ch in s)


def _bool_pykey(field: str, want: bool):
    return lambda p, _f=field, _w=want: 0 if bool(p.get(_f)) == _w else 1


def _eq_pykey(field: str, want):
    return lambda p, _f=field, _w=want: 0 if p.get(_f) == _w else 1


# Single source of truth for every preference spec. Each entry maps a
# `(kind, value-or-None)` to (sql_fragment, python_sort_key). Both the
# SQL ORDER-BY builder and the Python sort-key builder consult this table
# so they can never diverge again — the user already hit a real bug
# where one accepted multi-spec stacking and the other deduped.
def _build_spec_table() -> "dict[tuple[str, str | None], tuple[str, object]]":
    table: dict[tuple[str, str | None], tuple[str, object]] = {}

    def add(kind: str, value: str | None, sql: str, py):
        table[(kind, value)] = (sql, py)

    add("first", None, "released_at ASC NULLS LAST",
        lambda p: (p.get("released_at") is None, p.get("released_at") or ""))
    add("latest", None, "released_at DESC NULLS LAST",
        lambda p: (p.get("released_at") is None, _neg_iso(p.get("released_at"))))
    add("most_valuable", None, "price_usd DESC NULLS LAST",
        lambda p: (p.get("price_usd") is None, -(p.get("price_usd") or 0)))
    add("least_valuable", None, "price_usd ASC NULLS LAST",
        lambda p: (p.get("price_usd") is None, p.get("price_usd") or 0))
    for v in _BORDER_VALUES:
        add("border", v, f"(border_color = '{v}') DESC", _eq_pykey("border_color", v))
    for v in _FRAME_VALUES:
        add("frame", v, f"(frame = '{v}') DESC", _eq_pykey("frame", v))
    add("foil", "nonfoil", "(nonfoil = true) DESC", _bool_pykey("nonfoil", True))
    add("foil", "foil", "(foil = true) DESC", _bool_pykey("foil", True))
    add("promo", "promo", "(promo = true) DESC", _bool_pykey("promo", True))
    add("promo", "nonpromo", "(promo = false) DESC", _bool_pykey("promo", False))
    add("fullart", None, "(full_art = true) DESC", _bool_pykey("full_art", True))
    add("nonfullart", None, "(full_art = false) DESC", _bool_pykey("full_art", False))
    add("textless", None, "(textless = true) DESC", _bool_pykey("textless", True))
    add("nontextless", None, "(textless = false) DESC", _bool_pykey("textless", False))
    add("paper", None, "(digital = false) DESC", _bool_pykey("digital", False))
    add("digital", None, "(digital = true) DESC", _bool_pykey("digital", True))
    for v in _LANG_PATTERN:
        add("lang", v, f"(lang = '{v}') DESC", _eq_pykey("lang", v))
    return table


_SPEC_TABLE = _build_spec_table()
_LEGACY_ALIASES = {
    "prefer_black_border": "border:black",
    "prefer_white_border": "border:white",
    "prefer_silver_border": "border:silver",
    "prefer_gold_border": "border:gold",
    "prefer_borderless": "border:borderless",
}


def _resolve_spec(spec: str):
    """Look up a preference spec in _SPEC_TABLE, applying legacy aliases."""
    if spec in _LEGACY_ALIASES:
        spec = _LEGACY_ALIASES[spec]
    if ":" in spec:
        kind, value = spec.split(":", 1)
    else:
        kind, value = spec, None
    return _SPEC_TABLE.get((kind, value))


def _printing_to_example(p: dict) -> dict:
    """Project a raw printing dict down to the public PerCardExample shape.

    Includes `is_tournament_legal` so the frontend can paint a warning
    overlay on non-legal printings (gold-border WC, silver-border
    un-sets, 30A, memorabilia, …) when the user has opted to allow them.
    """
    return {
        "set": p["set"],
        "set_name": p["set_name"],
        "collector_number": p["collector_number"],
        "image_normal": p["image_normal"],
        "image_art_crop": p["image_art_crop"],
        "price_usd": p["price_usd"],
        "released_at": p["released_at"],
        "frame": p["frame"],
        "is_tournament_legal": _is_tournament_legal(p),
        # Printing-aesthetic fields surfaced so the frontend
        # Scryfall-syntax filter can evaluate `border:`, `is:foil`,
        # `is:promo`, `is:fullart`, `is:textless`, `is:digital`,
        # `lang:`, `stamp:` against the chosen default printing.
        "border_color": p.get("border_color"),
        "full_art": p.get("full_art"),
        "textless": p.get("textless"),
        "promo": p.get("promo"),
        "digital": p.get("digital"),
        "lang": p.get("lang"),
        "nonfoil": p.get("nonfoil"),
        "foil": p.get("foil"),
        "security_stamp": p.get("security_stamp"),
        "set_type": p.get("set_type"),
        "frame_effects": p.get("frame_effects"),
        "promo_types": p.get("promo_types"),
    }


def _row_to_printing(row: tuple) -> dict:
    """Materialize one DuckDB printings row tuple into the dict shape
    used throughout analyze(). Centralized so the main path and the
    legality-rescue fallback can't silently drift out of sync."""
    (oid, set_code, set_name, cn, img, art, price, released, frame,
     border, frame_effects, full_art, textless, promo, promo_types,
     digital, lang, layout, sec_stamp, set_type, nonfoil, foil,
     tournament_legal,
     legal_standard, legal_pioneer, legal_modern, legal_legacy,
     legal_vintage, legal_commander, legal_pauper) = row
    return {
        "oracle_id": oid,
        "set": set_code,
        "set_name": set_name,
        "collector_number": cn,
        "image_normal": img,
        "image_art_crop": art,
        "price_usd": float(price) if price is not None else None,
        "released_at": released.isoformat() if released is not None else None,
        "frame": frame,
        "border_color": border,
        "frame_effects": frame_effects,
        "full_art": full_art,
        "textless": textless,
        "promo": promo,
        "promo_types": promo_types,
        "digital": digital,
        "lang": lang,
        "layout": layout,
        "security_stamp": sec_stamp,
        "set_type": set_type,
        "nonfoil": nonfoil,
        "foil": foil,
        "tournament_legal": tournament_legal,
        "legal_standard": legal_standard,
        "legal_pioneer": legal_pioneer,
        "legal_modern": legal_modern,
        "legal_legacy": legal_legacy,
        "legal_vintage": legal_vintage,
        "legal_commander": legal_commander,
        "legal_pauper": legal_pauper,
    }


# Format ids accepted by the `format` parameter. Each maps to the column
# name on `printings` that holds per-printing legality for that format.
FORMAT_COLUMN: dict[str, str] = {
    "standard": "legal_standard",
    "pioneer": "legal_pioneer",
    "modern": "legal_modern",
    "legacy": "legal_legacy",
    "vintage": "legal_vintage",
    "commander": "legal_commander",
    "pauper": "legal_pauper",
}


def _printing_legal_in_format(p: dict, fmt: str | None) -> bool:
    """Return True if the printing is legal in the requested format.
    Unknown / null format passes everything through (no extra filter).
    A missing per-format column is treated as legal so an un-refreshed
    DB doesn't silently empty the pool when the user picks a format."""
    if not fmt:
        return True
    col = FORMAT_COLUMN.get(fmt)
    if col is None:
        return True
    val = p.get(col)
    if val is None:
        return True
    return bool(val)


def _python_sort_keys(printing_strategy: list[str] | str | None):
    """Compose a list of sort-key callables matching `_order_clause`.

    The first key always demotes digital printings (paper-first). Then the
    user's specs in order. Then the tiebreaker: english first, latest first.

    We dedupe by *full spec* (not just `kind`) so the user can specify
    multiple values of the same kind in priority order — e.g.
    `frame:1993, frame:1997, first` means "prefer 1993 frame, then 1997
    frame, then earliest printing." This mirrors the SQL behaviour and is
    needed for things like "Original frame" + "Updated frame" stacking
    in the Preferred Printing list.
    """
    if isinstance(printing_strategy, str):
        printing_strategy = [printing_strategy]
    # Hardcoded primary demotions, in order of priority:
    #   1. Paper before digital — same as the SQL ORDER BY.
    #   2. Tournament-legal before non-tournament-legal. When the user
    #      has *allowed* non-tournament cards, we still want them to
    #      appear only as a last resort, never preempting a legal
    #      alternative. (When the toggle is off they're filtered out
    #      entirely, so this key is a no-op.)
    keys = [
        lambda p: 0 if not p.get("digital") else 1,
        lambda p: 0 if _is_tournament_legal(p) else 1,
    ]
    seen: set[str] = {"paper"}  # the implicit paper-first key
    for s in printing_strategy or []:
        if s in seen:
            continue
        # Special case: an explicit "paper" spec is a no-op since we already
        # demoted digital. Skip without consuming priority.
        if s == "paper":
            continue
        seen.add(s)
        k = _py_sort_key_for(s)
        if k is not None:
            keys.append(k)
    # Tiebreakers: english first, then latest release first.
    keys.append(lambda p: 0 if p.get("lang") == "en" else 1)
    keys.append(lambda p: (p.get("released_at") is None, _neg_iso(p.get("released_at"))))
    return keys


def _fragment_for(spec: str) -> str | None:
    """Translate one preference spec into a SQL ORDER BY fragment.

    Pulls from the unified `_SPEC_TABLE`. Returns None for unrecognized
    specs (silently dropped so frontend extensions never crash analysis).
    """
    handler = _resolve_spec(spec)
    return handler[0] if handler else None


def _order_clause(strategies: list[str] | str | None) -> str:
    """Build a layered ORDER BY from a list of preference specs (in order).

    Two hardcoded primary demotions before user preferences:
      - Digital-only printings (MTGO/Arena) sort below paper printings.
      - Non-tournament-legal printings sort below tournament-legal
        printings, using the per-printing `tournament_legal` column
        (sourced from Scryfall's `legalities` map) so reprints in
        eternal-legal sets correctly outrank their silver-border
        / acorn-stamp originals.
    Both demotions match the Python sort keys exactly so SQL and Python
    rankings stay in lockstep.
    """
    paper_first = "(digital = false) DESC"
    legal_first = "COALESCE(tournament_legal, true) DESC"
    if isinstance(strategies, str):
        strategies = [strategies]
    parts: list[str] = [paper_first, legal_first]
    for s in strategies or []:
        frag = _fragment_for(s)
        if frag and frag != paper_first and frag != legal_first:
            parts.append(frag)
    return ", ".join(parts) + ", " + _TIEBREAKER_TAIL


def analyze(
    entries: list[DecklistEntry],
    aesthetics: list[Aesthetic],
    include_sideboard: bool = True,
    include_basics: bool = False,
    printing_strategy: list[str] | str | None = None,
    allow_non_tournament: bool = True,
    disabled_sets: list[str] | None = None,
    allow_digital: bool = False,
    format: str | None = None,
) -> dict:
    # "Cube" is a meta-format: any printing of any card may legally appear
    # in a cube, including silver-border / gold-border / 30A / acorn /
    # memorabilia products. Force the tournament-legality filter off so
    # the default printing pool isn't artificially shrunk.
    if format == "cube":
        allow_non_tournament = True
    # Filter
    filtered: list[DecklistEntry] = []
    for e in entries:
        if not include_sideboard and e.section == "sideboard":
            continue
        if not include_basics and db.normalize_name(e.name) in BASIC_LANDS:
            continue
        filtered.append(e)

    # Aggregate qty per normalized name (de-dupe across sections).
    qty_by_norm: dict[str, int] = defaultdict(int)
    sections_by_norm: dict[str, set[str]] = defaultdict(set)
    display_name: dict[str, str] = {}
    for e in filtered:
        n = db.normalize_name(e.name)
        if not n:
            continue
        qty_by_norm[n] += e.qty
        sections_by_norm[n].add(e.section)
        display_name.setdefault(n, e.name)

    resolved, unresolved = _resolve_names(filtered)
    warnings = [f"Unrecognized card: {display_name.get(n, n)}" for n in unresolved]

    norm_to_oracle = {n: resolved[n] for n in qty_by_norm if n in resolved}
    oracle_ids = list(set(norm_to_oracle.values()))

    # Default printing per oracle_id — chosen by the requested strategy.
    default_printing: dict[str, dict] = {}
    available_by_aesthetic: dict[str, set[str]] = {a.id: set() for a in aesthetics}
    example_printing: dict[str, dict[str, dict]] = {a.id: {} for a in aesthetics}
    # Which aesthetics are satisfied by the *default* (chosen-preferred)
    # printing for each oracle. Subset of available_by_aesthetic. Used by
    # the Score view to compute the "Preferred-printing" score.
    default_satisfies: dict[str, set[str]] = {a.id: set() for a in aesthetics}
    # Per-printing predicate cache, scoped to this analyze() call. The
    # global cross-request cache below kicks in for repeat printings the
    # backend has already evaluated; this local dict short-circuits within
    # the same request when one printing is the example for many aesthetics.
    printing_satisfies: dict[tuple[str, str], set[str]] = {}

    if oracle_ids:
        # SINGLE bulk fetch of every printing for the deck's oracle_ids.
        # Pulls every column we need to (a) display, (b) sort by user
        # preference, and (c) evaluate aesthetic predicates in Python.
        # This replaces what was previously 1 default-pass query + N
        # per-aesthetic queries (where N = total aesthetics, currently 41).
        oracle_placeholders = ", ".join(["?"] * len(oracle_ids))
        with db.read_lock() as c:
            all_rows = c.execute(
                f"""
                SELECT oracle_id, "set", set_name, collector_number,
                       image_normal, image_art_crop, price_usd,
                       released_at, frame, border_color, frame_effects,
                       full_art, textless, promo, promo_types, digital,
                       lang, layout, security_stamp, set_type,
                       nonfoil, foil, tournament_legal,
                       legal_standard, legal_pioneer, legal_modern,
                       legal_legacy, legal_vintage, legal_commander,
                       legal_pauper
                FROM printings
                WHERE oracle_id IN ({oracle_placeholders})
                  AND image_normal IS NOT NULL
                """,
                list(oracle_ids),
            ).fetchall()

        # Group printings per oracle_id; build a raw dict for each.
        # Apply tournament-legality + per-set filters here so every
        # downstream consumer (default-pick, examples, version_counts,
        # aesthetic counts, summary totals) sees the same filtered pool.
        disabled_set_codes = set(disabled_sets or [])
        printings_by_oracle: dict[str, list[dict]] = defaultdict(list)
        for row in all_rows:
            p = _row_to_printing(row)
            set_code = p["set"]
            oid = p["oracle_id"]
            if set_code in disabled_set_codes:
                continue
            if not allow_non_tournament and not _is_tournament_legal(p):
                continue
            if not allow_digital and p.get("digital"):
                continue
            if not _printing_legal_in_format(p, format):
                continue
            printings_by_oracle[oid].append(p)

        # Graceful fallback: if the legality / digital filters above
        # eliminated *every* printing of a card (e.g. Blast from the
        # Past has only silver-border Unhinged printings), restore the
        # full unfiltered pool for that oracle so the deck row still
        # has an image to display. The non-legal printings will still
        # render the diagonal "Not tournament legal" overlay, but the
        # card won't silently vanish from the user's deck.
        #
        # IMPORTANT: this rescue is skipped when the user has explicitly
        # selected a `format`. In that case "no legal printing" is the
        # whole point of the filter — silently re-adding the card would
        # make the format dropdown appear to do nothing. Instead we
        # leave the card with no `default` printing and surface a
        # warning so the UI can call out "X is not legal in <format>".
        rescued_oracles: set[str] = set()
        format_blocked: set[str] = set()
        for oid in oracle_ids:
            if oid not in printings_by_oracle or not printings_by_oracle[oid]:
                if format:
                    format_blocked.add(oid)
                else:
                    rescued_oracles.add(oid)
        if rescued_oracles:
            for row in all_rows:
                oid = row[0]
                set_code = row[1]
                if oid not in rescued_oracles:
                    continue
                if set_code in disabled_set_codes:
                    continue
                printings_by_oracle[oid].append(_row_to_printing(row))
        if format_blocked:
            # Map oracle_id -> display name for the warning text.
            blocked_names = sorted(
                {display_name.get(n, n)
                 for n, oid in norm_to_oracle.items()
                 if oid in format_blocked}
            )
            for nm in blocked_names:
                warnings.append(f"Not legal in {format}: {nm}")

        # Sort each oracle's printings by the user-requested preference
        # using the equivalent Python sort keys.
        sort_keys = _python_sort_keys(printing_strategy)
        def composite(p: dict):
            return tuple(k(p) for k in sort_keys)
        for oid, plist in printings_by_oracle.items():
            plist.sort(key=composite)

        # Evaluate every aesthetic predicate over every printing once.
        # Total work: cards × printings × aesthetics — but each predicate
        # is a tiny lambda chain, so this is far faster than 41 SQL probes.
        # `version_counts[oid][aid]` tracks how many distinct printings of
        # this oracle satisfy each aesthetic — surfaced to the Coverage
        # view so each cell can show "N versions match".
        ver = _AESTHETICS_VERSION
        version_counts: dict[str, dict[str, int]] = {}
        for oid, plist in printings_by_oracle.items():
            covered_for_oid: set[str] = set()
            counts_for_oid: dict[str, int] = {}
            for p in plist:
                key = (p["set"], p["collector_number"])
                sat = printing_satisfies.get(key)
                if sat is None:
                    cache_key2 = (key[0], key[1], ver)
                    with _PRINTING_SATISFIES_LOCK:
                        sat = _PRINTING_SATISFIES_CACHE.get(cache_key2)
                        if sat is not None:
                            _PRINTING_SATISFIES_CACHE.move_to_end(cache_key2)
                    if sat is None:
                        sat = set()
                        for ae in aesthetics:
                            fn = ae.match_py
                            if fn is not None and fn(p):
                                sat.add(ae.id)
                        with _PRINTING_SATISFIES_LOCK:
                            _PRINTING_SATISFIES_CACHE[cache_key2] = sat
                            _PRINTING_SATISFIES_CACHE.move_to_end(cache_key2)
                            while len(_PRINTING_SATISFIES_CACHE) > _PRINTING_SATISFIES_MAX:
                                _PRINTING_SATISFIES_CACHE.popitem(last=False)
                    printing_satisfies[key] = sat
                # Track availability + best example per aesthetic. plist is
                # already sorted by preference, so the first matching entry
                # we see for each (oid, aesthetic) wins.
                for aid in sat:
                    counts_for_oid[aid] = counts_for_oid.get(aid, 0) + 1
                    if aid not in covered_for_oid:
                        example_printing[aid][oid] = _printing_to_example(p)
                        available_by_aesthetic[aid].add(oid)
                        covered_for_oid.add(aid)
            version_counts[oid] = counts_for_oid

        # Default printing = top-ranked printing per oracle (regardless of
        # aesthetic). Match the legacy SQL behaviour exactly.
        for oid, plist in printings_by_oracle.items():
            if not plist:
                continue
            top = plist[0]
            default_printing[oid] = _printing_to_example(top)
            for aid in printing_satisfies.get((top["set"], top["collector_number"]), ()):
                default_satisfies[aid].add(oid)

        # Attach `satisfies: list[str]` to every default and example dict so
        # the frontend can pick a next-best printing under spotlight excludes.
        for oid, dp in default_printing.items():
            key = (dp.get("set"), dp.get("collector_number"))
            dp["satisfies"] = sorted(printing_satisfies.get(key, set()))
        for ae_id, by_oid in example_printing.items():
            for oid, ex in by_oid.items():
                key = (ex.get("set"), ex.get("collector_number"))
                ex["satisfies"] = sorted(printing_satisfies.get(key, set()))

    total_unique = len(qty_by_norm)
    total_qty = sum(qty_by_norm.values())

    # Summary rows. Avoid an O(aesthetics × cards) inner loop by
    # precomputing qty per oracle_id once, then iterating each
    # aesthetic's available oid set directly (typically a fraction of
    # the full deck).
    qty_by_oid: dict[str, int] = defaultdict(int)
    for n, q in qty_by_norm.items():
        oid = norm_to_oracle.get(n)
        if oid is not None:
            qty_by_oid[oid] += q
    summary = []
    for ae in aesthetics:
        avail_oids = available_by_aesthetic[ae.id]
        avail_unique = len(avail_oids)
        avail_qty = 0
        for oid in avail_oids:
            avail_qty += qty_by_oid.get(oid, 0)
        coverage = (avail_qty / total_qty * 100.0) if total_qty else 0.0
        summary.append({
            "aesthetic_id": ae.id,
            "label": ae.label,
            "group": ae.group,
            "available_unique": avail_unique,
            "total_unique": total_unique,
            "available_qty": avail_qty,
            "total_qty": total_qty,
            "coverage_pct": round(coverage, 2),
        })

    # Per-card rows
    oracle_data = _fetch_oracle_data(list({oid for oid in norm_to_oracle.values() if oid}))
    per_card = []
    for n, q in sorted(qty_by_norm.items(), key=lambda kv: display_name.get(kv[0], kv[0])):
        oid = norm_to_oracle.get(n)
        avail_ids: list[str] = []
        default_ids: list[str] = []
        examples: dict[str, dict] = {}
        if oid:
            for ae in aesthetics:
                if oid in available_by_aesthetic[ae.id]:
                    avail_ids.append(ae.id)
                    examples[ae.id] = example_printing[ae.id][oid]
                if oid in default_satisfies[ae.id]:
                    default_ids.append(ae.id)
        row: dict = {
            "name": display_name[n],
            "name_normalized": n,
            "qty": q,
            "oracle_id": oid,
            "sections": sorted(sections_by_norm[n]),
            "resolved": oid is not None,
            "available_aesthetics": avail_ids,
            "default_aesthetics": default_ids,
            "examples": examples,
            "default": default_printing.get(oid) if oid else None,
            # Per-aesthetic count of distinct printings of this oracle
            # that satisfy that aesthetic. Drives the Coverage view's
            # "N versions" cell badge.
            "version_counts": (version_counts.get(oid, {}) if oid else {}),
        }
        # Surface oracle-level gameplay fields (type_line, oracle_text,
        # colors, mana_cost, cmc, pow/tou, rarity, keywords, …) so the
        # frontend Scryfall-syntax filter can evaluate `t:`, `o:`,
        # `c:`, `mv:`, `pow:`, `r:`, `kw:`, etc. Only present when the
        # cards table has been populated by a Scryfall refresh that
        # included these columns.
        if oid and oid in oracle_data:
            row.update(oracle_data[oid])
        per_card.append(row)

    return {
        "summary": summary,
        "per_card": per_card,
        "warnings": warnings,
        "data_version": db.get_meta("scryfall_updated_at"),
        "totals": {
            "unique_cards": total_unique,
            "total_qty": total_qty,
            "unresolved": len(unresolved),
        },
    }


def cache_key(entries: Iterable[DecklistEntry], aesthetic_ids: tuple[str, ...],
              include_sideboard: bool, include_basics: bool,
              printing_strategy: tuple[str, ...] | str | None,
              data_version: str | None,
              allow_non_tournament: bool,
              disabled_sets: tuple[str, ...],
              allow_digital: bool,
              format: str | None) -> str:
    h = hashlib.sha256()
    for e in sorted(entries, key=lambda x: (x.section, x.name, x.qty)):
        h.update(f"{e.section}|{e.qty}|{e.name}\n".encode())
    h.update(("|".join(aesthetic_ids)).encode())
    if isinstance(printing_strategy, str):
        ps_repr = printing_strategy
    elif printing_strategy is None:
        ps_repr = ""
    else:
        ps_repr = ",".join(printing_strategy)
    h.update(f"|sb={include_sideboard}|basics={include_basics}|ps={ps_repr}|v={data_version}".encode())
    h.update(f"|tl={allow_non_tournament}|ds={','.join(sorted(disabled_sets))}|dg={allow_digital}|fmt={format or ''}".encode())
    return h.hexdigest()


@lru_cache(maxsize=128)
def _cached_analyze_internal(key: str, payload_repr: str) -> dict:  # pragma: no cover
    raise RuntimeError("Use analyze_cached -- this is a placeholder for typing only.")


_RESULT_CACHE: "OrderedDict[str, dict]" = OrderedDict()
_RESULT_CACHE_LOCK = threading.Lock()
_RESULT_CACHE_MAX = 128

# Cross-request cache for "which aesthetics does this printing satisfy?".
# Keyed by (set, collector_number, aesthetics-version-token). The token is
# included so that a ruleset reload safely invalidates the cache.
# Survives across analyze() calls so back-to-back imports of similar
# decks (commander variants, sideboard tweaks, etc.) share work.
_PRINTING_SATISFIES_CACHE: "OrderedDict[tuple[str, str, int], set[str]]" = OrderedDict()
_PRINTING_SATISFIES_LOCK = threading.Lock()
_PRINTING_SATISFIES_MAX = 50_000
_AESTHETICS_VERSION = 0


def bump_aesthetics_version() -> None:
    """Invalidate the printing-satisfies cross-request cache. Call when
    rulesets are reloaded or replaced."""
    global _AESTHETICS_VERSION
    with _PRINTING_SATISFIES_LOCK:
        _AESTHETICS_VERSION += 1
        _PRINTING_SATISFIES_CACHE.clear()
    # Aesthetic predicates changed -> result cache is stale too.
    with _RESULT_CACHE_LOCK:
        _RESULT_CACHE.clear()


def analyze_cached(
    entries: list[DecklistEntry],
    aesthetics: list[Aesthetic],
    include_sideboard: bool,
    include_basics: bool,
    printing_strategy: list[str] | str | None = None,
    allow_non_tournament: bool = True,
    disabled_sets: list[str] | None = None,
    allow_digital: bool = False,
    format: str | None = None,
) -> dict:
    aid_tuple = tuple(a.id for a in aesthetics)
    dv = db.get_meta("scryfall_updated_at") or ""
    if isinstance(printing_strategy, list):
        ps_for_key: tuple[str, ...] | str | None = tuple(printing_strategy)
    else:
        ps_for_key = printing_strategy
    ds_tuple = tuple(disabled_sets or ())
    key = cache_key(entries, aid_tuple, include_sideboard, include_basics,
                    ps_for_key, dv, allow_non_tournament, ds_tuple, allow_digital,
                    format)
    with _RESULT_CACHE_LOCK:
        cached = _RESULT_CACHE.get(key)
        if cached is not None:
            _RESULT_CACHE.move_to_end(key)
            return cached
    result = analyze(entries, aesthetics, include_sideboard, include_basics,
                     printing_strategy, allow_non_tournament, list(ds_tuple),
                     allow_digital, format)
    with _RESULT_CACHE_LOCK:
        _RESULT_CACHE[key] = result
        _RESULT_CACHE.move_to_end(key)
        while len(_RESULT_CACHE) > _RESULT_CACHE_MAX:
            _RESULT_CACHE.popitem(last=False)
    return result


def clear_cache() -> None:
    with _RESULT_CACHE_LOCK:
        _RESULT_CACHE.clear()
    # The printing-satisfies cache is keyed by aesthetics version, so we
    # don't need to clear it on every analyze() invalidation — but we do
    # need to clear it on a Scryfall data refresh because the same
    # (set, cn) may now refer to different printing data.
    with _PRINTING_SATISFIES_LOCK:
        _PRINTING_SATISFIES_CACHE.clear()
