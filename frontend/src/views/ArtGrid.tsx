import { useEffect, useMemo, useRef } from 'react';
import type { PerCardExample } from '../api';
import { useSpotlightMatcher, useStore } from '../store';
import { groupClass } from './insightsUtil';
import { CardImage } from './MtgCard';

export function ArtGridView() {
  const result = useStore((s) => s.result)!;
  const aesthetics = useStore((s) => s.aesthetics);
  const selected = useStore((s) => s.selectedAesthetics);
  const highlightPreferred = useStore((s) => s.artGridPreferredHighlight);
  const setHighlightPreferred = useStore((s) => s.setArtGridPreferredHighlight);
  const { hasSpot: hasSpotlight, match: spotMatch } = useSpotlightMatcher();

  // Art Grid is a coverage matrix: every (resolved) card row is shown,
  // unless the spotlight (top-bar include/exclude or card-name search)
  // filters it out — in which case the row is omitted entirely.
  // Sidebar filters narrow the COLUMNS that are visible; empty columns
  // are dropped so they don't waste horizontal space.
  const rows = useMemo(
    () => {
      const base = result.per_card.filter((c) => c.resolved);
      if (!hasSpotlight) return base;
      return base.filter((c) => spotMatch(c));
    },
    [result.per_card, hasSpotlight, spotMatch],
  );

  const cols = useMemo(() => {
    const scope = selected.size === 0 ? aesthetics : aesthetics.filter((a) => selected.has(a.id));
    return scope.filter((a) => rows.some((c) => c.examples[a.id]?.image_normal));
  }, [aesthetics, selected, rows]);

  // Match a row's "default" printing against an aesthetic's example, so we
  // can flag the preferred cell for subtle highlighting (when enabled).
  const isPreferred = (def: PerCardExample | null | undefined, ex: PerCardExample | undefined) =>
    !!def && !!ex && def.set === ex.set && def.collector_number === ex.collector_number;

  // Top horizontal scrollbar: a thin div pinned above the grid wrapper that
  // forwards its scroll position to the wrapper and vice versa. Useful on
  // wide tables — saves a trip to the bottom of the page just to scroll.
  const wrapRef = useRef<HTMLDivElement>(null);
  const topScrollRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  useEffect(() => {
    const sync = () => {
      const w = wrapRef.current;
      const top = topScrollRef.current;
      if (!w || !top) return;
      const inner = w.querySelector<HTMLDivElement>('.art-grid');
      const phantom = top.querySelector<HTMLDivElement>('.art-grid-top-scroll-phantom');
      if (!inner || !phantom) return;
      phantom.style.width = inner.scrollWidth + 'px';
    };
    sync();
    const ro = new ResizeObserver(sync);
    if (wrapRef.current) ro.observe(wrapRef.current);
    const inner = wrapRef.current?.querySelector('.art-grid');
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, [cols.length, rows.length]);
  const onTopScroll = () => {
    if (syncing.current) return;
    syncing.current = true;
    if (wrapRef.current && topScrollRef.current) {
      wrapRef.current.scrollLeft = topScrollRef.current.scrollLeft;
    }
    syncing.current = false;
  };
  const onWrapScroll = () => {
    if (syncing.current) return;
    syncing.current = true;
    if (wrapRef.current && topScrollRef.current) {
      topScrollRef.current.scrollLeft = wrapRef.current.scrollLeft;
    }
    syncing.current = false;
  };

  return (
    <>
      <div className="art-grid-toolbar">
        <label className="art-grid-toggle">
          <input
            type="checkbox"
            checked={highlightPreferred}
            onChange={(e) => setHighlightPreferred(e.target.checked)}
          />
          Highlight preferred printing
        </label>
      </div>
      <div
        className="art-grid-top-scroll"
        ref={topScrollRef}
        onScroll={onTopScroll}
        aria-hidden
      >
        <div className="art-grid-top-scroll-phantom" />
      </div>
      <div className="art-grid-wrap" ref={wrapRef} onScroll={onWrapScroll}>
        <div
          className="art-grid"
          style={{
            gridTemplateColumns: `minmax(220px, max-content) var(--card-size, 168px) repeat(${cols.length}, var(--card-size, 168px))`,
          }}
        >
          {/* Header row */}
          <div className="art-grid-header sticky-left">Card</div>
          <div className="art-grid-header sticky-left-2 preferred-col-header" title="The user's preferred printing">
            <div className="hdr-label">Preferred</div>
            <div className="hdr-group">your default</div>
          </div>
          {cols.map((a) => (
            <div
              key={a.id}
              className={'art-grid-header ' + groupClass(a.group)}
              title={a.description || a.label}
            >
              <div className="hdr-label">{a.label}</div>
              {a.group && <div className="hdr-group">{a.group}</div>}
            </div>
          ))}

          {rows.map((c) => {
            return (
              <RowGroup
                key={c.name_normalized}
                name={c.name}
                qty={c.qty}
                setCode={c.default?.set?.toUpperCase() ?? null}
                preferred={c.default}
              >
                {/* Preferred column always renders the default printing
                    full-size, with the same affordances as a normal cell so
                    the user can compare it directly against the alternates. */}
                <ArtCell
                  key="__preferred__"
                  name={c.name}
                  printing={c.default ?? undefined}
                  /* The dedicated Preferred column is its own column — it
                   * shouldn't ALSO get the per-cell preferred outline. */
                  preferred={false}
                  sticky
                />
                {cols.map((a) => {
                  const ex = c.examples[a.id];
                  return (
                    <ArtCell
                      key={a.id}
                      name={c.name}
                      printing={ex}
                      preferred={highlightPreferred && isPreferred(c.default, ex)}
                      groupCls={groupClass(a.group)}
                    />
                  );
                })}
              </RowGroup>
            );
          })}
        </div>
        {!rows.length && (
          <div className="empty-state">
            <h3>No cards in this deck</h3>
          </div>
        )}
        {rows.length > 0 && cols.length === 0 && (
          <div className="empty-state">
            <h3>No printings match the selected aesthetic columns</h3>
            <div>Try clearing some sidebar filters.</div>
          </div>
        )}
      </div>
    </>
  );
}

function RowGroup({
  name,
  qty,
  setCode,
  preferred,
  children,
}: {
  name: string;
  qty: number;
  setCode: string | null;
  preferred: PerCardExample | null | undefined;
  children: React.ReactNode;
}) {
  // Prefer art crop (square-ish, faster), fall back to the full image.
  const thumb = preferred?.image_art_crop ?? preferred?.image_normal ?? null;
  const url =
    preferred?.set && preferred?.collector_number
      ? `https://scryfall.com/card/${encodeURIComponent(preferred.set)}/${encodeURIComponent(preferred.collector_number)}`
      : null;
  return (
    <>
      <div className={'art-grid-name sticky-left'}>
        {thumb ? (
          url ? (
            <a
              className="row-thumb"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${name} — preferred printing`}
            >
              <img src={thumb} alt="" loading="lazy" draggable={false} />
            </a>
          ) : (
            <div className="row-thumb">
              <img src={thumb} alt="" loading="lazy" draggable={false} />
            </div>
          )
        ) : (
          <div className="row-thumb empty" aria-hidden />
        )}
        <div className="row-text">
          <div className="row-name">
            <span className="row-qty">{qty}×</span>
            <span className="row-card-name">{name}</span>
          </div>
          {setCode && <div className="row-set">{setCode}</div>}
        </div>
      </div>
      {children}
    </>
  );
}

function ArtCell({ name, printing, preferred, sticky, groupCls }: { name: string; printing: PerCardExample | undefined; preferred?: boolean; sticky?: boolean; groupCls?: string }) {
  if (!printing?.image_normal) {
    return <div className={'art-cell empty' + (sticky ? ' sticky-left-2' : '') + (groupCls ? ' ' + groupCls : '')}>·</div>;
  }
  const scryUrl = `https://scryfall.com/card/${encodeURIComponent(printing.set ?? '')}/${encodeURIComponent(printing.collector_number ?? '')}`;
  const tcgUrl = tcgplayerSearchUrl(name, printing.set);
  const priceLabel =
    printing.price_usd != null
      ? `$${printing.price_usd < 10 ? printing.price_usd.toFixed(2) : printing.price_usd.toFixed(0)}`
      : '—';
  const cls =
    'art-cell' +
    (preferred ? ' preferred' : '') +
    (sticky ? ' sticky-left-2' : '') +
    (groupCls ? ' ' + groupCls : '');
  return (
    <div className={cls} title={preferred ? `${name} — preferred printing` : undefined}>
      <a
        className="art-cell-img"
        href={scryUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`${name} — ${printing.set?.toUpperCase() ?? ''} ${printing.collector_number ?? ''}`}
      >
        <CardImage src={printing.image_normal} alt="" />
      </a>
      <div className="art-cell-meta">
        <span className="ac-set">{printing.set?.toUpperCase()}</span>
        <span className="ac-cn">{printing.collector_number}</span>
        <a
          className="ac-price tcg"
          href={tcgUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`TCGplayer market${printing.price_usd != null ? ` · $${printing.price_usd.toFixed(2)}` : ''}`}
          onClick={(e) => e.stopPropagation()}
        >
          TCG {priceLabel}
        </a>
      </div>
    </div>
  );
}

function tcgplayerSearchUrl(name: string, setCode: string | null): string {
  // TCGplayer's search accepts a free-text query. Adding the set code
  // narrows results when there are many printings of the card.
  const q = setCode ? `${name} ${setCode.toUpperCase()}` : name;
  return `https://www.tcgplayer.com/search/magic/product?q=${encodeURIComponent(q)}&productLineName=magic`;
}
