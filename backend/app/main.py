"""FastAPI application: API + static frontend."""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import analyze as analyze_mod
from . import db, scryfall
from .config import settings
from .parsers import import_from_url, list_importers, parse_text
from .parsers.text import DecklistEntry
from .rulesets import Aesthetic, RulesetError, filter_by_ids, load_rulesets

log = logging.getLogger(__name__)

# In-memory state shared across requests.
_state: dict = {
    "aesthetics": [],
    "scheduler": None,
    "last_refresh_attempt": None,
    "last_refresh_status": None,
}


def _setup_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def _do_refresh(force: bool = False) -> dict:
    _state["last_refresh_attempt"] = datetime.now(timezone.utc).isoformat()
    try:
        status = scryfall.refresh(settings, force=force)
        analyze_mod.clear_cache()
        _state["last_refresh_status"] = status
        return status
    except Exception as e:  # pragma: no cover
        log.exception("Scryfall refresh failed")
        err = {"status": "error", "error": str(e)}
        _state["last_refresh_status"] = err
        return err


@asynccontextmanager
async def lifespan(app: FastAPI):
    _setup_logging()
    db.init(settings.db_path)

    try:
        _state["aesthetics"] = load_rulesets(settings.rulesets_dir)
        log.info("Loaded %d aesthetics total", len(_state["aesthetics"]))
    except RulesetError as e:
        log.error("Failed to load rulesets: %s", e)
        _state["aesthetics"] = []

    if settings.auto_refresh_on_startup:
        # Decide whether we need to refresh now: no data, or stale beyond cadence.
        last = db.get_meta("scryfall_updated_at")
        needs_initial = last is None
        if needs_initial:
            log.info("No Scryfall data cached; triggering initial download in background")
        # Run on a thread so startup doesn't block.
        import threading
        threading.Thread(target=_do_refresh, daemon=True, name="initial-refresh").start()

    sched = BackgroundScheduler(daemon=True, timezone="UTC")
    cron_expr = (settings.scryfall_refresh_cron or "").strip()
    if cron_expr:
        try:
            trigger = CronTrigger.from_crontab(cron_expr, timezone="UTC")
            schedule_desc = f"cron '{cron_expr}' UTC"
        except ValueError as e:
            log.error(
                "Invalid SCRYFALL_REFRESH_CRON %r (%s); falling back to interval",
                cron_expr,
                e,
            )
            trigger = IntervalTrigger(hours=max(1, settings.scryfall_refresh_hours))
            schedule_desc = f"every {settings.scryfall_refresh_hours} h"
    else:
        trigger = IntervalTrigger(hours=max(1, settings.scryfall_refresh_hours))
        schedule_desc = f"every {settings.scryfall_refresh_hours} h"

    sched.add_job(
        _do_refresh,
        trigger,
        id="scryfall_refresh",
        replace_existing=True,
    )
    sched.start()
    _state["scheduler"] = sched
    log.info("Scheduler started; refresh %s", schedule_desc)

    try:
        yield
    finally:
        sched.shutdown(wait=False)


app = FastAPI(title="Frameworks", version="0.1.1", lifespan=lifespan)


# ----------------------------- Schemas -----------------------------
class DecklistInput(BaseModel):
    text: str | None = None
    url: str | None = None
    entries: list[dict] | None = None  # raw [{name, qty, section?}]


class AnalyzeRequest(BaseModel):
    decklist: DecklistInput
    aesthetic_ids: list[str] | None = None
    include_sideboard: bool = True
    include_basics: bool = False
    # When False, exclude printings that aren't tournament legal in any
    # standard paper format: gold-border WC reprints, silver-border /
    # acorn un-set cards, 30th Anniversary Edition, joke / memorabilia
    # sets, etc. Default True preserves the legacy "show everything"
    # behavior; the left-nav toggle flips it to False for tournament prep.
    allow_non_tournament: bool = True
    # When False, exclude digital-only printings (MTGA, MTGO, Alchemy,
    # Arena Direct, etc.). Default False because the typical user is
    # working with a physical-card collection; opt-in via the Settings
    # page when working with a digital deck.
    allow_digital: bool = False
    # Per-set kill switch. Set codes listed here are dropped from the
    # printing pool entirely (more granular than the blanket toggle above).
    disabled_sets: list[str] = []
    # Format-specific tournament filter. When set to a known format id
    # (e.g. 'standard', 'modern', 'commander'), the printing pool is
    # restricted to printings legal in that format (legal/restricted;
    # banned cards are excluded). When None, no per-format filter is
    # applied; the broader `allow_non_tournament` toggle still governs.
    format: str | None = None
    # Ordered list of printing-preference keys (highest priority first).
    # Backwards-compatible: a bare string is also accepted.
    printing_strategy: list[str] | str | None = None


class ImportRequest(BaseModel):
    url: str = Field(..., min_length=1)


class PrintingsRequest(BaseModel):
    """Lookup all printings of a card (optionally constrained to one
    aesthetic), ordered by the same preference fragments analyze() uses."""
    name: str | None = None
    oracle_id: str | None = None
    aesthetic_id: str | None = None
    printing_strategy: list[str] | str | None = None
    # Mirror AnalyzeRequest's legality filters so the Coverage drawer's
    # "matching versions" list respects whatever the user has toggled.
    allow_non_tournament: bool = True
    allow_digital: bool = False
    disabled_sets: list[str] = []
    format: str | None = None
    limit: int = 24


# --------------------------- Helpers --------------------------------
# Hard upper bound on a single decklist payload. ~5x the size of the
# largest legitimate format (Commander = 100 unique cards) leaves room
# for cubes / collection lists while preventing accidental or malicious
# memory/CPU exhaustion via a giant POST body.
_MAX_DECKLIST_ENTRIES = 2000
_MAX_CARD_NAME_LEN = 200


def _enforce_decklist_limits(entries: list[DecklistEntry]) -> list[DecklistEntry]:
    if len(entries) > _MAX_DECKLIST_ENTRIES:
        raise HTTPException(
            400,
            f"Decklist too large: {len(entries)} entries (max {_MAX_DECKLIST_ENTRIES}).",
        )
    for e in entries:
        if len(e.name) > _MAX_CARD_NAME_LEN:
            raise HTTPException(
                400,
                f"Card name too long ({len(e.name)} chars; max {_MAX_CARD_NAME_LEN}).",
            )
    return entries


def _entries_from_input(d: DecklistInput) -> tuple[list[DecklistEntry], list[str]]:
    if d.entries:
        if len(d.entries) > _MAX_DECKLIST_ENTRIES:
            raise HTTPException(
                400,
                f"Decklist too large: {len(d.entries)} entries (max {_MAX_DECKLIST_ENTRIES}).",
            )
        built = [
            DecklistEntry(
                name=e["name"],
                qty=int(e.get("qty", 1)),
                section=e.get("section", "mainboard"),  # type: ignore[arg-type]
            )
            for e in d.entries
            if e.get("name")
        ]
        return _enforce_decklist_limits(built), []
    if d.url:
        try:
            result = import_from_url(d.url)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        except Exception as e:
            log.exception("URL import failed for %s", d.url)
            raise HTTPException(502, f"Importer failed: {e}") from e
        return _enforce_decklist_limits(result.entries), result.warnings
    if d.text:
        result = parse_text(d.text)
        return _enforce_decklist_limits(result.entries), result.warnings
    raise HTTPException(400, "decklist.text, decklist.url, or decklist.entries required")


_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _require_admin(
    request: Request,
    x_admin_token: str | None = Header(default=None),
) -> None:
    # If no token is configured, only accept requests from loopback so a
    # default deployment exposed on 0.0.0.0 can't be hijacked. This
    # preserves the dev-time "just hit the endpoint" UX while closing the
    # accidental-exposure footgun.
    if settings.admin_token is None:
        client_host = request.client.host if request.client else None
        if client_host in _LOOPBACK_HOSTS:
            return
        raise HTTPException(403, "Admin endpoint requires ADMIN_TOKEN for non-loopback access")
    if x_admin_token != settings.admin_token:
        raise HTTPException(403, "Invalid admin token")


# ----------------------------- API ----------------------------------
@app.get("/api/health")
def health() -> dict:
    last = db.get_meta("scryfall_updated_at")
    age = None
    if last:
        try:
            ts = datetime.fromisoformat(last.replace("Z", "+00:00"))
            age = int((datetime.now(timezone.utc) - ts).total_seconds())
        except ValueError:
            age = None
    return {
        "status": "ok" if last else "initializing",
        "data_version": last,
        "refresh_age_seconds": age,
        "last_refresh_attempt": _state["last_refresh_attempt"],
        "last_refresh_status": _state["last_refresh_status"],
        "aesthetics_loaded": len(_state["aesthetics"]),
        "version": app.version,
    }


@app.get("/api/aesthetics")
def get_aesthetics() -> dict:
    aes = _state["aesthetics"]
    return {
        "aesthetics": [
            {
                "id": a.id,
                "label": a.label,
                "description": a.description,
                "group": a.group,
                "icon": a.icon,
            }
            for a in aes
        ]
    }


@app.get("/api/importers")
def get_importers() -> dict:
    return {"importers": list_importers()}


@app.get("/api/sets")
def get_sets() -> dict:
    """Set-code → icon SVG URI map. The frontend uses this to render the
    correct symbol per printing — some sets (h2r, plst, etc.) reuse a
    parent set's icon and the bare `/sets/{code}.svg` URL is a 404."""
    try:
        with db.read_lock() as c:
            rows = c.execute(
                "SELECT code, icon_svg_uri FROM sets WHERE icon_svg_uri IS NOT NULL"
            ).fetchall()
    except Exception:
        # Table may not exist yet on a fresh DB before refresh.
        rows = []
    return {"sets": {code: uri for code, uri in rows}}


@app.get("/api/sets/list")
def list_sets() -> dict:
    """Enriched set list for the Settings page. Returns one row per set
    with `set_type`, earliest release date, printing count, an
    `is_tournament_legal` flag derived from the same predicate analyze()
    uses, and the icon URI. Sourced from the `printings` table directly
    so we don't depend on the `sets` table being populated.

    The frontend Settings page groups by `set_type` and lets the user
    toggle individual sets on / off."""
    try:
        with db.read_lock() as c:
            # Aggregate from printings so we get accurate per-set card
            # counts. LEFT JOIN to the sets table for icon/name fallback.
            rows = c.execute(
                """
                SELECT
                    p."set"                       AS code,
                    COALESCE(s.name, MAX(p.set_name)) AS name,
                    MAX(p.set_type)               AS set_type,
                    MAX(p.border_color)           AS border_color,
                    MIN(p.released_at)            AS released_at,
                    COUNT(*)                      AS printing_count,
                    COUNT(DISTINCT p.oracle_id)   AS unique_card_count,
                    s.icon_svg_uri                AS icon,
                    -- A set is digital iff every printing in it is digital.
                    -- Mixed sets (rare; e.g. Arena re-prints later released
                    -- in paper) keep is_digital = false so they aren't
                    -- accidentally hidden by the paper-only default.
                    BOOL_AND(p.digital)           AS is_digital,
                    -- A set is tournament-legal iff at least one printing
                    -- in it is legal in any standard paper format. Lets a
                    -- set with mostly non-legal cards but one black-border
                    -- reprint still surface as legal.
                    BOOL_OR(COALESCE(p.tournament_legal, true)) AS any_legal
                FROM printings p
                LEFT JOIN sets s ON s.code = p."set"
                WHERE p."set" IS NOT NULL
                GROUP BY p."set", s.name, s.icon_svg_uri
                ORDER BY MIN(p.released_at) DESC NULLS LAST, p."set"
                """
            ).fetchall()
    except Exception:
        rows = []
    out = []
    for code, name, set_type, border_color, released_at, pc, ucc, icon, is_digital, any_legal in rows:
        # Use the per-set roll-up from Scryfall's `legalities` data when
        # available; falls back to the coarse border/set_type heuristic
        # if the column is null (e.g. fresh DB before refresh).
        if any_legal is not None:
            legal = bool(any_legal)
        else:
            legal = (
                border_color not in {"silver", "gold"}
                and set_type not in {"funny", "memorabilia"}
                and code not in {"30a", "30c"}
            )
        out.append({
            "code": code,
            "name": name or code.upper(),
            "set_type": set_type,
            "released_at": released_at.isoformat() if released_at else None,
            "printing_count": int(pc),
            "unique_card_count": int(ucc),
            "icon": icon,
            "is_tournament_legal": legal,
            "is_digital": bool(is_digital),
        })
    return {"sets": out}


@app.post("/api/decklist/parse")
def parse_decklist(payload: DecklistInput) -> dict:
    entries, warnings = _entries_from_input(payload)
    return {
        "entries": [
            {
                "name": e.name,
                "qty": e.qty,
                "section": e.section,
                "set_code": e.set_code,
                "collector_number": e.collector_number,
            }
            for e in entries
        ],
        "warnings": warnings,
    }


@app.post("/api/analyze")
def analyze_endpoint(req: AnalyzeRequest) -> dict:
    if not _state["aesthetics"]:
        raise HTTPException(503, "No aesthetics loaded")
    if not db.get_meta("scryfall_updated_at"):
        raise HTTPException(503, "Card data not yet available; please retry shortly")

    entries, parse_warnings = _entries_from_input(req.decklist)
    # Always analyze against ALL loaded aesthetics so the frontend can
    # filter / cross-filter / re-summarize instantly without round-trips.
    # `req.aesthetic_ids` is accepted but currently ignored for that reason.
    aesthetics: list[Aesthetic] = list(_state["aesthetics"])

    t0 = time.perf_counter()
    result = analyze_mod.analyze_cached(
        entries, aesthetics, req.include_sideboard, req.include_basics,
        req.printing_strategy, req.allow_non_tournament, req.disabled_sets,
        req.allow_digital, req.format,
    )
    elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)

    if parse_warnings:
        result = {**result, "warnings": parse_warnings + result.get("warnings", [])}
    result["elapsed_ms"] = elapsed_ms
    return result


@app.post("/api/printings")
def list_printings(req: PrintingsRequest) -> dict:
    """Return the full ordered list of printings of one card.

    Used by the Gallery hover UI to show "all matching printings, ranked
    by current preferences." Resolution: by oracle_id when given, otherwise
    by normalized card name.
    """
    if not db.get_meta("scryfall_updated_at"):
        raise HTTPException(503, "Card data not yet available; please retry shortly")

    oracle_id = req.oracle_id
    if not oracle_id:
        if not req.name:
            raise HTTPException(400, "Either oracle_id or name is required")
        n = db.normalize_name(req.name)
        with db.read_lock() as c:
            row = c.execute(
                "SELECT oracle_id FROM cards WHERE name_normalized = ? LIMIT 1",
                [n],
            ).fetchone()
            if not row:
                row = c.execute(
                    "SELECT oracle_id FROM cards WHERE name_normalized LIKE ? LIMIT 1",
                    [f"{n} // %"],
                ).fetchone()
        if not row:
            raise HTTPException(404, f"Unknown card: {req.name!r}")
        oracle_id = row[0]

    # Aesthetic predicate filtering is done in Python below using the
    # compiled `match_py`. We deliberately do NOT apply `ae.sql_where`
    # here because DuckDB's NULL semantics diverge from Python for `NOT`
    # / `contains` predicates: e.g. `list_contains(NULL, 'x')` returns
    # NULL → `NOT NULL` is NULL → row excluded by WHERE; whereas the
    # Python evaluator treats a missing list as empty so `NOT (x in [])`
    # is True → row included. Coverage counts use the Python evaluator,
    # so we mirror it here to keep the two views in lockstep.
    ae = None
    if req.aesthetic_id:
        ae = next((a for a in _state["aesthetics"] if a.id == req.aesthetic_id), None)
        if ae is None:
            raise HTTPException(404, f"Unknown aesthetic: {req.aesthetic_id!r}")

    order_by = analyze_mod._order_clause(req.printing_strategy)
    limit = max(1, min(500, int(req.limit or 24)))
    disabled_set_codes = set(req.disabled_sets or [])
    # Pull ALL printings of this oracle, sorted by the user's strategy.
    # We then apply the (Python) aesthetic predicate and slice to `limit`.
    # Worst case: ~hundreds of printings for popular oracles — trivial.
    sql = f"""
        SELECT "set", set_name, collector_number,
               image_normal, image_art_crop,
               border_color, frame, lang, digital, full_art, textless,
               promo, promo_types, frame_effects, security_stamp, set_type,
               released_at, price_usd, tournament_legal,
               legal_standard, legal_pioneer, legal_modern, legal_legacy,
               legal_vintage, legal_commander, legal_pauper
        FROM printings
        WHERE oracle_id = ?
          AND image_normal IS NOT NULL
        ORDER BY {order_by}
    """
    with db.read_lock() as c:
        rows = c.execute(sql, [oracle_id]).fetchall()
    out = []
    # First pass: apply filters strictly. Track each printing dict so we
    # can rescue them in the fallback pass if the strict pass leaves no
    # printings (e.g. the card has only silver-border Unhinged versions
    # and the user has the non-tournament toggle off — they should still
    # see the card with its overlay rather than an empty list).
    all_built: list[dict] = []
    for (set_code, set_name, cn, img, art, border, frame, lang, digital,
         full_art, textless, promo, promo_types, frame_effects,
         sec_stamp, set_type, released, price, tournament_legal,
         legal_standard, legal_pioneer, legal_modern, legal_legacy,
         legal_vintage, legal_commander, legal_pauper) in rows:
        p = {
            "set": set_code,
            "set_name": set_name,
            "collector_number": cn,
            "image_normal": img,
            "image_art_crop": art,
            "border_color": border,
            "frame": frame,
            "lang": lang,
            "digital": digital,
            "full_art": full_art,
            "textless": textless,
            "promo": promo,
            "promo_types": list(promo_types) if promo_types else [],
            "frame_effects": list(frame_effects) if frame_effects else [],
            "security_stamp": sec_stamp,
            "set_type": set_type,
            "released_at": released.isoformat() if released else None,
            "price_usd": price,
            "tournament_legal": tournament_legal,
            "legal_standard": legal_standard,
            "legal_pioneer": legal_pioneer,
            "legal_modern": legal_modern,
            "legal_legacy": legal_legacy,
            "legal_vintage": legal_vintage,
            "legal_commander": legal_commander,
            "legal_pauper": legal_pauper,
        }
        if ae is not None and ae.match_py is not None and not ae.match_py(p):
            continue
        all_built.append(p)
        if p["set"] in disabled_set_codes:
            continue
        if not req.allow_non_tournament and not analyze_mod._is_tournament_legal(p):
            continue
        if not analyze_mod._printing_legal_in_format(p, req.format):
            continue
        if not req.allow_digital and p.get("digital"):
            continue
        # Tag each row with its tournament-legality so the frontend can
        # paint a warning overlay on the non-legal printings that the
        # user has opted to allow.
        p["is_tournament_legal"] = analyze_mod._is_tournament_legal(p)
        out.append(p)
        if len(out) >= limit:
            break
    # Graceful fallback: if the strict filters wiped out every printing
    # of this aesthetic, fall back to the unfiltered (but predicate-
    # matching) pool so the user still sees something. Mirrors the same
    # fallback in analyze.analyze().
    if not out and all_built:
        for p in all_built:
            if p["set"] in disabled_set_codes:
                continue
            p["is_tournament_legal"] = analyze_mod._is_tournament_legal(p)
            out.append(p)
            if len(out) >= limit:
                break
    return {"oracle_id": oracle_id, "printings": out}


@app.post("/api/admin/refresh", dependencies=[Depends(_require_admin)])
def admin_refresh(force: bool = True) -> dict:
    return _do_refresh(force=force)


@app.post("/api/admin/reload-rulesets", dependencies=[Depends(_require_admin)])
def admin_reload_rulesets() -> dict:
    try:
        _state["aesthetics"] = load_rulesets(settings.rulesets_dir)
    except RulesetError as e:
        raise HTTPException(400, f"Ruleset error: {e}") from e
    analyze_mod.clear_cache()
    return {"status": "ok", "count": len(_state["aesthetics"])}


# --------------------------- Static / SPA ----------------------------
if settings.static_dir.exists():
    app.mount(
        "/assets",
        StaticFiles(directory=settings.static_dir / "assets"),
        name="assets",
    )

    _STATIC_ROOT = settings.static_dir.resolve()

    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str, request: Request):
        # Don't intercept API
        if full_path.startswith("api/"):
            raise HTTPException(404)
        index = settings.static_dir / "index.html"
        if full_path:
            try:
                candidate = (settings.static_dir / full_path).resolve()
            except (OSError, ValueError):
                candidate = None
            # Reject any path that escapes the static root after
            # symlink/`..` resolution.
            if candidate is not None and candidate.is_file():
                try:
                    candidate.relative_to(_STATIC_ROOT)
                except ValueError:
                    raise HTTPException(404)
                return FileResponse(candidate)
        if index.exists():
            return FileResponse(index)
        return JSONResponse({"detail": "frontend not built"}, status_code=404)
else:
    @app.get("/")
    def root_no_static() -> dict:
        return {
            "service": "deckaesthetics",
            "frontend": "not built; run `npm run build` in frontend/ or use the Docker image",
            "api_docs": "/docs",
        }
