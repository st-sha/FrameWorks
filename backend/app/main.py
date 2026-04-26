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


app = FastAPI(title="Frameworks", version="0.1.0", lifespan=lifespan)


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
    limit: int = 24


# --------------------------- Helpers --------------------------------
def _entries_from_input(d: DecklistInput) -> tuple[list[DecklistEntry], list[str]]:
    if d.entries:
        return (
            [
                DecklistEntry(
                    name=e["name"],
                    qty=int(e.get("qty", 1)),
                    section=e.get("section", "mainboard"),  # type: ignore[arg-type]
                )
                for e in d.entries
                if e.get("name")
            ],
            [],
        )
    if d.url:
        try:
            result = import_from_url(d.url)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        except Exception as e:
            log.exception("URL import failed for %s", d.url)
            raise HTTPException(502, f"Importer failed: {e}") from e
        return result.entries, result.warnings
    if d.text:
        result = parse_text(d.text)
        return result.entries, result.warnings
    raise HTTPException(400, "decklist.text, decklist.url, or decklist.entries required")


def _require_admin(x_admin_token: str | None = Header(default=None)) -> None:
    if settings.admin_token is None:
        return
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
        entries, aesthetics, req.include_sideboard, req.include_basics, req.printing_strategy
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

    where_extra = ""
    extra_params: list = []
    if req.aesthetic_id:
        ae = next((a for a in _state["aesthetics"] if a.id == req.aesthetic_id), None)
        if ae is None:
            raise HTTPException(404, f"Unknown aesthetic: {req.aesthetic_id!r}")
        where_extra = f" AND ({ae.sql_where})"
        extra_params = list(ae.params)

    order_by = analyze_mod._order_clause(req.printing_strategy)
    limit = max(1, min(200, int(req.limit or 24)))
    sql = f"""
        SELECT "set", set_name, collector_number,
               image_normal, image_art_crop,
               border_color, frame, lang, digital, full_art, textless,
               promo, promo_types, frame_effects, security_stamp, set_type,
               released_at, price_usd
        FROM printings
        WHERE oracle_id = ?
          AND image_normal IS NOT NULL
          {where_extra}
        ORDER BY {order_by}
        LIMIT {limit}
    """
    params = [oracle_id] + extra_params
    with db.read_lock() as c:
        rows = c.execute(sql, params).fetchall()
    out = []
    for (set_code, set_name, cn, img, art, border, frame, lang, digital,
         full_art, textless, promo, promo_types, frame_effects,
         sec_stamp, set_type, released, price) in rows:
        out.append({
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
        })
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

    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str, request: Request):
        # Don't intercept API
        if full_path.startswith("api/"):
            raise HTTPException(404)
        candidate = settings.static_dir / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        index = settings.static_dir / "index.html"
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
