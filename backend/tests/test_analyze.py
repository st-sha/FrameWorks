"""Integration test for the analyze pipeline against an in-memory DuckDB.

Builds a tiny `printings` + `cards` table, then runs the analyzer end-to-end.
"""
from pathlib import Path

import pytest

from app import analyze as analyze_mod
from app import db
from app.parsers.text import DecklistEntry
from app.rulesets import compile_aesthetic


@pytest.fixture(autouse=True)
def fresh_db(tmp_path: Path):
    db.init(tmp_path / "test.duckdb")
    c = db.conn()
    c.execute("DROP TABLE IF EXISTS printings;")
    c.execute("DROP TABLE IF EXISTS cards;")
    c.execute(
        """
        CREATE TABLE printings (
            oracle_id VARCHAR, name VARCHAR, name_normalized VARCHAR,
            "set" VARCHAR, set_name VARCHAR, collector_number VARCHAR,
            released_at DATE, frame VARCHAR, frame_effects VARCHAR[],
            border_color VARCHAR, full_art BOOLEAN, textless BOOLEAN,
            promo BOOLEAN, promo_types VARCHAR[], digital BOOLEAN,
            lang VARCHAR, layout VARCHAR,
            image_normal VARCHAR, image_art_crop VARCHAR,
            price_usd DOUBLE,
            security_stamp VARCHAR, set_type VARCHAR,
            nonfoil BOOLEAN, foil BOOLEAN
        );
        """
    )
    # Lightning Bolt: 1993, 1997, 2003, 2015
    rows = [
        ("oid-bolt", "Lightning Bolt", "lightning bolt", "lea", "Alpha", "161",
         "1993-08-05", "1993", [], "black", False, False, False, [], False, "en", "normal",
         "img-bolt-lea.png", "art-bolt-lea.png", 1500.0),
        ("oid-bolt", "Lightning Bolt", "lightning bolt", "m11", "Magic 2011", "146",
         "2010-07-16", "2003", [], "black", False, False, False, [], False, "en", "normal",
         "img-bolt-m11.png", "art-bolt-m11.png", 1.0),
        ("oid-bolt", "Lightning Bolt", "lightning bolt", "2x2", "Double Masters 2022", "117",
         "2022-07-08", "2015", [], "black", False, False, False, [], False, "en", "normal",
         "img-bolt-2x2.png", "art-bolt-2x2.png", 0.5),
        # Tarmogoyf: only 2003 + 2015 + future (Future Sight printing)
        ("oid-goyf", "Tarmogoyf", "tarmogoyf", "fut", "Future Sight", "153",
         "2007-05-04", "future", [], "black", False, False, False, [], False, "en", "normal",
         "img-goyf-fut.png", "art-goyf-fut.png", 60.0),
        ("oid-goyf", "Tarmogoyf", "tarmogoyf", "mm2", "Modern Masters 2015", "151",
         "2015-05-22", "2015", [], "black", False, False, False, [], False, "en", "normal",
         "img-goyf-mm2.png", "art-goyf-mm2.png", 30.0),
        # Counterspell: showcase variant exists
        ("oid-cs", "Counterspell", "counterspell", "lea", "Alpha", "54",
         "1993-08-05", "1993", [], "black", False, False, False, [], False, "en", "normal",
         "img-cs-lea.png", "art-cs-lea.png", 800.0),
        ("oid-cs", "Counterspell", "counterspell", "mh2", "Modern Horizons 2", "267",
         "2021-06-18", "2015", ["showcase"], "black", False, False, False, [], False, "en", "normal",
         "img-cs-mh2.png", "art-cs-mh2.png", 2.5),
    ]
    c.executemany(
        """INSERT INTO printings VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, true, false
        )""",
        rows,
    )
    c.execute(
        "CREATE TABLE cards AS SELECT oracle_id, ANY_VALUE(name) AS name, "
        "ANY_VALUE(name_normalized) AS name_normalized FROM printings GROUP BY oracle_id;"
    )
    db.set_meta("scryfall_updated_at", "test-version")
    yield


def _aes(yaml_dict):
    return compile_aesthetic(yaml_dict)


def test_future_sight_only_tarmogoyf():
    aes = [
        _aes({"id": "future", "label": "Future Sight", "match": {"equals": {"frame": "future"}}}),
        _aes({"id": "showcase", "label": "Showcase", "match": {"contains": {"frame_effects": "showcase"}}}),
    ]
    entries = [
        DecklistEntry(name="Lightning Bolt", qty=4, section="mainboard"),
        DecklistEntry(name="Tarmogoyf", qty=4, section="mainboard"),
        DecklistEntry(name="Counterspell", qty=4, section="mainboard"),
    ]
    result = analyze_mod.analyze(entries, aes)
    by_id = {r["aesthetic_id"]: r for r in result["summary"]}
    assert by_id["future"]["available_unique"] == 1  # only Tarmogoyf
    assert by_id["future"]["available_qty"] == 4
    assert by_id["showcase"]["available_unique"] == 1  # only Counterspell
    assert by_id["showcase"]["available_qty"] == 4


def test_unresolved_card_warned():
    aes = [_aes({"id": "x", "label": "X", "match": {"equals": {"frame": "future"}}})]
    entries = [DecklistEntry(name="Not A Real Card", qty=1, section="mainboard")]
    result = analyze_mod.analyze(entries, aes)
    assert result["totals"]["unresolved"] == 1
    assert result["warnings"]


def test_basics_excluded_by_default():
    aes = [_aes({"id": "x", "label": "X", "match": {"equals": {"frame": "1993"}}})]
    entries = [
        DecklistEntry(name="Lightning Bolt", qty=4, section="mainboard"),
        DecklistEntry(name="Mountain", qty=20, section="mainboard"),
    ]
    result = analyze_mod.analyze(entries, aes, include_basics=False)
    assert result["totals"]["unique_cards"] == 1
    assert result["totals"]["total_qty"] == 4


def test_borderless_predicate_matches_inverted_borderless_printing():
    """Regression: a printing that is BOTH borderless (border_color) AND has
    'inverted' in frame_effects must satisfy both the `borderless` and
    `inverted` aesthetic predicates simultaneously. Previously the user
    reported borderless+inverted cards being missed when only the Borderless
    spotlight was selected."""
    c = db.conn()
    # Insert a Boseiju-style printing: borderless border + inverted frame.
    c.execute(
        """INSERT INTO printings VALUES (
            'oid-boseiju', 'Boseiju, Who Endures', 'boseiju, who endures',
            'neo', 'Kamigawa: Neon Dynasty', '412',
            DATE '2022-02-18', '2015', ['legendary', 'inverted'],
            'borderless', false, false, false, [], false, 'en', 'normal',
            'img-bos.png', 'art-bos.png', 50.0,
            NULL, NULL,
            true, false
        );"""
    )
    c.execute(
        "INSERT INTO cards VALUES ('oid-boseiju', 'Boseiju, Who Endures', 'boseiju, who endures');"
    )
    aes = [
        _aes({
            "id": "borderless", "label": "Borderless",
            "match": {"any": [
                {"equals": {"border_color": "borderless"}},
                {"contains": {"frame_effects": "borderless"}},
            ]},
        }),
        _aes({
            "id": "inverted", "label": "Inverted Frame",
            "match": {"contains": {"frame_effects": "inverted"}},
        }),
    ]
    entries = [DecklistEntry(name="Boseiju, Who Endures", qty=1, section="mainboard")]
    result = analyze_mod.analyze(entries, aes)
    bos = next(c for c in result["per_card"] if c["name_normalized"] == "boseiju, who endures")
    assert "borderless" in bos["available_aesthetics"], (
        "borderless+inverted printing must be tagged with borderless"
    )
    assert "inverted" in bos["available_aesthetics"], (
        "borderless+inverted printing must be tagged with inverted"
    )
    # Also confirm the example printing for borderless is the same record
    # (set/cn match), not a fallback or empty.
    assert bos["examples"]["borderless"]["set"] == "neo"
    assert bos["examples"]["borderless"]["collector_number"] == "412"
