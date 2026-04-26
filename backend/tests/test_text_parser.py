from app.parsers.text import parse_text


def test_simple_quantity():
    r = parse_text("4 Lightning Bolt")
    assert len(r.entries) == 1
    e = r.entries[0]
    assert e.qty == 4 and e.name == "Lightning Bolt" and e.section == "mainboard"


def test_x_separator_and_set_collector():
    r = parse_text("4x Lightning Bolt (LEA) 161")
    assert r.entries[0].set_code == "LEA"
    assert r.entries[0].collector_number == "161"


def test_mtga_section_headers():
    src = """Deck
4 Lightning Bolt
2 Counterspell

Sideboard
2 Surgical Extraction
"""
    r = parse_text(src)
    sections = {e.name: e.section for e in r.entries}
    assert sections["Lightning Bolt"] == "mainboard"
    assert sections["Surgical Extraction"] == "sideboard"


def test_mtgo_sb_prefix():
    src = """4 Lightning Bolt
SB: 2 Surgical Extraction
"""
    r = parse_text(src)
    sections = {e.name: e.section for e in r.entries}
    assert sections["Surgical Extraction"] == "sideboard"


def test_blank_line_split_implies_sideboard():
    src = """4 Lightning Bolt
2 Counterspell

2 Surgical Extraction
"""
    r = parse_text(src)
    sections = {e.name: e.section for e in r.entries}
    assert sections["Surgical Extraction"] == "sideboard"
    assert sections["Lightning Bolt"] == "mainboard"


def test_comments_and_blank_lines():
    src = """// notes
# also a comment
4 Lightning Bolt
"""
    r = parse_text(src)
    assert len(r.entries) == 1


def test_unparseable_line_warned():
    r = parse_text("not a card line")
    assert not r.entries
    assert r.warnings


def test_mtgo_dek_xml():
    src = """<?xml version="1.0" encoding="utf-8"?>
<Deck>
  <Cards CatID="1" Quantity="4" Sideboard="false" Name="Lightning Bolt" />
  <Cards CatID="2" Quantity="2" Sideboard="true" Name="Surgical Extraction" />
</Deck>"""
    r = parse_text(src)
    sections = {e.name: e.section for e in r.entries}
    assert sections["Lightning Bolt"] == "mainboard"
    assert sections["Surgical Extraction"] == "sideboard"
