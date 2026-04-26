"""Runtime configuration sourced from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


@dataclass(frozen=True)
class Settings:
    port: int
    data_dir: Path
    rulesets_dir: Path
    static_dir: Path
    scryfall_refresh_hours: int
    scryfall_refresh_cron: str
    scryfall_bulk_type: str
    user_agent: str
    admin_token: str | None
    log_level: str
    auto_refresh_on_startup: bool

    @property
    def db_path(self) -> Path:
        return self.data_dir / "deckaesthetics.duckdb"

    @property
    def bulk_cache_path(self) -> Path:
        return self.data_dir / f"{self.scryfall_bulk_type}.json"


def load_settings() -> Settings:
    repo_root = Path(__file__).resolve().parents[2]
    data_dir = Path(os.getenv("DATA_DIR", str(repo_root / "data")))
    rulesets_dir = Path(os.getenv("RULESETS_DIR", str(repo_root / "rulesets")))
    static_dir = Path(os.getenv("STATIC_DIR", str(repo_root / "frontend" / "dist")))

    data_dir.mkdir(parents=True, exist_ok=True)

    return Settings(
        port=_env_int("PORT", 8080),
        data_dir=data_dir,
        rulesets_dir=rulesets_dir,
        static_dir=static_dir,
        scryfall_refresh_hours=_env_int("SCRYFALL_REFRESH_HOURS", 24),
        # Cron expression (UTC) for refresh checks. When set, takes precedence
        # over scryfall_refresh_hours. Default fires hourly at :15 from 09:00
        # to 13:00 UTC — a window around Scryfall's typical ~09:00 UTC daily
        # bulk update. Each check is a single tiny HTTP request to the bulk
        # index; only the first check that sees a new updated_at downloads.
        scryfall_refresh_cron=os.getenv(
            "SCRYFALL_REFRESH_CRON", "15 9-13 * * *"
        ),
        scryfall_bulk_type=os.getenv("SCRYFALL_BULK_TYPE", "default_cards"),
        user_agent=os.getenv(
            "SCRYFALL_USER_AGENT",
            "Frameworks/0.1 (+https://github.com/local/deckaesthetics)",
        ),
        admin_token=os.getenv("ADMIN_TOKEN") or None,
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        auto_refresh_on_startup=_env_bool("AUTO_REFRESH_ON_STARTUP", True),
    )


settings = load_settings()
