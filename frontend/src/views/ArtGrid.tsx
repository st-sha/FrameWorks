import { useMemo } from 'react';
import type { PerCardExample } from '../api';
import { useSpotlightMatcher, useStore } from '../store';

export function ArtGridView() {
  const result = useStore((s) => s.result)!;
  const aesthetics = useStore((s) => s.aesthetics);
  const selected = useStore((s) => s.selectedAesthetics);
  const { hasSpot: hasSpotlight, match: spotMatch } = useSpotlightMatcher();

  // Art Grid is a coverage matrix: every (resolved) card row is always shown.
  // Sidebar filters only narrow the COLUMNS that are visible; they never
  // hide rows. Empty columns (no card in the deck has a printing for that
  // aesthetic) are dropped entirely so they don't waste horizontal space.
  const rows = useMemo(
    () => result.per_card.filter((c) => c.resolved),
    [result.per_card],
  );

  const cols = useMemo(() => {
    const scope = selected.size === 0 ? aesthetics : aesthetics.filter((a) => selected.has(a.id));
    return scope.filter((a) => rows.some((c) => c.examples[a.id]?.image_normal));
  }, [aesthetics, selected, rows]);

  const hasSpotlight_unused = false; void hasSpotlight_unused;
  // (`hasSpotlight` and `spotMatch` are now provided by useSpotlightMatcher above.)

  // Match a row's "default" printing against an aesthetic's example, so we
  // can flag the preferred cell for subtle highlighting.
  const isPreferred = (def: PerCardExample | null | undefined, ex: PerCardExample | undefined) =>
    !!def && !!ex && def.set === ex.set && def.collector_number === ex.collector_number;

  return (
    <div className="art-grid-wrap">
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
          <div key={a.id} className="art-grid-header" title={a.description || a.label}>
            <div className="hdr-label">{a.label}</div>
            {a.group && <div className="hdr-group">{a.group}</div>}
          </div>
        ))}

        {rows.map((c) => {
          const matchesSpot = !hasSpotlight || spotMatch(c);
          return (
            <RowGroup
              key={c.name_normalized}
              name={c.name}
              qty={c.qty}
              setCode={c.default?.set?.toUpperCase() ?? null}
              preferred={c.default}
              dim={!matchesSpot}
            >
              {/* Preferred column always renders the default printing
                  full-size, with the same affordances as a normal cell so
                  the user can compare it directly against the alternates. */}
              <ArtCell
                key="__preferred__"
                name={c.name}
                printing={c.default ?? undefined}
                dim={!matchesSpot}
                preferred
                sticky
              />
              {cols.map((a) => {
                const ex = c.examples[a.id];
                return (
                  <ArtCell
                    key={a.id}
                    name={c.name}
                    printing={ex}
                    dim={!matchesSpot}
                    preferred={isPreferred(c.default, ex)}
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
  );
}

function RowGroup({
  name,
  qty,
  setCode,
  preferred,
  dim,
  children,
}: {
  name: string;
  qty: number;
  setCode: string | null;
  preferred: PerCardExample | null | undefined;
  dim?: boolean;
  children: React.ReactNode;
}) {
  // Prefer art crop (square-ish, faster), fall back to the full image.
  const thumb = preferred?.image_art_crop ?? preferred?.image_normal ?? null;
  const url =
    preferred?.set && preferred?.collector_number
      ? `https://scryfall.com/card/${encodeURIComponent(preferred.set)}/${encodeURIComponent(preferred.collector_number)}`
      : null;
  const dimCls = dim ? ' spotlight-dim' : '';
  return (
    <>
      <div className={'art-grid-name sticky-left' + dimCls}>
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

function ArtCell({ name, printing, dim, preferred, sticky }: { name: string; printing: PerCardExample | undefined; dim?: boolean; preferred?: boolean; sticky?: boolean }) {
  if (!printing?.image_normal) {
    return <div className={'art-cell empty' + (dim ? ' spotlight-dim' : '') + (sticky ? ' sticky-left-2' : '')}>·</div>;
  }
  const scryUrl = `https://scryfall.com/card/${encodeURIComponent(printing.set ?? '')}/${encodeURIComponent(printing.collector_number ?? '')}`;
  const tcgUrl = tcgplayerSearchUrl(name, printing.set);
  const priceLabel =
    printing.price_usd != null
      ? `$${printing.price_usd < 10 ? printing.price_usd.toFixed(2) : printing.price_usd.toFixed(0)}`
      : '—';
  const cls =
    'art-cell' +
    (dim ? ' spotlight-dim' : '') +
    (preferred ? ' preferred' : '') +
    (sticky ? ' sticky-left-2' : '');
  return (
    <div className={cls} title={preferred ? `${name} — preferred printing` : undefined}>
      <a
        className="art-cell-img"
        href={scryUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`${name} — ${printing.set?.toUpperCase() ?? ''} ${printing.collector_number ?? ''}`}
      >
        <img src={printing.image_normal} alt="" loading="lazy" draggable={false} />
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
