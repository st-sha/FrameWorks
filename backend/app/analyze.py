"""Decklist analysis: which aesthetics is each card available in?"""
from __future__ import annotations

import hashlib
import logging
from collections import defaultdict
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


def _resolve_names(entries: list[DecklistEntry]) -> tuple[dict[str, str], list[str]]:
    """Map normalized name -> oracle_id. Returns (resolved, unresolved_names)."""
    if not entries:
        return {}, []
    names_norm = sorted({db.normalize_name(e.name) for e in entries if e.name})
    placeholders = ", ".join(["?"] * len(names_norm))
    with db.read_lock() as c:
        rows = c.execute(
            f"SELECT name_normalized, oracle_id FROM cards WHERE name_normalized IN ({placeholders})",
            names_norm,
        ).fetchall()
    resolved = {row[0]: row[1] for row in rows}

    # Try fallback: split-card names where user typed only the front face.
    missing = [n for n in names_norm if n not in resolved]
    if missing:
        with db.read_lock() as c:
            for nm in list(missing):
                row = c.execute(
                    "SELECT oracle_id FROM cards WHERE name_normalized LIKE ? LIMIT 1",
                    [f"{nm} // %"],
                ).fetchone()
                if row:
                    resolved[nm] = row[0]
                    missing.remove(nm)

    return resolved, missing


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
    """Project a raw printing dict down to the public PerCardExample shape."""
    return {
        "set": p["set"],
        "set_name": p["set_name"],
        "collector_number": p["collector_number"],
        "image_normal": p["image_normal"],
        "image_art_crop": p["image_art_crop"],
        "price_usd": p["price_usd"],
        "released_at": p["released_at"],
        "frame": p["frame"],
    }


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
    keys = [lambda p: 0 if not p.get("digital") else 1]
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

    Digital-only printings (MTGO/Arena) are always demoted below every paper
    printing regardless of user preferences — they only surface when no paper
    printing exists. This is hardcoded as the highest-priority sort key.
    """
    paper_first = "(digital = false) DESC"
    if isinstance(strategies, str):
        strategies = [strategies]
    parts: list[str] = [paper_first]
    for s in strategies or []:
        frag = _fragment_for(s)
        if frag and frag != paper_first:
            parts.append(frag)
    return ", ".join(parts) + ", " + _TIEBREAKER_TAIL


def analyze(
    entries: list[DecklistEntry],
    aesthetics: list[Aesthetic],
    include_sideboard: bool = True,
    include_basics: bool = False,
    printing_strategy: list[str] | str | None = None,
) -> dict:
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
                       nonfoil, foil
                FROM printings
                WHERE oracle_id IN ({oracle_placeholders})
                  AND image_normal IS NOT NULL
                """,
                list(oracle_ids),
            ).fetchall()

        # Group printings per oracle_id; build a raw dict for each.
        printings_by_oracle: dict[str, list[dict]] = defaultdict(list)
        for row in all_rows:
            (oid, set_code, set_name, cn, img, art, price, released, frame,
             border, frame_effects, full_art, textless, promo, promo_types,
             digital, lang, layout, sec_stamp, set_type, nonfoil, foil) = row
            p = {
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
            }
            printings_by_oracle[oid].append(p)

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
        # Early-exit per oracle: once we've found an example for every
        # aesthetic, we can stop walking that oracle's lower-ranked
        # printings entirely.
        n_aesthetics = len(aesthetics)
        ver = _AESTHETICS_VERSION
        for oid, plist in printings_by_oracle.items():
            covered_for_oid: set[str] = set()
            for p in plist:
                key = (p["set"], p["collector_number"])
                sat = printing_satisfies.get(key)
                if sat is None:
                    cache_key2 = (key[0], key[1], ver)
                    sat = _PRINTING_SATISFIES_CACHE.get(cache_key2)
                    if sat is None:
                        sat = set()
                        for ae in aesthetics:
                            fn = ae.match_py
                            if fn is not None and fn(p):
                                sat.add(ae.id)
                        _PRINTING_SATISFIES_CACHE[cache_key2] = sat
                    printing_satisfies[key] = sat
                # Track availability + best example per aesthetic. plist is
                # already sorted by preference, so the first matching entry
                # we see for each (oid, aesthetic) wins.
                for aid in sat:
                    if aid not in covered_for_oid:
                        example_printing[aid][oid] = _printing_to_example(p)
                        available_by_aesthetic[aid].add(oid)
                        covered_for_oid.add(aid)
                if len(covered_for_oid) >= n_aesthetics:
                    break

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

    # Summary rows
    summary = []
    for ae in aesthetics:
        avail_oids = available_by_aesthetic[ae.id]
        avail_unique = 0
        avail_qty = 0
        for n, q in qty_by_norm.items():
            oid = norm_to_oracle.get(n)
            if oid and oid in avail_oids:
                avail_unique += 1
                avail_qty += q
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
        per_card.append({
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
        })

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
              data_version: str | None) -> str:
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
    return h.hexdigest()


@lru_cache(maxsize=128)
def _cached_analyze_internal(key: str, payload_repr: str) -> dict:  # pragma: no cover
    raise RuntimeError("Use analyze_cached -- this is a placeholder for typing only.")


_RESULT_CACHE: dict[str, dict] = {}

# Cross-request cache for "which aesthetics does this printing satisfy?".
# Keyed by (set, collector_number, aesthetics-version-token). The token is
# included so that a ruleset reload safely invalidates the cache.
# Survives across analyze() calls so back-to-back imports of similar
# decks (commander variants, sideboard tweaks, etc.) share work.
_PRINTING_SATISFIES_CACHE: dict[tuple[str, str, int], set[str]] = {}
_AESTHETICS_VERSION = 0


def bump_aesthetics_version() -> None:
    """Invalidate the printing-satisfies cross-request cache. Call when
    rulesets are reloaded or replaced."""
    global _AESTHETICS_VERSION
    _AESTHETICS_VERSION += 1
    _PRINTING_SATISFIES_CACHE.clear()


def analyze_cached(
    entries: list[DecklistEntry],
    aesthetics: list[Aesthetic],
    include_sideboard: bool,
    include_basics: bool,
    printing_strategy: list[str] | str | None = None,
) -> dict:
    aid_tuple = tuple(a.id for a in aesthetics)
    dv = db.get_meta("scryfall_updated_at") or ""
    if isinstance(printing_strategy, list):
        ps_for_key: tuple[str, ...] | str | None = tuple(printing_strategy)
    else:
        ps_for_key = printing_strategy
    key = cache_key(entries, aid_tuple, include_sideboard, include_basics, ps_for_key, dv)
    cached = _RESULT_CACHE.get(key)
    if cached is not None:
        return cached
    result = analyze(entries, aesthetics, include_sideboard, include_basics, printing_strategy)
    if len(_RESULT_CACHE) > 128:
        _RESULT_CACHE.pop(next(iter(_RESULT_CACHE)))
    _RESULT_CACHE[key] = result
    return result


def clear_cache() -> None:
    _RESULT_CACHE.clear()
    # The printing-satisfies cache is keyed by aesthetics version, so we
    # don't need to clear it on every analyze() invalidation — but we do
    # need to clear it on a Scryfall data refresh because the same
    # (set, cn) may now refer to different printing data.
    _PRINTING_SATISFIES_CACHE.clear()
