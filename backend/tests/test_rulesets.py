import pytest

from app.rulesets import compile_aesthetic, RulesetError


def test_equals_compiles():
    a = compile_aesthetic({"id": "x", "label": "X", "match": {"equals": {"frame": "future"}}})
    assert a.sql_where == '"frame" = ?'
    assert a.params == ("future",)


def test_in_compiles():
    a = compile_aesthetic({
        "id": "x", "label": "X",
        "match": {"in": {"frame": ["1993", "1997"]}},
    })
    assert a.sql_where == '"frame" IN (?, ?)'
    assert a.params == ("1993", "1997")


def test_contains_list_field():
    a = compile_aesthetic({
        "id": "x", "label": "X",
        "match": {"contains": {"frame_effects": "showcase"}},
    })
    assert "list_contains" in a.sql_where
    assert a.params == ("showcase",)


def test_contains_rejects_scalar_field():
    with pytest.raises(RulesetError):
        compile_aesthetic({
            "id": "x", "label": "X",
            "match": {"contains": {"frame": "future"}},
        })


def test_and_or_not_compose():
    a = compile_aesthetic({
        "id": "x", "label": "X",
        "match": {
            "all": [
                {"equals": {"frame": "2015"}},
                {"any": [
                    {"contains": {"frame_effects": "showcase"}},
                    {"not": {"equals": {"border_color": "black"}}},
                ]},
            ]
        },
    })
    assert "AND" in a.sql_where and "OR" in a.sql_where and "NOT" in a.sql_where


def test_unknown_field_rejected():
    with pytest.raises(RulesetError):
        compile_aesthetic({"id": "x", "label": "X", "match": {"equals": {"power": "3"}}})


def test_raw_rejects_semicolon():
    with pytest.raises(RulesetError):
        compile_aesthetic({"id": "x", "label": "X", "match": {"raw": "1=1; DROP TABLE"}})
