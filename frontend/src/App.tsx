import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import {
  chipToggleCounts,
  filterCards,
  groupAesthetics,
  resolveCardSize,
  useStore,
  viewSupportsSpotlight,
} from './store';
import { groupClass } from './views/insightsUtil';
import { GalleryView } from './views/Gallery';
import { PerCardView } from './views/PerCard';
import { ArtGridView } from './views/ArtGrid';
import { FunnelView } from './views/Funnel';
import { OutliersView } from './views/Outliers';
import { TimelineView } from './views/Timeline';
import { CompareView } from './views/Compare';
import { Drawer } from './views/Drawer';
import { SettingsModal } from './views/SettingsModal';
import { buildMatcher, isQuerySyntax } from './scryfallQuery';
import type { ViewMode } from './store';

const SAMPLE = `4 Lightning Bolt
4 Counterspell
2 Snapcaster Mage
1 Jace, the Mind Sculptor

Sideboard
2 Surgical Extraction
`;

export function App() {
  const s = useStore();
  const [importerHosts, setImporterHosts] = useState<string[]>([]);
  const [importExpanded, setImportExpanded] = useState<boolean>(true);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.aesthetics().then((r) => s.setAesthetics(r.aesthetics)).catch((e) => s.setError(String(e)));
    api.health().then(s.setHealth).catch(() => {});
    api.importers().then((r) => setImporterHosts(r.importers.flatMap((i) => i.hosts))).catch(() => {});
    api.sets().then((r) => s.setSetIcons(r.sets)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (s.health?.data_version) return;
    const t = setInterval(() => {
      api.health().then(s.setHealth).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.health?.data_version]);

  const canAnalyze = useMemo(
    () =>
      (s.decklistText.trim().length > 0 || s.decklistUrl.trim().length > 0) &&
      !!s.health?.data_version,
    [s.decklistText, s.decklistUrl, s.health?.data_version],
  );

  const runAnalyze = async () => {
    if (!canAnalyze) return;
    s.setLoading(true);
    s.setError(null);
    try {
      const result = await api.analyze({
        decklist: s.decklistUrl
          ? { url: s.decklistUrl.trim() }
          : { text: s.decklistText },
        include_sideboard: s.includeSideboard,
        include_basics: s.includeBasics,
        allow_non_tournament: s.allowNonTournament,
        allow_digital: s.allowDigital,
        disabled_sets: s.disabledSets,
        format: s.format || undefined,
        printing_strategy: s.printingStrategy,
      });
      s.setResult(result);
      // Auto-collapse import block on a successful analysis so the user
      // can focus on the results. Re-expands explicitly via Edit button
      // or implicitly when they clear / change the input.
      setImportExpanded(false);
    } catch (e) {
      s.setError(String(e));
      s.setResult(null);
      // Errors keep the import block open so the user can fix things.
      setImportExpanded(true);
    } finally {
      s.setLoading(false);
    }
  };

  // Debounced auto-analyze on input changes (NOT on aesthetic chip toggles —
  // those are local-only filters, no roundtrip needed).
  useEffect(() => {
    if (!canAnalyze) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(runAnalyze, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.decklistText, s.decklistUrl, s.includeSideboard, s.includeBasics, s.allowNonTournament, s.allowDigital, s.disabledSets, s.format, s.printingStrategy, s.health?.data_version]);

  const groups = useMemo(() => groupAesthetics(s.aesthetics), [s.aesthetics]);

  // For each aesthetic, the number of cards that would be visible if this
  // chip were toggled into the OPPOSITE state from where it is now (under
  // the current selection of every other chip). For unselected chips this
  // answers "how many cards will appear if I add this filter?". For selected
  // chips it answers "how many cards will appear if I remove this filter?".
  // Always computed against the resolved deck.
  const chipCounts = useMemo(() => {
    if (!s.result) return new Map<string, number>();
    return chipToggleCounts(s.result.per_card, s.selectedAesthetics, s.aesthetics);
  }, [s.result, s.aesthetics, s.selectedAesthetics]);

  // Per-aesthetic deck-wide count (ignores current selection) — used only
  // to disable chips that no card in the deck would ever match.
  const deckCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (!s.result) return m;
    for (const a of s.aesthetics) m.set(a.id, 0);
    for (const c of s.result.per_card) {
      if (!c.resolved) continue;
      for (const aid of c.available_aesthetics) m.set(aid, (m.get(aid) ?? 0) + 1);
    }
    return m;
  }, [s.result, s.aesthetics]);

  const filteredCount = useMemo(() => {
    if (!s.result) return 0;
    return filterCards(s.result.per_card, s.selectedAesthetics, s.aesthetics).length;
  }, [s.result, s.selectedAesthetics, s.aesthetics]);

  return (
    <div className={'app' + (s.leftPanelCollapsed ? ' left-collapsed' : '')}>
      <aside className="left">
        <button
          type="button"
          className="left-collapse-toggle"
          onClick={() => s.setLeftPanelCollapsed(!s.leftPanelCollapsed)}
          aria-label={s.leftPanelCollapsed ? 'Expand left panel' : 'Collapse left panel'}
          title={s.leftPanelCollapsed ? 'Expand left panel' : 'Collapse left panel'}
        >
          {s.leftPanelCollapsed ? '›' : '‹'}
        </button>
        <h1 className="brand-row">
          <span>Frame<span className="brand-accent">works</span></span>
          {s.loading && (
            <span
              className="loading-spinner"
              aria-label="Analyzing decklist"
              title="Analyzing decklist…"
            />
          )}
        </h1>
        <DataStatus />

        {/* Import block — collapses to a one-line summary after a successful
            analysis so the analytical surfaces dominate the screen. */}
        {importExpanded ? (
          <section className="import-block">
            <h2>Decklist</h2>
            <textarea
              rows={10}
              placeholder={SAMPLE}
              value={s.decklistText}
              onChange={(e) => {
                s.setText(e.target.value);
                if (e.target.value) s.setUrl('');
              }}
            />
            <div className="format-help">
              Plain text · MTGA · MTGO (.dek) · `SB:` prefix · blank-line section breaks
            </div>

            <h2>Or import URL</h2>
            <input
              type="url"
              placeholder={importerHosts.length ? importerHosts.join(' · ') : 'moxfield · archidekt · melee · cubecobra · mtgtop8'}
              value={s.decklistUrl}
              onChange={(e) => {
                s.setUrl(e.target.value);
                if (e.target.value) s.setText('');
              }}
              style={{ width: '100%' }}
            />
            <div className="format-help">
              Supports Moxfield · Archidekt · Melee · CubeCobra · MTGTop8
            </div>

            <div className="import-options">
              <label className="row" title="Restrict the printing pool to cards legal in the chosen tournament format. Banned cards are excluded; restricted cards are kept. Cube allows any printing including silver/gold-border and un-sets.">
                <span style={{ minWidth: 60 }}>Format</span>
                <select
                  value={s.format}
                  onChange={(e) => s.setFormat(e.target.value)}
                  style={{ flex: 1 }}
                >
                  <option value="">Any tournament format</option>
                  <option value="standard">Standard</option>
                  <option value="pioneer">Pioneer</option>
                  <option value="modern">Modern</option>
                  <option value="legacy">Legacy</option>
                  <option value="vintage">Vintage</option>
                  <option value="commander">Commander</option>
                  <option value="pauper">Pauper</option>
                  <option value="cube">Cube (anything goes)</option>
                </select>
              </label>
              <label className="row">
                <input
                  type="checkbox"
                  checked={s.includeSideboard}
                  onChange={(e) => s.setIncludeSideboard(e.target.checked)}
                />
                Include sideboard
              </label>
              <label className="row">
                <input
                  type="checkbox"
                  checked={s.includeBasics}
                  onChange={(e) => s.setIncludeBasics(e.target.checked)}
                />
                Include basic lands
              </label>
              <label className="row" title="Excludes gold-border WC reprints, silver-border un-sets, 30A, memorabilia products.">
                <input
                  type="checkbox"
                  checked={s.allowNonTournament}
                  onChange={(e) => s.setAllowNonTournament(e.target.checked)}
                />
                Allow non-tournament-legal
              </label>
              <button
                type="button"
                className="linklike"
                style={{ fontSize: 11, marginTop: 2, alignSelf: 'flex-start' }}
                onClick={() => setSettingsOpen(true)}
              >
                ⚙ Per-set settings{s.disabledSets.length > 0 && ` · ${s.disabledSets.length} disabled`}
              </button>
            </div>
          </section>
        ) : (
          <section className="import-collapsed">
            <div className="import-summary">
              <div className="import-summary-main">
                <span className="import-summary-source">
                  {(() => {
                    if (!s.decklistUrl) return 'Pasted';
                    try {
                      return new URL(s.decklistUrl).hostname.replace(/^www\./, '');
                    } catch {
                      return 'URL';
                    }
                  })()}
                </span>
                {s.loading && (
                  <span className="loading-spinner" aria-label="Loading decklist" title="Loading decklist…" />
                )}
                {s.result && !s.loading && (
                  <span className="import-summary-stat muted">
                    {s.result.totals.unique_cards} unique · {s.result.totals.total_qty} cards
                  </span>
                )}
              </div>
              <button
                type="button"
                className="import-edit"
                onClick={() => setImportExpanded(true)}
                aria-label="Edit decklist"
                title="Edit decklist"
              >
                Edit
              </button>
            </div>
            <div className="import-options compact">
              <label className="row">
                <input
                  type="checkbox"
                  checked={s.includeSideboard}
                  onChange={(e) => s.setIncludeSideboard(e.target.checked)}
                />
                Sideboard
              </label>
              <label className="row">
                <input
                  type="checkbox"
                  checked={s.includeBasics}
                  onChange={(e) => s.setIncludeBasics(e.target.checked)}
                />
                Basic lands
              </label>
              <label className="row" title="Excludes gold-border WC reprints, silver-border un-sets, 30A, memorabilia products.">
                <input
                  type="checkbox"
                  checked={s.allowNonTournament}
                  onChange={(e) => s.setAllowNonTournament(e.target.checked)}
                />
                Tournament+
              </label>
              <button
                type="button"
                className="linklike"
                style={{ fontSize: 11 }}
                onClick={() => setSettingsOpen(true)}
                title="Per-set settings"
              >
                ⚙{s.disabledSets.length > 0 && ` · ${s.disabledSets.length}`}
              </button>
            </div>
          </section>
        )}

        <PrintingPreferences />

        <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>
            Filters
            {s.selectedAesthetics.size > 0 && (
              <span style={{ color: 'var(--accent)', marginLeft: 6 }}>
                · {filteredCount} card{filteredCount === 1 ? '' : 's'}
              </span>
            )}
          </span>
          {s.selectedAesthetics.size > 0 && (
            <button
              onClick={s.clearAesthetics}
              style={{ padding: '2px 8px', fontSize: 10, textTransform: 'none', letterSpacing: 0 }}
            >
              clear
            </button>
          )}
        </h2>
        {[...groups].map(([group, items]) => {
          const eligible = items
            .filter((a) => {
              if (s.selectedAesthetics.has(a.id)) return true;
              if (s.result == null) return true;
              return (deckCounts.get(a.id) ?? 0) > 0;
            })
            .map((a) => a.id);
          const allSelected =
            eligible.length > 0 && eligible.every((id) => s.selectedAesthetics.has(id));
          const collapsed = s.collapsedFilterGroups.includes(group);
          const groupSelN = countSelected(items, s.selectedAesthetics);
          return (
          <div
            key={group}
            className={`group-panel ${groupClass(group)}` + (collapsed ? ' collapsed' : '')}
          >
            <div className="group-title">
              <button
                type="button"
                className="group-collapse"
                aria-label={collapsed ? `Expand ${group}` : `Collapse ${group}`}
                aria-expanded={!collapsed}
                title={collapsed ? `Expand ${group}` : `Collapse ${group}`}
                onClick={() => s.toggleFilterGroupCollapsed(group)}
              >
                <span aria-hidden>{collapsed ? '▸' : '▾'}</span>
              </button>
              <span
                className="group-title-label group-title-toggle"
                role="button"
                tabIndex={0}
                aria-pressed={allSelected}
                title={
                  allSelected
                    ? `Clear all ${group.toLowerCase()} filters`
                    : `Select all ${group.toLowerCase()} filters`
                }
                onClick={() => s.toggleGroup(group, eligible)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    s.toggleGroup(group, eligible);
                  }
                }}
              >
                {group}
              </span>
              <span className="group-count">
                {groupSelN}/{items.length}
              </span>
            </div>
            {!collapsed && (
            <div className="chips">
              {items.map((a) => {
                const sel = s.selectedAesthetics.has(a.id);
                const deckN = deckCounts.get(a.id) ?? 0;
                const chipN = chipCounts.get(a.id) ?? 0;
                const disabled = !sel && s.result != null && deckN === 0;
                return (
                  <span
                    key={a.id}
                    className={
                      'chip' +
                      (sel ? ' active' : '') +
                      (disabled ? ' dim' : '') +
                      (!sel && !disabled && chipN > 0 ? ' has-matches' : '')
                    }
                    onClick={() => {
                      if (disabled) return;
                      s.toggleAesthetic(a.id);
                    }}
                    title={
                      disabled
                        ? `${a.label} — no cards in this deck`
                        : sel
                          ? `${a.label} — ${chipN} card${chipN === 1 ? '' : 's'} remain if removed`
                          : `${a.label} — ${chipN} card${chipN === 1 ? '' : 's'} match if added`
                    }
                    style={disabled ? { cursor: 'not-allowed' } : undefined}
                  >
                    {a.label}
                    {s.result && <span className="chip-count">{chipN}</span>}
                  </span>
                );
              })}
            </div>
            )}
          </div>
          );
        })}

        {!canAnalyze && (
          <div style={{ marginTop: 16 }}>
            <button className="primary" disabled={!canAnalyze || s.loading} onClick={runAnalyze}>
              {s.loading ? 'Analyzing…' : 'Analyze'}
            </button>
          </div>
        )}
        {s.error && <div className="err" style={{ marginTop: 8 }}>{s.error}</div>}
      </aside>

      <main
        className="right"
        style={{ ['--card-size' as never]: `${resolveCardSize(s.view, s.cardSizeByView)}px` }}
      >
        <div className="toolbar tabbar">
          <ViewTabs view={s.view} setView={s.setView} />
          {(s.view === 'gallery' || s.view === 'art' || s.view === 'percard') && (
            <CardFilterInput
              value={s.cardNameFilter}
              onChange={s.setCardNameFilter}
            />
          )}
          <span className="spacer" />
          {(s.view === 'gallery' || s.view === 'art' || s.view === 'percard') && s.view !== 'percard' && (
            <label className="size-slider" title="Card image size (saved per page)">
              <span aria-hidden>▫</span>
              <input
                type="range"
                min={80}
                max={360}
                step={4}
                value={resolveCardSize(s.view, s.cardSizeByView)}
                onChange={(e) => s.setCardSizeForView(s.view, Number(e.target.value))}
              />
              <span aria-hidden>▣</span>
              <span className="size-val">{resolveCardSize(s.view, s.cardSizeByView)}px</span>
            </label>
          )}
          {s.view === 'percard' && (
            <label className="density-slider" title="Coverage density">
              <span aria-hidden className="muted">density</span>
              <button
                type="button"
                className={'tab ' + (s.coverageDensity === 'compact' ? 'active' : '')}
                onClick={() => s.setCoverageDensity('compact')}
              >Compact</button>
              <button
                type="button"
                className={'tab ' + (s.coverageDensity === 'default' ? 'active' : '')}
                onClick={() => s.setCoverageDensity('default')}
              >Default</button>
              <button
                type="button"
                className={'tab ' + (s.coverageDensity === 'comfortable' ? 'active' : '')}
                onClick={() => s.setCoverageDensity('comfortable')}
              >Comfortable</button>
            </label>
          )}
          {s.result && (
            <span className="muted">
              {s.loading && (
                <span
                  className="loading-spinner"
                  aria-label="Re-analyzing"
                  title="Re-analyzing…"
                  style={{ marginRight: 8 }}
                />
              )}
              {s.selectedAesthetics.size > 0 ? `${filteredCount} of ` : ''}
              {s.result.totals.unique_cards} unique · {s.result.totals.total_qty} cards
              {s.result.totals.unresolved > 0 && ` · ${s.result.totals.unresolved} unresolved`}
              {' · '}{s.result.elapsed_ms} ms
            </span>
          )}
        </div>

        {viewSupportsSpotlight(s.view) && <SpotlightPicker />}

        {!s.result && !s.loading && (
          <div className="empty-state">
            <h3>No deck loaded yet</h3>
            <div>Paste a decklist or import a URL on the left.</div>
          </div>
        )}
        {s.loading && !s.result && (
          <div className="empty-state">
            <span className="loading-spinner large" aria-label="Analyzing decklist" />
            <div className="muted" style={{ marginTop: 12 }}>Analyzing decklist…</div>
          </div>
        )}
        {s.result?.warnings.length ? (
          <details style={{ marginBottom: 12 }}>
            <summary className="warn">{s.result.warnings.length} warning(s)</summary>
            <ul>
              {s.result.warnings.map((w, i) => (
                <li key={i} className="muted" style={{ fontSize: 12 }}>{w}</li>
              ))}
            </ul>
          </details>
        ) : null}

        {s.result && s.view === 'art' && <ArtGridView />}
        {s.result && s.view === 'funnel' && <FunnelView />}
        {s.result && s.view === 'outliers' && <OutliersView />}
        {s.result && s.view === 'timeline' && <TimelineView />}
        {s.result && s.view === 'compare' && <CompareView />}
        {s.result && s.view === 'gallery' && <GalleryView />}
        {s.result && s.view === 'percard' && <PerCardView />}
      </main>

      <Drawer />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

/** Top-of-page card filter input. Accepts plain card-name substrings (back-compat
 *  with the legacy textbox) OR Scryfall-syntax queries like `t:creature mv>=3`,
 *  `c:ur o:"draw a card"`, `set:dom OR set:bro`, etc. Parses on every change so
 *  syntax errors are surfaced inline; the result is consumed via the same
 *  `cardNameFilter` state field as before, so persisted values keep working.
 */
function CardFilterInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const trimmed = value.trim();
  const isQuery = isQuerySyntax(trimmed);
  // Re-parse on every keystroke. The matcher is cheap (regex + array iter)
  // so we don't bother memoising — but we DO want the error message live
  // for the inline indicator. Consumers (Gallery, store) memoise their
  // own matcher off the same `value`, so this re-parse is local-only.
  const parseError = useMemo(() => {
    if (!isQuery) return null;
    const r = buildMatcher(trimmed);
    return 'error' in r ? r.error : null;
  }, [trimmed, isQuery]);
  return (
    <label
      className={`card-name-filter${parseError ? ' card-name-filter-error' : ''}`}
      title={
        parseError
          ? `Query error: ${parseError}\nFalling back to name substring.`
          : 'Filter cards. Plain words match by name; or use Scryfall syntax (t:, o:, c:, mv:, set:, is:foil, …). Saved across reloads.'
      }
    >
      <span aria-hidden>🔍</span>
      <input
        type="search"
        placeholder="Filter: name, t:creature, c:ur, mv>=3, set:dom, is:foil…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {parseError && (
        <span className="card-name-filter-msg" aria-live="polite">
          {parseError}
        </span>
      )}
      <a
        className="card-name-filter-help"
        href="https://scryfall.com/docs/syntax"
        target="_blank"
        rel="noopener noreferrer"
        title="Scryfall query syntax reference"
        onClick={(e) => e.stopPropagation()}
      >
        ?
      </a>
      {value && (
        <button
          type="button"
          className="card-name-filter-clear"
          onClick={() => onChange('')}
          aria-label="Clear card filter"
          title="Clear (Esc)"
        >
          ×
        </button>
      )}
    </label>
  );
}

function DataStatus() {
  const h = useStore((s) => s.health);
  if (!h) return <div className="muted">Connecting…</div>;
  if (!h.data_version) {
    return (
      <div className="warn">
        Card data downloading… <span className="skeleton" style={{ width: 60, height: 10 }} />
      </div>
    );
  }
  const ageH = h.refresh_age_seconds != null ? Math.round(h.refresh_age_seconds / 3600) : '?';
  return (
    <div className="muted data-status">
      Card data v{h.data_version.slice(0, 10)} · refreshed {ageH}h ago · {h.aesthetics_loaded} aesthetics
    </div>
  );
}

function countSelected(items: { id: string }[], selected: Set<string>): number {
  let n = 0;
  for (const it of items) if (selected.has(it.id)) n++;
  return n;
}

const PRINTING_PREF_LABELS: Record<string, string> = {
  first: 'First printing',
  latest: 'Latest printing',
  most_valuable: 'Most valuable',
  least_valuable: 'Least valuable',
  'border:black': 'Black border',
  'border:white': 'White border',
  'border:silver': 'Silver border',
  'border:gold': 'Gold border',
  'border:borderless': 'Borderless',
  'frame:1993': 'Original frame (1993)',
  'frame:1997': 'Updated frame (1997)',
  'frame:2003': 'Modern frame (2003)',
  'frame:2015': 'M15 frame (2015)',
  'frame:future': 'Future Sight frame',
  'foil:nonfoil': 'Non-foil',
  'foil:foil': 'Foil available',
  'promo:nonpromo': 'Non-promo',
  'promo:promo': 'Promo',
  fullart: 'Full art',
  nonfullart: 'Non full-art',
  textless: 'Textless',
  nontextless: 'Has text',
  paper: 'Paper (non-digital)',
  digital: 'Digital',
  'lang:en': 'English',
  'lang:ja': 'Japanese',
  'lang:de': 'German',
  'lang:fr': 'French',
  'lang:es': 'Spanish',
  'lang:it': 'Italian',
  'lang:pt': 'Portuguese',
  'lang:ko': 'Korean',
  'lang:ru': 'Russian',
  'lang:zhs': 'Chinese (Simplified)',
  'lang:zht': 'Chinese (Traditional)',
};

function labelFor(spec: string): string {
  return PRINTING_PREF_LABELS[spec] ?? spec;
}

// Categories for the Add-preference builder. Each category has a kind and
// either no values (single click adds it) or a list of value options.
type PrefCategory = {
  kind: string;
  label: string;
  values?: { value: string; label: string }[];
};
const PREF_CATEGORIES: PrefCategory[] = [
  { kind: 'first', label: 'First printing' },
  { kind: 'latest', label: 'Latest printing' },
  { kind: 'most_valuable', label: 'Most valuable' },
  { kind: 'least_valuable', label: 'Least valuable' },
  {
    kind: 'border',
    label: 'Border color',
    values: [
      { value: 'black', label: 'Black' },
      { value: 'white', label: 'White' },
      { value: 'silver', label: 'Silver' },
      { value: 'gold', label: 'Gold' },
      { value: 'borderless', label: 'Borderless' },
    ],
  },
  {
    kind: 'frame',
    label: 'Frame era',
    values: [
      { value: '1993', label: 'Original (1993)' },
      { value: '1997', label: 'Updated (1997)' },
      { value: '2003', label: 'Modern (2003)' },
      { value: '2015', label: 'M15 (2015)' },
      { value: 'future', label: 'Future Sight' },
    ],
  },
  {
    kind: 'foil',
    label: 'Foil',
    values: [
      { value: 'nonfoil', label: 'Non-foil' },
      { value: 'foil', label: 'Foil available' },
    ],
  },
  {
    kind: 'promo',
    label: 'Promo',
    values: [
      { value: 'nonpromo', label: 'Non-promo' },
      { value: 'promo', label: 'Promo' },
    ],
  },
  { kind: 'fullart', label: 'Full art' },
  { kind: 'nonfullart', label: 'Non full-art' },
  { kind: 'textless', label: 'Textless' },
  { kind: 'paper', label: 'Paper (non-digital)' },
  {
    kind: 'lang',
    label: 'Language',
    values: [
      { value: 'en', label: 'English' },
      { value: 'ja', label: 'Japanese' },
      { value: 'de', label: 'German' },
      { value: 'fr', label: 'French' },
      { value: 'es', label: 'Spanish' },
      { value: 'it', label: 'Italian' },
      { value: 'pt', label: 'Portuguese' },
      { value: 'ko', label: 'Korean' },
      { value: 'ru', label: 'Russian' },
      { value: 'zhs', label: 'Chinese (Simplified)' },
      { value: 'zht', label: 'Chinese (Traditional)' },
    ],
  },
];

function PrintingPreferences() {
  const enabled = useStore((s) => s.printingStrategy);
  const setStrategy = useStore((s) => s.setPrintingStrategy);
  const [adding, setAdding] = useState(false);
  const [showAllCategories, setShowAllCategories] = useState(false);
  const [addKind, setAddKind] = useState<string>('');
  const [addValue, setAddValue] = useState<string>('');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  // Index where the dragged item would land if dropped now (0..enabled.length).
  // Use a separate "drop" index from "drag" index so we can show a clear
  // insertion line between items rather than a vague "drop on this row".
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  const remove = (spec: string) => setStrategy(enabled.filter((x) => x !== spec));

  const addPref = (spec: string) => {
    if (enabled.includes(spec)) return;
    setStrategy([...enabled, spec]);
  };

  const reorderTo = (from: number, insertBefore: number) => {
    // `insertBefore` is the index in the ORIGINAL array where the dragged
    // item should land (0..length, can equal length to mean "at end").
    if (from === insertBefore || from + 1 === insertBefore) return;
    const next = [...enabled];
    const [item] = next.splice(from, 1);
    const target = insertBefore > from ? insertBefore - 1 : insertBefore;
    next.splice(target, 0, item);
    setStrategy(next);
  };

  const cat = PREF_CATEGORIES.find((c) => c.kind === addKind);

  const buildSpec = (): string | null => {
    if (!cat) return null;
    if (cat.values) {
      if (!addValue) return null;
      return `${cat.kind}:${addValue}`;
    }
    return cat.kind;
  };

  // Compute the insertion index for a drag-over event on row `i`. If the
  // cursor is in the top half, drop *before* i; bottom half = *after* i.
  const dropIndexFor = (e: React.DragEvent<HTMLLIElement>, i: number): number => {
    const r = e.currentTarget.getBoundingClientRect();
    const before = e.clientY - r.top < r.height / 2;
    return before ? i : i + 1;
  };

  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>
        Preferred printing for art
        <span style={{ marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>
          (drag to reorder)
        </span>
      </div>
      <ol
        className="pref-list"
        onDragLeave={(e) => {
          // Only clear when leaving the whole list, not when crossing into a child.
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropIdx(null);
        }}
      >
        {enabled.map((p, i) => {
          const isDragging = dragIdx === i;
          const showLineBefore = dropIdx === i && dragIdx !== i && dragIdx !== i - 1;
          const showLineAfter =
            i === enabled.length - 1 &&
            dropIdx === enabled.length &&
            dragIdx !== enabled.length - 1;
          return (
            <li
              key={p}
              className={
                'pref-item enabled' +
                (isDragging ? ' dragging' : '') +
                (showLineBefore ? ' drop-before' : '') +
                (showLineAfter ? ' drop-after' : '')
              }
              draggable
              onDragStart={(e) => {
                setDragIdx(i);
                e.dataTransfer.effectAllowed = 'move';
                // Required by Firefox to actually start the drag.
                try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* noop */ }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDropIdx(dropIndexFor(e, i));
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdx == null) return;
                const target = dropIndexFor(e, i);
                reorderTo(dragIdx, target);
                setDragIdx(null);
                setDropIdx(null);
              }}
              onDragEnd={() => {
                setDragIdx(null);
                setDropIdx(null);
              }}
            >
              <span className="pref-grip" aria-hidden>⋮⋮</span>
              <span className="pref-rank">{i + 1}.</span>
              <span className="pref-label">{labelFor(p)}</span>
              <button className="pref-x" title="Disable" onClick={() => remove(p)}>×</button>
            </li>
          );
        })}
        {enabled.length === 0 && (
          <li className="pref-item empty">
            <span className="pref-label muted">No preferences (default order)</span>
          </li>
        )}
      </ol>

      {!adding ? (
        <button
          className="pref-add-btn"
          onClick={() => {
            setAdding(true);
            setAddKind('');
            setAddValue('');
          }}
        >
          + Add preference
        </button>
      ) : (
        <div className="pref-builder">
          <select
            value={addKind}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__more__') {
                setShowAllCategories(true);
                return;
              }
              setAddKind(v);
              setAddValue('');
            }}
          >
            <option value="">Choose…</option>
            {(showAllCategories ? PREF_CATEGORIES : PREF_CATEGORIES.slice(0, 5)).map((c) => (
              <option key={c.kind} value={c.kind}>{c.label}</option>
            ))}
            {!showAllCategories && PREF_CATEGORIES.length > 5 && (
              <option value="__more__">Show {PREF_CATEGORIES.length - 5} more…</option>
            )}
          </select>
          {cat?.values && (
            <select value={addValue} onChange={(e) => setAddValue(e.target.value)}>
              <option value="">Value…</option>
              {cat.values.map((v) => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
          )}
          <button
            className="primary"
            disabled={(() => {
              const spec = buildSpec();
              return !spec || enabled.includes(spec);
            })()}
            onClick={() => {
              const spec = buildSpec();
              if (!spec) return;
              addPref(spec);
              setAdding(false);
              setAddKind('');
              setAddValue('');
            }}
          >
            Add
          </button>
          <button onClick={() => setAdding(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

/**
 * "Show printing in" picker — primary highlighted aesthetic + extra
 * spotlights. Lives in its own narrow pane to the right of the main
 * sidebar, with chips grouped under the same category panels as the
 * main filters so the two side-by-side pickers feel coherent.
 *
 * Interactions:
 *   - Click a chip: replace selection with [id] (single-select).
 *   - Ctrl/Cmd-click: toggle id in/out of selection (multi-select).
 *   - "Default" clears all spotlights.
 *
 * The first selected id is the primary printing shown in Gallery; any
 * additional ids appear as a thumbnail strip beneath each card.
 */
/**
 * Spotlight picker — horizontal bar above the active view. Multi-select
 * by default; every chip click toggles add/remove. The first selected id
 * is the "primary" printing shown in Gallery; additional ids appear as a
 * thumbnail strip beneath each card in views that support it. Chip count
 * badge mirrors the side-filter UI: it shows how many cards would be
 * spotlit if this chip were toggled into the opposite state. The group
 * title is a one-click "select all in group / clear all in group" toggle.
 */
function SpotlightPicker() {
  const aesthetics = useStore((s) => s.aesthetics);
  const spotlight = useStore((s) => s.galleryAesthetics);
  const excluded = useStore((s) => s.gallerySpotExcluded);
  const toggleIncl = useStore((s) => s.toggleGalleryAesthetic);
  const toggleExcl = useStore((s) => s.toggleSpotlightExclude);
  const clearSpotlight = useStore((s) => s.clearSpotlight);
  const toggleSpotGroup = useStore((s) => s.toggleSpotlightGroup);
  const collapsedSpot = useStore((s) => s.collapsedSpotlightGroups);
  const toggleSpotCollapse = useStore((s) => s.toggleSpotlightGroupCollapsed);
  const barCollapsed = useStore((s) => s.spotlightBarCollapsed);
  const setBarCollapsed = useStore((s) => s.setSpotlightBarCollapsed);
  const result = useStore((s) => s.result);

  // Spotlight chips visible: always show the full aesthetic catalogue.
  // We deliberately do NOT narrow this set by the left-side filter — when
  // we did, clicking a single filter chip on the left reorganized the
  // spotlight bar (chips disappeared, others shifted) which read as
  // "the filter was applied to spotlight." The spotlight bar is now
  // fully independent of the side filter; users still cycle each chip
  // explicitly to include / exclude / clear.
  const visible = aesthetics;
  const groups = useMemo(() => groupAesthetics(visible), [visible]);

  const spotCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (!result) return m;
    const inIncl = (id: string) => spotlight.includes(id);
    const inExcl = (id: string) => excluded.includes(id);
    const matchSet = (
      avail: readonly string[],
      incl: readonly string[],
      excl: readonly string[],
      def: readonly string[] | null,
    ): boolean => {
      if (incl.length === 0 && excl.length === 0) return true;
      // Excludes test against the actual chosen printing (default_aesthetics)
      // when available, so excluding "M15 frame" hides cards whose preferred
      // printing is M15-framed rather than every card that has any reprint.
      const excludeProbe = def ?? avail;
      if (excl.length > 0) {
        for (const id of excl) if (excludeProbe.includes(id)) return false;
      }
      if (incl.length > 0) {
        for (const id of incl) if (avail.includes(id)) return true;
        return false;
      }
      return true;
    };
    // Count against the FULL deck, not the side-filter-narrowed set.
    // If we used filteredCards, the spotlight chip counts would track the
    // user's left-side filter selection, and the chip that matches their
    // filter would be the only one with a non-zero count — making the
    // spotlight bar look like it "auto-applied" the filter chip. Counts
    // here represent "what would match if I added/removed this chip from
    // spotlight" against the whole deck, independent of side filters.
    const allCards = result.per_card.filter((c) => c.resolved);
    for (const a of aesthetics) {
      // Predict the NEXT state in the cycle: off→include, include→exclude, exclude→off.
      let nextIncl = spotlight;
      let nextExcl = excluded;
      if (!inIncl(a.id) && !inExcl(a.id)) nextIncl = [...spotlight, a.id];
      else if (inIncl(a.id)) {
        nextIncl = spotlight.filter((x) => x !== a.id);
        nextExcl = [...excluded, a.id];
      } else {
        nextExcl = excluded.filter((x) => x !== a.id);
      }
      let n = 0;
      for (const c of allCards) {
        if (matchSet(c.available_aesthetics, nextIncl, nextExcl, c.default_aesthetics ?? null)) n++;
      }
      m.set(a.id, n);
    }
    return m;
  }, [result, aesthetics, spotlight, excluded]);

  if (!result) {
    return (
      <div className="spotlight-bar empty muted">
        Default · preferred printing
      </div>
    );
  }

  const hasAny = spotlight.length > 0 || excluded.length > 0;
  const clearAll = () => clearSpotlight();

  return (
    <div className={'spotlight-bar' + (barCollapsed ? ' bar-collapsed' : '')}>
      <div className="spotlight-default">
        <button
          type="button"
          className="spotlight-bar-collapse"
          aria-label={barCollapsed ? 'Expand spotlight filters' : 'Collapse spotlight filters'}
          aria-expanded={!barCollapsed}
          title={barCollapsed ? 'Expand spotlight filters' : 'Collapse spotlight filters'}
          onClick={() => setBarCollapsed(!barCollapsed)}
        >
          <span aria-hidden>{barCollapsed ? '▸' : '▾'}</span>
          <span className="spotlight-bar-label">Spotlight</span>
        </button>
        <button
          type="button"
          className={'chip ' + (!hasAny ? 'active' : '')}
          onClick={clearAll}
          title="Show each card's default preferred printing"
        >
          Default
        </button>
        {hasAny && (
          <button
            type="button"
            className="spotlight-clear"
            onClick={clearAll}
            title="Clear all spotlights"
          >
            clear
          </button>
        )}
        {barCollapsed ? (
          hasAny && (
            <span className="spotlight-summary muted">
              {spotlight.length > 0 && (
                <>
                  +{spotlight.length} included
                </>
              )}
              {spotlight.length > 0 && excluded.length > 0 && ' · '}
              {excluded.length > 0 && (
                <>
                  −{excluded.length} excluded
                </>
              )}
            </span>
          )
        ) : (
          <span className="spotlight-hint muted">Click chip to include · − to exclude · first include is primary</span>
        )}
      </div>

      {!barCollapsed && (
      <div className="spotlight-groups">
      {[...groups].map(([group, items]) => {
        const eligible = items.map((a) => a.id);
        const selectedInGroup = items.filter((a) => spotlight.includes(a.id)).length;
        const excludedInGroup = items.filter((a) => excluded.includes(a.id)).length;
        const allOn = eligible.length > 0 && eligible.every((id) => spotlight.includes(id));
        const collapsed = collapsedSpot.includes(group);
        return (
          <div
            key={group}
            className={`spotlight-group ${groupClass(group)}` + (collapsed ? ' collapsed' : '')}
          >
            <div className="spotlight-group-head">
              <button
                type="button"
                className="spotlight-group-collapse"
                aria-label={collapsed ? `Expand ${group}` : `Collapse ${group}`}
                aria-expanded={!collapsed}
                title={collapsed ? `Expand ${group}` : `Collapse ${group}`}
                onClick={() => toggleSpotCollapse(group)}
              >
                <span aria-hidden>{collapsed ? '▸' : '▾'}</span>
              </button>
              <span
                className="spotlight-group-title"
                role="button"
                tabIndex={0}
                aria-pressed={allOn}
                onClick={() => toggleSpotGroup(group, eligible)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleSpotGroup(group, eligible);
                  }
                }}
                title={allOn ? `Clear all ${group.toLowerCase()} spotlights` : `Spotlight all ${group.toLowerCase()}`}
              >
                <span className="spotlight-group-name">{group}</span>
                <span className="group-count">
                  {selectedInGroup}
                  {excludedInGroup > 0 && <span className="excl-count">−{excludedInGroup}</span>}
                  /{items.length}
                </span>
              </span>
            </div>
            {!collapsed && (
            <div className="chips">
              {items.map((a) => {
                const idx = spotlight.indexOf(a.id);
                const isInclude = idx >= 0;
                const isExclude = excluded.includes(a.id);
                const isPrimary = idx === 0;
                const cn = spotCounts.get(a.id) ?? 0;
                const cls =
                  'chip' +
                  (isInclude ? ' active include' : '') +
                  (isExclude ? ' active exclude' : '') +
                  (isPrimary ? ' primary' : '') +
                  (!isInclude && !isExclude && cn > 0 ? ' has-matches' : '');
                const inclTitle = isInclude
                  ? `Remove ${a.label} from spotlight include`
                  : `Include ${a.label} in spotlight — ${cn} card${cn === 1 ? '' : 's'} would match`;
                const exclTitle = isExclude
                  ? `Clear exclude — ${a.label}`
                  : `Exclude ${a.label} from spotlight`;
                return (
                  <span key={a.id} className="chip-pair">
                    <button
                      type="button"
                      className={'chip-exclude-btn' + (isExclude ? ' active' : '')}
                      onClick={(e) => { e.stopPropagation(); toggleExcl(a.id); }}
                      aria-pressed={isExclude}
                      aria-label={exclTitle}
                      title={exclTitle}
                    >
                      <span className="chip-exclude-bar" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className={cls}
                      onClick={() => toggleIncl(a.id)}
                      aria-pressed={isInclude}
                      title={inclTitle}
                    >
                      {a.label}
                      <span className="chip-count">{cn}</span>
                    </button>
                  </span>
                );
              })}
            </div>
            )}
          </div>
        );
      })}
      </div>
      )}

      {!barCollapsed && visible.length === 0 && (
        <div className="muted" style={{ fontSize: 11 }}>
          No aesthetics selected — pick filters in the sidebar to scope spotlights.
        </div>
      )}
    </div>
  );
}

/**
 * Tab bar at the top of the main content pane. Tabs are grouped into
 * two clusters: "Tables" (the original raw-data views) and "Insights"
 * (the new analytical views). The two clusters are visually separated
 * with a hairline divider so the bar doesn't read as one giant strip.
 */
const TAB_GROUPS: ReadonlyArray<{
  group: string;
  tabs: ReadonlyArray<{ id: ViewMode; label: string; title?: string }>;
}> = [
  {
    group: 'Tables',
    tabs: [
      { id: 'gallery', label: 'Gallery', title: 'Each card as a single image' },
      { id: 'art', label: 'Art Grid', title: 'Card × aesthetic art table' },
      { id: 'percard', label: 'Coverage', title: 'Card × aesthetic table' },
    ],
  },
  {
    group: 'Insights',
    tabs: [
      { id: 'funnel', label: 'Funnel', title: 'Coverage shape per aesthetic' },
      { id: 'outliers', label: 'Blockers', title: 'Cards blocking a chosen aesthetic' },
      { id: 'compare', label: 'Compare', title: 'Two aesthetics side-by-side' },
      { id: 'timeline', label: 'Timeline', title: 'Cards placed by printing release date' },
    ],
  },
];

function ViewTabs({ view, setView }: { view: ViewMode; setView: (v: ViewMode) => void }) {
  return (
    <div className="tabgroups">
      {TAB_GROUPS.map((g, gi) => (
        <span key={g.group} className="tabgroup">
          {gi > 0 && <span className="tabgroup-sep" aria-hidden />}
          <span className="tabgroup-label muted" aria-hidden>{g.group}</span>
          {g.tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={'tab ' + (view === t.id ? 'active' : '')}
              onClick={() => setView(t.id)}
              title={t.title}
            >
              {t.label}
            </button>
          ))}
        </span>
      ))}
    </div>
  );
}
