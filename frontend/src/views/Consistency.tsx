import { useMemo } from 'react';
import type { PerCardRow, Aesthetic } from '../api';
import { filterCards, groupAesthetics, useStore } from '../store';
import { aestheticCoverage, groupClass, heat, moneyShort, visibleAesthetics } from './insightsUtil';
import { PageDescription, priceFor } from './PageDescription';

/**
 * Score view — multi-numeric dashboard.
 *
 *   - **Possible** (top number, large heat-tinted card): for each *group*
 *     of aesthetics, take the best coverage_pct (the most-cohesive label
 *     in that group). Average those group-bests. Uses `available_aesthetics`
 *     so it answers "if we re-printed every card to its best look in each
 *     group, how cohesive could this deck become?"
 *   - **Preferred**: same recipe but uses `default_aesthetics` (the
 *     aesthetics actually satisfied by the chosen preferred printing per
 *     card). Answers "how cohesive is the deck *as currently printed*?"
 *     Always ≤ Possible. Falls back gracefully on older backends.
 *   - **Top aesthetic**: the single best-coverage aesthetic and its share.
 *
 * Groups whose best aesthetic covers 0 cards are omitted from both averages
 * and from the per-group list (they aren't informative — nothing in this
 * deck can express any aesthetic in that group).
 */
export function ConsistencyView() {
  const result = useStore((s) => s.result)!;
  const aesthetics = useStore((s) => s.aesthetics);
  const selected = useStore((s) => s.selectedAesthetics);
  const openDrawer = useStore((s) => s.openDrawer);

  const cards = useMemo(
    () => filterCards(result.per_card, selected, aesthetics),
    [result.per_card, selected, aesthetics],
  );

  const visible = useMemo(() => visibleAesthetics(aesthetics, 'consistency'), [aesthetics]);
  const possibleCov = useMemo(() => aestheticCoverage(cards, visible), [cards, visible]);

  const hasPreferredData = useMemo(
    () => cards.some((c) => Array.isArray(c.default_aesthetics)),
    [cards],
  );
  const preferredCov = useMemo(() => preferredCoverage(cards, visible), [cards, visible]);

  const groupBestPossible = useMemo(() => bestByGroup(possibleCov), [possibleCov]);
  const groupBestPreferred = useMemo(() => bestByGroup(preferredCov), [preferredCov]);

  const possibleScore = useMemo(() => avgPct(groupBestPossible), [groupBestPossible]);
  const preferredScore = useMemo(() => avgPct(groupBestPreferred), [groupBestPreferred]);

  const topPossible = useMemo(
    () => [...possibleCov].sort((a, b) => b.pct - a.pct)[0] ?? null,
    [possibleCov],
  );

  const top3 = useMemo(
    () => [...possibleCov].sort((a, b) => b.pct - a.pct).slice(0, 3),
    [possibleCov],
  );

  const topAesId = top3[0]?.id ?? null;
  const blockers = useMemo(() => {
    if (!topAesId) return [];
    return cards
      .filter((c) => !c.available_aesthetics.includes(topAesId))
      .sort((a, b) => b.qty - a.qty);
  }, [cards, topAesId]);

  const totalValue = useMemo(
    () => cards.reduce((s, c) => s + priceFor(c) * c.qty, 0),
    [cards],
  );

  const totalQty = cards.reduce((s, c) => s + c.qty, 0);

  const groupsAll = groupAesthetics(visible);
  const groupOrder = useMemo(
    () => [...groupsAll.keys()].filter((g) => (groupBestPossible.get(g)?.pct ?? 0) > 0),
    [groupsAll, groupBestPossible],
  );

  return (
    <div className="insight-wrap consistency-wrap">
      <PageDescription id="consistency" title="Score — how cohesive is this deck visually?">
        <strong>Possible</strong> is the score the deck <em>could</em> reach if
        every card were swapped to its best printing in each group.{' '}
        <strong>Preferred</strong> is what the deck looks like with your
        currently-chosen preferred printings — always ≤ Possible, and the
        gap shows how much room is left without changing cards. The block at
        the bottom lists the cards that would have to change to push
        Possible up further.
      </PageDescription>

      <div className="cs-scores">
        <div className="cs-score-card big" style={{ background: heat(possibleScore / 100) }}>
          <div className="cs-score-num">{possibleScore}</div>
          <div className="cs-score-label">Possible</div>
          <div className="cs-score-sub">avg best-in-group across {groupBestPossible.size} groups</div>
        </div>
        <div className="cs-score-card sub">
          <div className="cs-score-num">
            {hasPreferredData ? preferredScore : '—'}
          </div>
          <div className="cs-score-label muted">Preferred</div>
          <div className="cs-score-sub muted">
            {hasPreferredData ? 'with current preferred printings' : 'restart backend to enable'}
          </div>
        </div>
        <div className="cs-score-card sub">
          <div className="cs-score-num">
            {topPossible ? Math.round(topPossible.pct * 100) : 0}%
          </div>
          <div className="cs-score-label muted">Top aesthetic</div>
          <div className="cs-score-sub muted">{topPossible ? topPossible.label : '—'}</div>
        </div>
      </div>

      <div className="cs-summary">
        <div className="cs-stat">
          <div className="cs-stat-num">{cards.length}</div>
          <div className="cs-stat-label muted">unique cards</div>
        </div>
        <div className="cs-stat">
          <div className="cs-stat-num">{totalQty}</div>
          <div className="cs-stat-label muted">total quantity</div>
        </div>
        <div className="cs-stat">
          <div className="cs-stat-num">{moneyShort(totalValue)}</div>
          <div className="cs-stat-label muted">deck value (preferred)</div>
        </div>
      </div>

      <h2>Best fit per group</h2>
      <div className="cs-groupbest">
        {groupOrder.map((g) => {
          const possible = groupBestPossible.get(g);
          const preferred = groupBestPreferred.get(g);
          if (!possible) return null;
          return (
            <div key={g} className={`cs-gb-row ${groupClass(g)}`}>
              <div className="cs-gb-group">{g}</div>
              <button
                type="button"
                className="cs-gb-label linklike"
                onClick={() => openDrawer(possible.id)}
                title="Open drawer for this aesthetic"
              >
                {possible.label}
              </button>
              <div
                className="cs-gb-bar"
                title={`Possible ${Math.round(possible.pct * 100)}%${
                  hasPreferredData && preferred
                    ? ` · Preferred ${Math.round(preferred.pct * 100)}%`
                    : ''
                }`}
              >
                <div className="cs-gb-bar-fill" style={{ width: `${possible.pct * 100}%` }} />
                {hasPreferredData && preferred && (
                  <div
                    className="cs-gb-bar-fill preferred"
                    style={{ width: `${preferred.pct * 100}%` }}
                  />
                )}
              </div>
              <div className="cs-gb-pct">{Math.round(possible.pct * 100)}%</div>
            </div>
          );
        })}
      </div>

      <h2>Top 3 aesthetics overall</h2>
      <ol className="cs-top3">
        {top3.map((r) => (
          <li key={r.id} className={groupClass(r.group)}>
            <button type="button" className="linklike cs-top-label" onClick={() => openDrawer(r.id)}>
              {r.label}
            </button>
            <span className="muted cs-top-group"> · {r.group}</span>
            <span className="cs-top-pct">{Math.round(r.pct * 100)}%</span>
            <span className="muted cs-top-qty">
              ({r.qty}/{totalQty})
            </span>
          </li>
        ))}
      </ol>

      {topAesId && blockers.length > 0 && (
        <>
          <h2>
            Cards holding back {top3[0].label}
            <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
              {blockers.length} card{blockers.length === 1 ? '' : 's'} not available in this aesthetic
            </span>
          </h2>
          <div className="cs-blockers">
            {blockers.slice(0, 24).map((c) => (
              <div key={c.name_normalized} className="cs-blocker">
                {c.default?.image_art_crop && (
                  <img src={c.default.image_art_crop} alt="" loading="lazy" />
                )}
                <div className="cs-blocker-meta">
                  <span className="cs-blocker-qty">{c.qty}×</span>
                  <span className="cs-blocker-name">{c.name}</span>
                </div>
              </div>
            ))}
            {blockers.length > 24 && (
              <div className="cs-blocker more muted">
                +{blockers.length - 24} more
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface CovRow {
  id: string;
  label: string;
  group: string;
  qty: number;
  unique: number;
  pct: number;
}

function preferredCoverage(cards: PerCardRow[], aesthetics: Aesthetic[]): CovRow[] {
  const totalQty = cards.reduce((s, c) => s + c.qty, 0) || 1;
  return aesthetics.map((a) => {
    let qty = 0;
    let unique = 0;
    for (const c of cards) {
      const list = c.default_aesthetics ?? [];
      if (list.includes(a.id)) {
        qty += c.qty;
        unique++;
      }
    }
    return {
      id: a.id,
      label: a.label,
      group: a.group ?? 'Other',
      qty,
      unique,
      pct: qty / totalQty,
    };
  });
}

function bestByGroup(rows: CovRow[]): Map<string, CovRow> {
  const m = new Map<string, CovRow>();
  for (const r of rows) {
    const cur = m.get(r.group);
    if (!cur || r.pct > cur.pct) m.set(r.group, r);
  }
  return m;
}

function avgPct(byGroup: Map<string, CovRow>): number {
  let sum = 0;
  let n = 0;
  for (const b of byGroup.values()) {
    if (b.pct <= 0) continue;
    sum += b.pct;
    n++;
  }
  return n === 0 ? 0 : Math.round((sum / n) * 100);
}
