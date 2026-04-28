import { useMemo, useState } from 'react';
import type { Aesthetic, PerCardExample, PerCardRow } from '../api';
import { filterCards, groupAesthetics, useSpotlightMatcher, useStore } from '../store';
import { groupClass } from './insightsUtil';

/**
 * Coverage view — interactive Tufte-style matrix.
 *
 * Each row is a unique card; each column is one aesthetic. A small filled
 * square = "this card is available with that aesthetic". The view is
 * sortable (click any header), the column band tints each group with its
 * own color so groups stay visually distinct, and a per-group summary
 * row shows aggregate coverage as a mini bar.
 *
 * Cell interactions:
 *   - Click an "on" cell:    open the drawer for that aesthetic.
 *   - Ctrl/Cmd-click:        open the matching printing on Scryfall.
 *   - Click a column header: sort rows by that column (toggle asc/desc).
 *   - Click "Card" / "Qty" / "#": sort by name / quantity / total coverage.
 */
export function PerCardView() {
  const result = useStore((s) => s.result)!;
  const aesthetics = useStore((s) => s.aesthetics);
  const selected = useStore((s) => s.selectedAesthetics);
  const { match: spotMatch } = useSpotlightMatcher();
  const density = useStore((s) => s.coverageDensity);
  const openDrawer = useStore((s) => s.openDrawer);

  const filtered = useMemo(() => {
    // Coverage always treats `paper_only` as a hard requirement: digital-only
    // printings are out of scope here, and showing rows that have no paper
    // version at all just produces empty rows. We force the side-filter set
    // to include `paper_only` (when the aesthetic exists) before computing
    // the row set; the user can't toggle it off from this view.
    const forced = new Set(selected);
    if (aesthetics.some((a) => a.id === 'paper_only')) forced.add('paper_only');
    // ALSO apply the spotlight + free-text card-name / Scryfall-syntax
    // filter here (not just inside the row render) so the row count,
    // group coverage stats, and empty state all reflect the visible set.
    return filterCards(result.per_card, forced, aesthetics).filter(spotMatch);
  }, [result.per_card, selected, aesthetics, spotMatch]);

  // Show columns for selected aesthetics, or all if nothing is selected.
  // Preserve canonical group ordering from groupAesthetics().
  const cols = useMemo(() => {
    const g = groupAesthetics(aesthetics);
    const out: Aesthetic[] = [];
    for (const [, items] of g) {
      for (const a of items) {
        if (selected.size === 0 || selected.has(a.id)) out.push(a);
      }
    }
    return out;
  }, [aesthetics, selected]);

  // Group spans for the column header band.
  const groupSpans = useMemo(() => {
    const spans: { group: string; count: number; startIdx: number }[] = [];
    let i = 0;
    for (const a of cols) {
      const g = a.group ?? 'Other';
      const last = spans[spans.length - 1];
      if (last && last.group === g) last.count++;
      else spans.push({ group: g, count: 1, startIdx: i });
      i++;
    }
    return spans;
  }, [cols]);

  // For each column index, the corresponding group class (e.g. 'g-frame').
  const colGroupClass = useMemo(() => cols.map((a) => groupClass(a.group ?? 'Other')), [cols]);

  // Indices that mark the start of a new group (used for hairline divider).
  const groupBoundaries = useMemo(() => {
    const s = new Set<number>();
    for (let k = 1; k < groupSpans.length; k++) s.add(groupSpans[k].startIdx);
    return s;
  }, [groupSpans]);

  // Per-card coverage count over the visible columns only — drives the
  // "#" cell heatmap and the "by-#" sort.
  const coverageCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of filtered) {
      const has = new Set(c.available_aesthetics);
      let n = 0;
      for (const a of cols) if (has.has(a.id)) n++;
      m.set(c.name_normalized, n);
    }
    return m;
  }, [filtered, cols]);

  // Sort state. `key` is one of the meta columns or an aesthetic id.
  type SortKey = 'qty' | 'name' | 'num' | { aes: string };
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'qty',
    dir: 'desc',
  });

  const sameKey = (a: SortKey, b: SortKey) =>
    typeof a === 'string' && typeof b === 'string'
      ? a === b
      : typeof a === 'object' && typeof b === 'object'
        ? a.aes === b.aes
        : false;

  const toggleSort = (key: SortKey, defaultDir: 'asc' | 'desc' = 'desc') => {
    setSort((cur) =>
      sameKey(cur.key, key)
        ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: defaultDir },
    );
  };

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dirMul = sort.dir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      let cmp = 0;
      if (sort.key === 'qty') {
        cmp = a.qty - b.qty;
      } else if (sort.key === 'name') {
        cmp = a.name.localeCompare(b.name);
      } else if (sort.key === 'num') {
        cmp = (coverageCounts.get(a.name_normalized) ?? 0) - (coverageCounts.get(b.name_normalized) ?? 0);
      } else {
        const aid = sort.key.aes;
        const aHas = a.available_aesthetics.includes(aid) ? 1 : 0;
        const bHas = b.available_aesthetics.includes(aid) ? 1 : 0;
        cmp = aHas - bHas;
      }
      if (cmp === 0) cmp = a.name.localeCompare(b.name);
      else cmp *= dirMul;
      return cmp;
    });
    return arr;
  }, [filtered, sort, coverageCounts]);

  // Group-level coverage summary — what fraction of (cards × group's
  // aesthetics) cells are filled for each group.
  const groupSummary = useMemo(() => {
    const out: Record<string, { filled: number; total: number; pct: number }> = {};
    for (const span of groupSpans) {
      const aIds = cols.slice(span.startIdx, span.startIdx + span.count).map((a) => a.id);
      let filled = 0;
      for (const c of filtered) {
        const has = new Set(c.available_aesthetics);
        for (const id of aIds) if (has.has(id)) filled++;
      }
      const total = filtered.length * aIds.length;
      out[span.group] = { filled, total, pct: total ? filled / total : 0 };
    }
    return out;
  }, [filtered, cols, groupSpans]);

  const maxCoverage = cols.length || 1;

  return (
    <div className="coverage-wrap" data-density={density}>
      <table className="coverage-table interactive">
        <thead>
          {/* Group color band */}
          <tr className="cov-group-row">
            <th colSpan={3}></th>
            {groupSpans.map((g, i) => {
              const cls = groupClass(g.group);
              const sum = groupSummary[g.group];
              return (
                <th
                  key={g.group + i}
                  colSpan={g.count}
                  className={`cov-group-th ${cls}` + (i > 0 ? ' bdr' : '')}
                  title={`${g.group} — ${(sum.pct * 100).toFixed(0)}% of (cards × ${g.count} aesthetics) covered`}
                >
                  <div className="cov-group-h">
                    <span className="cov-group-name">{g.group}</span>
                    <span className="cov-group-pct">{Math.round(sum.pct * 100)}%</span>
                  </div>
                  <div className="cov-group-bar" aria-hidden>
                    <div className="cov-group-bar-fill" style={{ width: `${sum.pct * 100}%` }} />
                  </div>
                </th>
              );
            })}
          </tr>
          {/* Aesthetic column headers (sortable) */}
          <tr className="cov-head-row">
            <SortableTh
              className="cov-qty"
              active={sort.key === 'qty'}
              dir={sort.dir}
              onClick={() => toggleSort('qty', 'desc')}
            >
              Qty
            </SortableTh>
            <SortableTh
              className="cov-name"
              active={sort.key === 'name'}
              dir={sort.dir}
              onClick={() => toggleSort('name', 'asc')}
            >
              Card
            </SortableTh>
            <SortableTh
              className="cov-num"
              active={sort.key === 'num'}
              dir={sort.dir}
              onClick={() => toggleSort('num', 'desc')}
              title="Aesthetics this card has (click to sort)"
            >
              #
            </SortableTh>
            {cols.map((a, i) => {
              return (
                <th
                  key={a.id}
                  className={`cov-aes-th ${colGroupClass[i]}` + (groupBoundaries.has(i) ? ' bdr' : '')}
                  title={`${a.label}${a.description ? ` — ${a.description}` : ''}\nClick to open aesthetic details · Shift-click to sort`}
                  onClick={(e) => {
                    if (e.shiftKey) {
                      toggleSort({ aes: a.id }, 'desc');
                    } else {
                      openDrawer(a.id);
                    }
                  }}
                  role="button"
                >
                  <span className="cov-aes-label">{a.label}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => {
            return (
              <Row
                key={c.name_normalized}
                card={c}
                cols={cols}
                colGroupClass={colGroupClass}
                groupBoundaries={groupBoundaries}
                coverage={coverageCounts.get(c.name_normalized) ?? 0}
                maxCoverage={maxCoverage}
                onPickAesthetic={openDrawer}
              />
            );
          })}
        </tbody>
      </table>
      {!sorted.length && (
        <div className="empty-state">
          <h3>No cards match the current filters</h3>
        </div>
      )}
    </div>
  );
}

function SortableTh({
  className,
  active,
  dir,
  onClick,
  title,
  children,
}: {
  className?: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <th
      className={(className ?? '') + ' sortable' + (active ? ' active' : '')}
      onClick={onClick}
      title={title}
    >
      <span className="sort-inner">
        {children}
        <span className="sort-ind" aria-hidden>
          {active ? (dir === 'asc' ? '▲' : '▼') : '·'}
        </span>
      </span>
    </th>
  );
}

function Row({
  card,
  cols,
  colGroupClass,
  groupBoundaries,
  coverage,
  maxCoverage,
  onPickAesthetic,
}: {
  card: PerCardRow;
  cols: Aesthetic[];
  colGroupClass: string[];
  groupBoundaries: Set<number>;
  coverage: number;
  maxCoverage: number;
  onPickAesthetic: (id: string, card: { oracle_id: string | null; name: string }) => void;
}) {
  const [hover, setHover] = useState<{ x: number; y: number; img: string } | null>(null);
  const defaultImg = card.default?.image_normal ?? null;
  const setCode = card.default?.set?.toUpperCase();
  const has = useMemo(() => new Set(card.available_aesthetics), [card.available_aesthetics]);

  const updatePos = (clientX: number, clientY: number, img: string | null) => {
    if (!img) return;
    const padX = 16;
    const popW = 296;
    const popH = 412;
    let x = clientX + padX;
    if (x + popW > window.innerWidth) x = clientX - popW - padX;
    let y = clientY - popH / 2;
    if (y < 8) y = 8;
    if (y + popH > window.innerHeight) y = window.innerHeight - popH - 8;
    setHover({ x, y, img });
  };

  const covPct = maxCoverage ? coverage / maxCoverage : 0;

  return (
    <>
      <tr
        className={'cov-row' + (card.resolved ? '' : ' unresolved')}
        onMouseMove={(e) => {
          if (!defaultImg) return;
          // Row-level hover: only fire when the cursor is over the
          // sticky-left card label cell (per-cell handlers cover the rest).
          const target = e.target as HTMLElement;
          if (target.closest('.cov-name')) updatePos(e.clientX, e.clientY, defaultImg);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <td className="cov-qty">{card.qty}</td>
        <td className="cov-name">
          {card.default?.image_art_crop && (
            <span className="cov-thumb" aria-hidden>
              <img src={card.default.image_art_crop} alt="" loading="lazy" />
            </span>
          )}
          <span className="cov-card-name">{card.name}</span>
          {setCode && <span className="cov-set">{setCode}</span>}
        </td>
        <td className="cov-num" title={`${coverage} of ${maxCoverage} aesthetics`}>
          <div className="cov-num-wrap">
            <span className="cov-num-val">
              {card.resolved ? coverage : <span className="warn">?</span>}
            </span>
            <span className="cov-num-bar" aria-hidden>
              <span className="cov-num-bar-fill" style={{ width: `${covPct * 100}%` }} />
            </span>
          </div>
        </td>
        {cols.map((a, i) => {
          const present = has.has(a.id);
          const ex = card.examples[a.id];
          const versionCount = card.version_counts?.[a.id] ?? 0;
          return (
            <td
              key={a.id}
              className={
                'cov-cell ' +
                colGroupClass[i] +
                (present ? ' on' : ' off') +
                (groupBoundaries.has(i) ? ' bdr' : '')
              }
              title={
                present
                  ? `${a.label} — ${versionCount} version${versionCount === 1 ? '' : 's'} available\n${ex?.set?.toUpperCase() ?? ''} ${ex?.collector_number ?? ''}\nClick: open aesthetic · Ctrl-click: open on Scryfall`
                  : `${a.label} — not available`
              }
              onMouseMove={(e) => {
                if (!present) return;
                updatePos(e.clientX, e.clientY, ex?.image_normal ?? defaultImg);
              }}
              onMouseLeave={() => setHover(null)}
              onClick={(e) => {
                  if (!present) return;
                  if (e.ctrlKey || e.metaKey) {
                    const url = scryfallUrlForExample(card.name, ex);
                    window.open(url, '_blank', 'noopener,noreferrer');
                    return;
                  }
                  onPickAesthetic(a.id, { oracle_id: card.oracle_id, name: card.name });
                }}
              role={present ? 'button' : undefined}
            >
              {present ? (
                <span className="cov-block">
                  <span className="cov-mark" aria-hidden />
                  {versionCount > 0 && (
                    <span className="cov-count">{versionCount}</span>
                  )}
                </span>
              ) : (
                <span className="cov-mark" aria-hidden />
              )}
            </td>
          );
        })}
      </tr>
      {hover && (
        <tr className="hover-row">
          <td colSpan={3 + cols.length} style={{ padding: 0, border: 0 }}>
            <div className="card-popover floating" style={{ left: hover.x, top: hover.y }}>
              <img src={hover.img} alt="" />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function scryfallUrlForExample(name: string, p: PerCardExample | null | undefined): string {
  if (p?.set && p?.collector_number) {
    return `https://scryfall.com/card/${encodeURIComponent(p.set)}/${encodeURIComponent(p.collector_number)}`;
  }
  return `https://scryfall.com/search?q=${encodeURIComponent(`!"${name}"`)}`;
}
