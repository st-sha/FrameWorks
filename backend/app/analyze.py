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


def _fragment_for(spec: str) -> str | None:
    """Translate one preference spec into a SQL ORDER BY fragment.

    Returns None for unrecognized specs (silently dropped so frontend
    extension never crashes the analysis).
    """
    if ":" in spec:
        kind, value = spec.split(":", 1)
    else:
        kind, value = spec, None

    if kind == "first":
        return "released_at ASC NULLS LAST"
    if kind == "latest":
        return "released_at DESC NULLS LAST"
    if kind == "most_valuable":
        return "price_usd DESC NULLS LAST"
    if kind == "least_valuable":
        return "price_usd ASC NULLS LAST"
    if kind == "border" and value in _BORDER_VALUES:
        return f"(border_color = '{value}') DESC"
    if kind == "frame" and value in _FRAME_VALUES:
        return f"(frame = '{value}') DESC"
    if kind == "foil":
        if value == "nonfoil":
            return "(nonfoil = true) DESC"
        if value == "foil":
            return "(foil = true) DESC"
    if kind == "promo":
        if value == "promo":
            return "(promo = true) DESC"
        if value == "nonpromo":
            return "(promo = false) DESC"
    if kind == "fullart":
        return "(full_art = true) DESC"
    if kind == "nonfullart":
        return "(full_art = false) DESC"
    if kind == "textless":
        return "(textless = true) DESC"
    if kind == "nontextless":
        return "(textless = false) DESC"
    if kind == "paper":
        return "(digital = false) DESC"
    if kind == "digital":
        return "(digital = true) DESC"
    if kind == "lang" and value in _LANG_PATTERN:
        return f"(lang = '{value}') DESC"

    # Legacy aliases (kept so existing preference IDs keep working).
    legacy = {
        "prefer_black_border": "border:black",
        "prefer_white_border": "border:white",
        "prefer_silver_border": "border:silver",
        "prefer_gold_border": "border:gold",
        "prefer_borderless": "border:borderless",
    }
    if spec in legacy:
        return _fragment_for(legacy[spec])
    return None


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
    order_by = _order_clause(printing_strategy)
    if oracle_ids:
        oracle_placeholders0 = ", ".join(["?"] * len(oracle_ids))
        with db.read_lock() as c:
            rows0 = c.execute(
                f"""
                WITH ranked AS (
                  SELECT oracle_id, "set", set_name, collector_number,
                         image_normal, image_art_crop, price_usd,
                         released_at, frame,
                         ROW_NUMBER() OVER (
                           PARTITION BY oracle_id
                           ORDER BY {order_by}
                         ) AS rn
                  FROM printings
                  WHERE oracle_id IN ({oracle_placeholders0})
                    AND image_normal IS NOT NULL
                )
                SELECT oracle_id, "set", set_name, collector_number,
                       image_normal, image_art_crop, price_usd,
                       released_at, frame
                FROM ranked WHERE rn = 1
                """,
                list(oracle_ids),
            ).fetchall()
        for oid, set_code, set_name, cn, img, art, price, released, frame in rows0:
            default_printing[oid] = {
                "set": set_code,
                "set_name": set_name,
                "collector_number": cn,
                "image_normal": img,
                "image_art_crop": art,
                "price_usd": float(price) if price is not None else None,
                "released_at": released.isoformat() if released is not None else None,
                "frame": frame,
            }

    # Per-aesthetic: which oracle_ids have at least one matching printing,
    # plus a representative printing chosen by the requested strategy.
    available_by_aesthetic: dict[str, set[str]] = {a.id: set() for a in aesthetics}
    example_printing: dict[str, dict[str, dict]] = {a.id: {} for a in aesthetics}
    # Which aesthetics are satisfied by the *default* (chosen-preferred)
    # printing for each oracle. Subset of available_by_aesthetic. Used by
    # the Score view to compute the "Preferred-printing" score.
    default_satisfies: dict[str, set[str]] = {a.id: set() for a in aesthetics}
    # Raw printing rows we encounter during the first pass — keyed by
    # (set, collector_number) so we can re-evaluate predicates in Python
    # against every visible printing without a second SQL pass. Each entry
    # is a dict shaped like rulesets.SCALAR_FIELDS + LIST_FIELDS.
    raw_printings: dict[tuple[str, str], dict] = {}

    if oracle_ids:
        oracle_placeholders = ", ".join(["?"] * len(oracle_ids))
        with db.read_lock() as c:
            # First, the default-printing pass also fetches the raw fields
            # we need to evaluate every aesthetic predicate in Python.
            # We re-run the default query with the extra columns instead of
            # touching default_printing's existing layout.
            default_raw_rows = c.execute(
                f"""
                WITH ranked AS (
                  SELECT oracle_id, "set", set_name, collector_number,
                         border_color, frame, frame_effects, full_art,
                         textless, promo, promo_types, digital, lang,
                         layout, security_stamp, set_type,
                         ROW_NUMBER() OVER (
                           PARTITION BY oracle_id
                           ORDER BY {order_by}
                         ) AS rn
                  FROM printings
                  WHERE oracle_id IN ({oracle_placeholders})
                    AND image_normal IS NOT NULL
                )
                SELECT oracle_id, "set", set_name, collector_number,
                       border_color, frame, frame_effects, full_art,
                       textless, promo, promo_types, digital, lang,
                       layout, security_stamp, set_type
                FROM ranked WHERE rn = 1
                """,
                list(oracle_ids),
            ).fetchall()
            for row in default_raw_rows:
                (oid, set_code, _set_name, cn, border, frame, frame_effects,
                 full_art, textless, promo, promo_types, digital, lang,
                 layout, sec_stamp, set_type) = row
                if set_code and cn:
                    raw_printings[(set_code, cn)] = {
                        "oracle_id": oid,
                        "set": set_code,
                        "collector_number": cn,
                        "border_color": border,
                        "frame": frame,
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
                    }

            for ae in aesthetics:
                sql = f"""
                    WITH ranked AS (
                      SELECT oracle_id, "set", set_name, collector_number,
                             image_normal, image_art_crop, price_usd,
                             released_at, frame,
                             border_color, frame_effects, full_art,
                             textless, promo, promo_types, digital, lang,
                             layout, security_stamp, set_type,
                             ROW_NUMBER() OVER (
                               PARTITION BY oracle_id
                               ORDER BY {order_by}
                             ) AS rn
                      FROM printings
                      WHERE oracle_id IN ({oracle_placeholders})
                        AND ({ae.sql_where})
                    )
                    SELECT oracle_id, "set", set_name, collector_number,
                           image_normal, image_art_crop, price_usd,
                           released_at, frame,
                           border_color, frame_effects, full_art,
                           textless, promo, promo_types, digital, lang,
                           layout, security_stamp, set_type
                    FROM ranked WHERE rn = 1
                """
                params = list(oracle_ids) + list(ae.params)
                rows = c.execute(sql, params).fetchall()
                for row in rows:
                    (oid, set_code, set_name, cn, img, art, price, released,
                     frame, border, frame_effects, full_art, textless, promo,
                     promo_types, digital, lang, layout, sec_stamp,
                     set_type) = row
                    available_by_aesthetic[ae.id].add(oid)
                    example_printing[ae.id][oid] = {
                        "set": set_code,
                        "set_name": set_name,
                        "collector_number": cn,
                        "image_normal": img,
                        "image_art_crop": art,
                        "price_usd": float(price) if price is not None else None,
                        "released_at": released.isoformat() if released is not None else None,
                        "frame": frame,
                    }
                    if set_code and cn:
                        raw_printings.setdefault((set_code, cn), {
                            "oracle_id": oid,
                            "set": set_code,
                            "collector_number": cn,
                            "border_color": border,
                            "frame": frame,
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
                        })

        # Second pass entirely in Python: evaluate every aesthetic's
        # compiled predicate against every raw printing we've collected.
        # This replaces what used to be N additional SQL probes (one per
        # aesthetic) and brings analyze() back from ~5s to sub-second on
        # small decks.
        printing_satisfies: dict[tuple[str, str], set[str]] = {}
        for key, raw in raw_printings.items():
            sat: set[str] = set()
            for ae in aesthetics:
                fn = ae.match_py
                if fn is not None and fn(raw):
                    sat.add(ae.id)
            printing_satisfies[key] = sat
        # Build default_satisfies from the printing_satisfies map.
        for oid, dp in default_printing.items():
            key = (dp.get("set"), dp.get("collector_number"))
            for aid in printing_satisfies.get(key, ()):
                default_satisfies[aid].add(oid)

        # Attach `satisfies: list[str]` to every default and example dict so
        # the frontend can pick a next-best printing under spotlight excludes.
        for oid, dp in default_printing.items():
            key = (dp.get("set"), dp.get("collector_number"))
            sat = sorted(printing_satisfies.get(key, set()))
            dp["satisfies"] = sat
        for ae_id, by_oid in example_printing.items():
            for oid, ex in by_oid.items():
                key = (ex.get("set"), ex.get("collector_number"))
                sat = sorted(printing_satisfies.get(key, set()))
                ex["satisfies"] = sat

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
