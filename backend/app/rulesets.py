"""Aesthetic ruleset loader and predicate-to-SQL compiler.

Ruleset YAML schema:

  aesthetics:
    - id: future_sight
      label: "Future Sight Frame"
      description: "Cards printed with the FUT-era future-shifted frame."
      match:
        equals: { frame: "future" }

  Predicate ops (compose recursively):
    equals:    { field: value }              # field = value
    in:        { field: [v1, v2, ...] }      # field IN (...)
    contains:  { field: value }              # list field CONTAINS value
    not:       <predicate>
    all:       [<predicate>, ...]            # AND
    any:       [<predicate>, ...]            # OR
    raw:       "<sql expression>"            # escape hatch (trusted YAML only)

  Allowed fields (whitelist enforced):
    frame, border_color, layout, lang, set, set_name, collector_number,
    full_art, textless, promo, digital,
    frame_effects (list), promo_types (list)
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import yaml

log = logging.getLogger(__name__)

SCALAR_FIELDS = {
    "frame",
    "border_color",
    "layout",
    "lang",
    "set",
    "set_name",
    "collector_number",
    "full_art",
    "textless",
    "promo",
    "digital",
    "security_stamp",
    "set_type",
}
LIST_FIELDS = {"frame_effects", "promo_types"}
ALL_FIELDS = SCALAR_FIELDS | LIST_FIELDS


class RulesetError(ValueError):
    pass


@dataclass(frozen=True)
class Aesthetic:
    id: str
    label: str
    description: str
    sql_where: str
    params: tuple[Any, ...]
    icon: str | None = None
    group: str | None = None
    # In-process predicate evaluator built from the same `match` block.
    # Takes a printing dict (with raw fields like border_color, set,
    # promo_types, etc.) and returns True/False. Used in hot loops where
    # round-tripping to DuckDB per aesthetic would dominate latency.
    match_py: Any = None


def _quote_ident(field: str) -> str:
    if field not in ALL_FIELDS:
        raise RulesetError(f"Unknown field: {field!r}")
    # `set` is a reserved word in SQL; always quote.
    return f'"{field}"'


def _compile(node: Any, params: list[Any]) -> str:
    if not isinstance(node, dict):
        raise RulesetError(f"Predicate must be a mapping, got {type(node).__name__}")
    if len(node) != 1:
        raise RulesetError(
            f"Predicate must have exactly one operator key, got: {list(node)}"
        )
    op, body = next(iter(node.items()))

    if op == "equals":
        if not isinstance(body, dict) or len(body) != 1:
            raise RulesetError("equals must be a single-key mapping")
        field, value = next(iter(body.items()))
        params.append(value)
        return f"{_quote_ident(field)} = ?"

    if op == "in":
        if not isinstance(body, dict) or len(body) != 1:
            raise RulesetError("in must be a single-key mapping")
        field, values = next(iter(body.items()))
        if not isinstance(values, list) or not values:
            raise RulesetError("in values must be a non-empty list")
        placeholders = ", ".join(["?"] * len(values))
        params.extend(values)
        return f"{_quote_ident(field)} IN ({placeholders})"

    if op == "contains":
        if not isinstance(body, dict) or len(body) != 1:
            raise RulesetError("contains must be a single-key mapping")
        field, value = next(iter(body.items()))
        if field not in LIST_FIELDS:
            raise RulesetError(f"contains only valid for list fields: {LIST_FIELDS}")
        params.append(value)
        return f"list_contains({_quote_ident(field)}, ?)"

    if op == "not":
        return f"NOT ({_compile(body, params)})"

    if op == "all":
        if not isinstance(body, list) or not body:
            raise RulesetError("all must be a non-empty list")
        return "(" + " AND ".join(_compile(p, params) for p in body) + ")"

    if op == "any":
        if not isinstance(body, list) or not body:
            raise RulesetError("any must be a non-empty list")
        return "(" + " OR ".join(_compile(p, params) for p in body) + ")"

    if op == "raw":
        if not isinstance(body, str):
            raise RulesetError("raw must be a string")
        # Trusted source (server-side YAML only). Disallow ';' to prevent obvious
        # statement-stuffing if a less-trusted file ever sneaks in.
        if ";" in body:
            raise RulesetError("raw predicates may not contain ';'")
        return f"({body})"

    raise RulesetError(f"Unknown predicate operator: {op!r}")


def compile_aesthetic(entry: dict) -> Aesthetic:
    aid = entry.get("id")
    label = entry.get("label") or aid
    if not aid or not isinstance(aid, str):
        raise RulesetError(f"Aesthetic missing 'id': {entry!r}")
    match = entry.get("match")
    if not match:
        raise RulesetError(f"Aesthetic {aid!r} missing 'match' block")
    params: list[Any] = []
    where = _compile(match, params)
    return Aesthetic(
        id=aid,
        label=label,
        description=entry.get("description", ""),
        sql_where=where,
        params=tuple(params),
        icon=entry.get("icon"),
        group=entry.get("group"),
        match_py=_compile_py(match),
    )


def _compile_py(node: Any):
    """Compile a predicate into a Python callable that evaluates against a
    printing dict. Mirror of `_compile`, but produces an in-process
    evaluator so we can probe many printings without round-tripping to
    DuckDB. Returns a callable: dict -> bool."""
    if not isinstance(node, dict) or len(node) != 1:
        raise RulesetError(f"Predicate must be a single-key mapping: {node!r}")
    op, body = next(iter(node.items()))

    if op == "equals":
        if not isinstance(body, dict) or len(body) != 1:
            raise RulesetError("equals must be a single-key mapping")
        field, value = next(iter(body.items()))
        if field not in ALL_FIELDS:
            raise RulesetError(f"Unknown field: {field!r}")
        return lambda p, _f=field, _v=value: p.get(_f) == _v

    if op == "in":
        if not isinstance(body, dict) or len(body) != 1:
            raise RulesetError("in must be a single-key mapping")
        field, values = next(iter(body.items()))
        if field not in ALL_FIELDS:
            raise RulesetError(f"Unknown field: {field!r}")
        if not isinstance(values, list) or not values:
            raise RulesetError("in values must be a non-empty list")
        vset = set(values)
        return lambda p, _f=field, _s=vset: p.get(_f) in _s

    if op == "contains":
        if not isinstance(body, dict) or len(body) != 1:
            raise RulesetError("contains must be a single-key mapping")
        field, value = next(iter(body.items()))
        if field not in LIST_FIELDS:
            raise RulesetError(f"contains only valid for list fields: {LIST_FIELDS}")
        return lambda p, _f=field, _v=value: _v in (p.get(_f) or [])

    if op == "not":
        inner = _compile_py(body)
        return lambda p, _f=inner: not _f(p)

    if op == "all":
        if not isinstance(body, list) or not body:
            raise RulesetError("all must be a non-empty list")
        children = [_compile_py(c) for c in body]
        return lambda p, _c=children: all(f(p) for f in _c)

    if op == "any":
        if not isinstance(body, list) or not body:
            raise RulesetError("any must be a non-empty list")
        children = [_compile_py(c) for c in body]
        return lambda p, _c=children: any(f(p) for f in _c)

    if op == "raw":
        # `raw` predicates can't be safely re-evaluated in Python; treat
        # as always-false in the hot path. Callers needing exactness can
        # still rely on the SQL form via `sql_where`.
        return lambda _p: False

    raise RulesetError(f"Unknown predicate operator: {op!r}")


def load_rulesets(rulesets_dir: Path) -> list[Aesthetic]:
    """Load every *.yaml / *.yml in the directory; later files override earlier
    aesthetics with the same id."""
    if not rulesets_dir.exists():
        log.warning("Rulesets dir %s does not exist", rulesets_dir)
        return []

    by_id: dict[str, Aesthetic] = {}
    for path in sorted(rulesets_dir.glob("*.y*ml")):
        try:
            doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as e:
            raise RulesetError(f"Failed to parse {path}: {e}") from e
        entries = doc.get("aesthetics") or []
        if not isinstance(entries, list):
            raise RulesetError(f"{path}: 'aesthetics' must be a list")
        for entry in entries:
            ae = compile_aesthetic(entry)
            if ae.id in by_id:
                log.info("Overriding aesthetic %s from %s", ae.id, path.name)
            by_id[ae.id] = ae
        log.info("Loaded %d aesthetics from %s", len(entries), path.name)

    return list(by_id.values())


def filter_by_ids(aesthetics: Iterable[Aesthetic], ids: Iterable[str] | None) -> list[Aesthetic]:
    if not ids:
        return list(aesthetics)
    wanted = set(ids)
    return [a for a in aesthetics if a.id in wanted]
