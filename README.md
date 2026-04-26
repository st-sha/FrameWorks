# Frameworks

A self-hosted web app that takes a Magic: The Gathering decklist (in any common format)
and shows, per **aesthetic** (frame era, border, treatment, promo type, ...), how many
cards in the deck have at least one printing matching that aesthetic.

Built for Unraid: a single Docker container, a single mounted volume, and a snappy UI.

## What it does

1. You paste a decklist (plain text / MTGA / MTGO `.dek` / `SB:` prefix / blank-line split)
   **or** a Moxfield / Archidekt / Melee.gg URL.
2. The backend looks each card up in a locally-cached Scryfall bulk dataset
   (downloaded on first run, then refreshed every 6 hours by default).
3. The UI shows two views you can toggle between:
   - **Matrix** — one row per aesthetic with `available / total` cards, copies, and a
     coverage bar. Click a row for a per-card breakdown.
   - **Per-card** — virtualized list of every card in the deck with chips lit for each
     aesthetic that card has a printing in. Hover a chip for a card image.

Aesthetics are defined in YAML files under `rulesets/` so adding a new one
(e.g. "Anime Showcase") is a config edit, not a code change.

## Quick start (Docker)

```bash
docker compose up --build
```

Then open http://localhost:8080. First boot downloads ~300 MB of Scryfall data; the
UI shows progress and starts working as soon as ingestion completes.

## Quick start (Unraid)

1. Build the image somewhere with `docker buildx` and push to your private registry,
   **or** drop the repo on your server and run `docker compose up -d --build`.
2. In Unraid: **Docker → Add Container → Template URL** → point at the XML in
   `unraid/deckaesthetics.xml` (or paste its contents into a new template).
3. Default volume mapping: `/mnt/user/appdata/deckaesthetics → /data`.

## Environment variables

| Variable                   | Default                | Description                                                  |
| -------------------------- | ---------------------- | ------------------------------------------------------------ |
| `PORT`                     | `8080`                 | HTTP port the server listens on                              |
| `DATA_DIR`                 | `/data`                | Where DuckDB and the Scryfall JSON cache live                |
| `RULESETS_DIR`             | `/app/rulesets`        | Directory of `*.yaml` aesthetic definitions                  |
| `SCRYFALL_REFRESH_HOURS`   | `6`                    | Background refresh cadence                                   |
| `SCRYFALL_BULK_TYPE`       | `default_cards`        | `default_cards` (recommended) or `all_cards`                 |
| `AUTO_REFRESH_ON_STARTUP`  | `true`                 | Trigger a refresh in the background at startup               |
| `ADMIN_TOKEN`              | _(unset)_              | If set, `/api/admin/*` endpoints require `X-Admin-Token`    |
| `LOG_LEVEL`                | `INFO`                 | Standard Python log level                                    |

## API

| Method | Path                          | Notes                                              |
| ------ | ----------------------------- | -------------------------------------------------- |
| GET    | `/api/health`                 | Status, data version, refresh age                  |
| GET    | `/api/aesthetics`             | List of loaded aesthetics                          |
| GET    | `/api/importers`              | Registered URL importers + their hosts             |
| POST   | `/api/decklist/parse`         | Parse text or fetch a URL → normalized entries     |
| POST   | `/api/analyze`                | Run the full analysis                              |
| POST   | `/api/admin/refresh`          | Force a Scryfall refresh                           |
| POST   | `/api/admin/reload-rulesets`  | Re-read YAMLs from `RULESETS_DIR`                  |

Interactive docs at `/docs`.

## Adding a custom aesthetic

Drop a file like `rulesets/mine.yaml`:

```yaml
aesthetics:
  - id: my_anime_showcase
    label: "Anime Showcase"
    group: "Treatment"
    description: "Anime-style alt art (e.g. NEO showcase)."
    match:
      all:
        - contains: { frame_effects: "showcase" }
        - in: { set: ["neo", "snc"] }
```

Then either restart the container or call:

```bash
curl -X POST http://localhost:8080/api/admin/reload-rulesets \
     -H "X-Admin-Token: $TOKEN"
```

### Predicate operators

- `equals: { field: value }`
- `in: { field: [v1, v2, ...] }`
- `contains: { list_field: value }` — for `frame_effects`, `promo_types`
- `not: <predicate>`
- `all: [<predicate>, ...]` — AND
- `any: [<predicate>, ...]` — OR
- `raw: "<sql expression>"` — escape hatch (no `;` allowed)

Scalar fields: `frame`, `border_color`, `layout`, `lang`, `set`, `set_name`,
`collector_number`, `full_art`, `textless`, `promo`, `digital`.
List fields: `frame_effects`, `promo_types`.

## Adding a new URL importer

Add a file under `backend/app/parsers/importers/` exposing a class with `name`,
`hosts`, and a `fetch(url) -> ParseResult` method, and call `register(YourImporter())`
at module scope. Then import it from `importers/__init__.py`. See `moxfield.py` as a
template.

## Development

```bash
# Backend
python -m venv .venv
.venv\Scripts\activate            # PowerShell: .\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
uvicorn backend.app.main:app --reload --port 8080

# Frontend
cd frontend
npm install
npm run dev                       # http://localhost:5173, proxies /api → :8080

# Tests
pytest -q
```

## Notes & limitations

- **Basic lands** are excluded from the analysis by default (a single basic has
  thousands of printings and would dominate every aesthetic). Toggle in the UI.
- **Melee.gg** has no public API — the importer scrapes their HTML. If their layout
  changes, the UI will surface a clear "paste raw decklist instead" error.
- The first run downloads ~300 MB of card data. Subsequent boots are instant if
  Scryfall hasn't published new bulk data.
