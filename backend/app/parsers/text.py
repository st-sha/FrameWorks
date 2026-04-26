"""Universal text-format decklist parser.

Handles:
  - Plain `4 Lightning Bolt`
  - `4x Lightning Bolt`
  - `4 Lightning Bolt (LEA) 161`        (MTGA-style with set + collector#)
  - MTGA section headers: `Deck`, `Sideboard`, `Companion`, `Commander`
  - MTGO `SB:` prefix for sideboard
  - `//` and `#` comments
  - Blank-line section breaks (first block = mainboard, second = sideboard)
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Literal

Section = Literal["mainboard", "sideboard", "commander", "companion"]


@dataclass(frozen=True)
class DecklistEntry:
    name: str
    qty: int
    section: Section = "mainboard"
    set_code: str | None = None
    collector_number: str | None = None


@dataclass
class ParseResult:
    entries: list[DecklistEntry] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


_SECTION_HEADERS: dict[str, Section] = {
    "deck": "mainboard",
    "main": "mainboard",
    "maindeck": "mainboard",
    "main deck": "mainboard",
    "mainboard": "mainboard",
    "sideboard": "sideboard",
    "side": "sideboard",
    "side board": "sideboard",
    "sb": "sideboard",
    "commander": "commander",
    "companion": "companion",
}

# `4 Card Name`  /  `4x Card Name`  /  `4 Card Name (SET) 123`
_LINE_RE = re.compile(
    r"""^\s*
        (?P<qty>\d+)\s*x?\s+
        (?P<name>.+?)
        (?:\s+\((?P<set>[A-Za-z0-9]{2,6})\)\s*(?P<cn>[A-Za-z0-9\-\u2605]+)?)?
        \s*$""",
    re.VERBOSE,
)


def parse_text(raw: str) -> ParseResult:
    result = ParseResult()
    if not raw or not raw.strip():
        return result

    # Try MTGO XML .dek first (cheap heuristic).
    if raw.lstrip().startswith("<?xml") or "<Deck" in raw[:200]:
        try:
            return _parse_mtgo_dek(raw)
        except ET.ParseError:
            pass  # fall through to text parsing

    section: Section = "mainboard"
    saw_blank_break = False
    has_explicit_section = False

    for raw_line in raw.splitlines():
        line = raw_line.strip()
        if not line:
            # blank line: in implicit mode the next non-blank starts sideboard
            if not has_explicit_section and section == "mainboard":
                saw_blank_break = True
            continue
        if line.startswith("//") or line.startswith("#"):
            continue

        # Section header?
        lowered = line.lower().rstrip(":")
        if lowered in _SECTION_HEADERS:
            section = _SECTION_HEADERS[lowered]
            has_explicit_section = True
            saw_blank_break = False
            continue

        # MTGO `SB: 2 Card Name`
        sb_prefix = False
        if line.lower().startswith("sb:"):
            sb_prefix = True
            line = line[3:].strip()

        m = _LINE_RE.match(line)
        if not m:
            result.warnings.append(f"Could not parse line: {raw_line!r}")
            continue

        qty = int(m.group("qty"))
        if qty <= 0:
            continue
        name = m.group("name").strip()
        # strip MTGA category-suffix like "Lightning Bolt"  (no-op usually)
        name = name.strip().rstrip(",")

        eff_section: Section = section
        if sb_prefix:
            eff_section = "sideboard"
        elif saw_blank_break and not has_explicit_section:
            eff_section = "sideboard"

        result.entries.append(
            DecklistEntry(
                name=name,
                qty=qty,
                section=eff_section,
                set_code=(m.group("set") or None),
                collector_number=(m.group("cn") or None),
            )
        )

    return result


def _parse_mtgo_dek(raw: str) -> ParseResult:
    """Parse an MTGO .dek XML file."""
    result = ParseResult()
    root = ET.fromstring(raw)
    # MTGO format: <Deck><Cards CatID="..." Quantity="4" Sideboard="false" Name="Lightning Bolt"/>...</Deck>
    for card in root.iter("Cards"):
        try:
            qty = int(card.attrib.get("Quantity", "0"))
        except ValueError:
            continue
        if qty <= 0:
            continue
        name = card.attrib.get("Name", "").strip()
        if not name:
            continue
        is_sb = card.attrib.get("Sideboard", "false").lower() == "true"
        result.entries.append(
            DecklistEntry(
                name=name,
                qty=qty,
                section="sideboard" if is_sb else "mainboard",
            )
        )
    return result
