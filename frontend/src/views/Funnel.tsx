import { useMemo, useState } from 'react';
import { filterCards, groupAesthetics, useStore } from '../store';
import { aestheticCoverage, groupClass, visibleAesthetics } from './insightsUtil';
import { PageDescription } from './PageDescription';

/**
 * Aesthetic Funnel — for each aesthetic, a stacked bar showing the
 * structural shape of its compatibility with the deck:
 *   - covered:    cards available with this aesthetic.
 *   - uncovered:  resolved cards NOT available in this aesthetic.
 *   - unresolved: cards we couldn't even look up.
 *
 * Sortable by coverage (default), name, or group.
 */
export function FunnelView() {
  const result = useStore((s) => s.result)!;
  const aesthetics = useStore((s) => s.aesthetics);
  const selected = useStore((s) => s.selectedAesthetics);
  const openDrawer = useStore((s) => s.openDrawer);

  const cards = useMemo(
    () => filterCards(result.per_card, selected, aesthetics),
    [result.per_card, selected, aesthetics],
  );
  const visible = useMemo(() => visibleAesthetics(aesthetics, 'funnel'), [aesthetics]);
  const cov = useMemo(() => aestheticCoverage(cards, visible), [cards, visible]);
  const totalQty = cards.reduce((s, c) => s + c.qty, 0) || 1;
  const unresolvedQty = result.per_card.reduce(
    (s, c) => (c.resolved ? s : s + c.qty),
    0,
  );

  const groups = useMemo(() => groupAesthetics(aesthetics), [aesthetics]);

  const [sort, setSort] = useState<'pct' | 'group' | 'name'>('pct');

  const sortedRows = useMemo(() => {
    const rows = [...cov];
    // `paper_only` is technically true for almost any card, so when it
    // ties with anything informative we want it ranked below.
    const paperLast = (a: typeof cov[number], b: typeof cov[number]) =>
      (a.id === 'paper_only' ? 1 : 0) - (b.id === 'paper_only' ? 1 : 0);
    const alpha = (a: typeof cov[number], b: typeof cov[number]) =>
      a.label.localeCompare(b.label);
    rows.sort((a, b) => {
      let primary = 0;
      if (sort === 'pct') primary = b.pct - a.pct;
      else if (sort === 'name') primary = a.label.localeCompare(b.label);
      else primary = a.group.localeCompare(b.group) || b.pct - a.pct;
      return primary || paperLast(a, b) || alpha(a, b);
    });
    return rows;
  }, [cov, sort]);

  return (
    <div className="insight-wrap funnel-wrap">
      <PageDescription id="funnel" title="Funnel — how far each aesthetic could go">
        One stacked bar per aesthetic. The colored segment is what already
        matches; the gray segment is the same cards that <em>could</em> swap
        into that aesthetic but currently aren't there; the hatched segment
        is unresolved cards. Sort by Coverage to see the easiest aesthetic
        wins; sort by Group to compare frame-vs-frame, border-vs-border, etc.
      </PageDescription>
      <div className="funnel-toolbar">
        <span className="muted" style={{ fontSize: 11 }}>Sort by:</span>
        <button
          className={sort === 'pct' ? 'tab active' : 'tab'}
          onClick={() => setSort('pct')}
        >
          Coverage
        </button>
        <button
          className={sort === 'group' ? 'tab active' : 'tab'}
          onClick={() => setSort('group')}
        >
          Group
        </button>
        <button
          className={sort === 'name' ? 'tab active' : 'tab'}
          onClick={() => setSort('name')}
        >
          Name
        </button>
        <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
          {groups.size} groups · {aesthetics.length} aesthetics · {totalQty} card-quantity
        </span>
      </div>

      <div className="funnel-list">
        {sortedRows.map((r) => {
          const cls = groupClass(r.group);
          const coveredPct = r.qty / totalQty;
          const uncoveredPct = (totalQty - r.qty - unresolvedQty) / totalQty;
          const unresolvedShare = unresolvedQty / totalQty;
          return (
            <div key={r.id} className={`funnel-row ${cls}`}>
              <button
                type="button"
                className="funnel-name linklike"
                onClick={() => openDrawer(r.id)}
                title={`${r.label} — open drawer`}
              >
                {r.label}
              </button>
              <span className="funnel-group muted">{r.group}</span>
              <div className="funnel-bar" title={`${Math.round(coveredPct * 100)}% covered`}>
                <span
                  className="funnel-seg covered"
                  style={{ width: `${coveredPct * 100}%` }}
                />
                <span
                  className="funnel-seg uncovered"
                  style={{ width: `${Math.max(0, uncoveredPct) * 100}%` }}
                />
                {unresolvedShare > 0 && (
                  <span
                    className="funnel-seg unresolved"
                    style={{ width: `${unresolvedShare * 100}%` }}
                  />
                )}
              </div>
              <span className="funnel-pct">{Math.round(coveredPct * 100)}%</span>
              <span className="funnel-counts muted">
                {r.unique}/{cards.length}
              </span>
            </div>
          );
        })}
      </div>

      <div className="funnel-legend muted">
        <span><span className="legend-sw covered" /> covered</span>
        <span><span className="legend-sw uncovered" /> not available</span>
        {unresolvedQty > 0 && (
          <span><span className="legend-sw unresolved" /> unresolved card name</span>
        )}
      </div>
    </div>
  );
}
