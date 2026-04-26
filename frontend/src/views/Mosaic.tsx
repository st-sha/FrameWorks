import { useMemo } from 'react';
import { filterCards, useAestheticIndex, useSpotlightMatcher, useStore } from '../store';
import { groupClass } from './insightsUtil';
import { PageDescription } from './PageDescription';

/**
 * Mosaic — the entire deck rendered as a wall of art crops, sorted to
 * surface aesthetic cohesion. Cards that *match* the current Spotlight
 * (or all selected aesthetics, when no spotlight is set) render at full
 * saturation; non-matching cards are dimmed and grayscaled. Each tile
 * carries a small color dot strip showing which groups it has, so you
 * can scan for diversity at a glance.
 */
export function MosaicView() {
  const result = useStore((s) => s.result)!;
  const aesthetics = useStore((s) => s.aesthetics);
  const selected = useStore((s) => s.selectedAesthetics);
  const { spotlight, spotExcluded, hasSpot, match: matchFn } = useSpotlightMatcher();
  const openDrawer = useStore((s) => s.openDrawer);

  const cards = useMemo(
    () => filterCards(result.per_card, selected, aesthetics),
    [result.per_card, selected, aesthetics],
  );

  // The matcher (`matchFn`) is provided by useSpotlightMatcher; combines
  // include / exclude / side-filter precedence in one place.

  const aesById = useAestheticIndex();

  // Sort: matches first, then by quantity desc, then alpha. Stable.
  // Precompute matchFn(c) once per card so the comparator is O(n log n)
  // comparisons on memoized booleans instead of O(n log n) matchFn calls.
  const sorted = useMemo(() => {
    const matched = new Map<string, boolean>();
    for (const c of cards) matched.set(c.name_normalized, matchFn(c));
    const arr = [...cards];
    arr.sort((a, b) => {
      const aMatch = matched.get(a.name_normalized) ?? true;
      const bMatch = matched.get(b.name_normalized) ?? true;
      if (aMatch !== bMatch) return aMatch ? -1 : 1;
      if (b.qty !== a.qty) return b.qty - a.qty;
      return a.name.localeCompare(b.name);
    });
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, spotlight, spotExcluded, selected]);

  // Stats panel
  const matchQty = useMemo(() => {
    let q = 0;
    for (const c of cards) if (matchFn(c)) q += c.qty;
    return q;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, spotlight, spotExcluded, selected]);
  const totalQty = cards.reduce((s, c) => s + c.qty, 0);

  // Use the spotlight printing if set, else preferred (default).
  const primaryId = spotlight[0] ?? null;

  return (
    <div className="mosaic-wrap">
      <PageDescription id="mosaic" title="Mosaic — see the whole deck as a wall of art">
        Every card is rendered as an art crop, sorted matches-first. Pick a
        Spotlight aesthetic on the right: matching cards stay in color,
        non-matching cards desaturate. The colored dots on each tile show
        which aesthetic <em>groups</em> that card belongs to, so you can spot
        a stray border or treatment at a glance. Click a tile to drill into
        the aesthetic detail drawer.
      </PageDescription>
      <div className="mosaic-stats muted">
        {hasSpot || selected.size > 0 ? (
          <>
            <strong style={{ color: 'var(--text)' }}>
              {matchQty}/{totalQty}
            </strong>{' '}
            cards match the highlighted aesthetic{spotlight.length + spotExcluded.length === 1 ? '' : 's'}
            {primaryId && (
              <>
                {' · primary printing: '}
                <strong style={{ color: 'var(--text)' }}>
                  {aesById.get(primaryId)?.label}
                </strong>
              </>
            )}
          </>
        ) : (
          <>Showing {totalQty} cards · pick a spotlight to highlight matches</>
        )}
      </div>

      <div className="mosaic-grid">
        {sorted.map((c) => {
          const matches = matchFn(c);
          const printing =
            (primaryId && c.examples[primaryId]) || c.default;
          const img = printing?.image_art_crop ?? printing?.image_normal ?? null;
          // Pull a small set of distinct group-classes for the tile dots.
          const groups = Array.from(
            new Set(
              c.available_aesthetics
                .map((id) => aesById.get(id)?.group ?? null)
                .filter((g): g is string => !!g),
            ),
          );
          return (
            <div
              key={c.name_normalized}
              className={'mosaic-tile' + (matches ? '' : ' dim spotlight-dim')}
              title={`${c.qty}× ${c.name}`}
              onClick={() => {
                // Click: open drawer for the first INCLUDED spotlight this
                // card has, else the first available aesthetic.
                const aid =
                  c.available_aesthetics.find((id) => spotlight.includes(id)) ??
                  c.available_aesthetics[0];
                if (aid) openDrawer(aid);
              }}
            >
              {img ? (
                <img src={img} alt="" loading="lazy" draggable={false} />
              ) : (
                <div className="mosaic-empty">{c.name}</div>
              )}
              {c.qty > 1 && <span className="mosaic-qty">{c.qty}×</span>}
              <div className="mosaic-dots">
                {groups.map((g) => (
                  <span key={g} className={`mosaic-dot ${groupClass(g)}`} title={g} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
