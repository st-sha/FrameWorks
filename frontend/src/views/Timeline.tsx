import { useMemo } from 'react';
import { filterCards, useSpotlightMatcher, useStore } from '../store';
import { frameEra, ymd } from './insightsUtil';
import { PageDescription } from './PageDescription';

/**
 * Frame-Era Timeline — every card placed on a horizontal axis at its
 * (preferred or spotlight) printing's release date. Color bands across
 * the top mark frame eras (Alpha → Classic → Modern → M15 → Future).
 *
 * Hover a tile for the card's name and printing details. Click a tile to
 * open it on Scryfall. Useful to immediately see "this deck spans 30
 * years" vs "all from one window".
 */
export function TimelineView() {
  const result = useStore((s) => s.result)!;
  const aesthetics = useStore((s) => s.aesthetics);
  const selected = useStore((s) => s.selectedAesthetics);
  const spotlight = useStore((s) => s.galleryAesthetics);
  const { hasSpot, match: spotMatch } = useSpotlightMatcher();

  const cards = useMemo(
    () => filterCards(result.per_card, selected, aesthetics),
    [result.per_card, selected, aesthetics],
  );
  const primaryId = spotlight[0] ?? null;

  // Build entries with usable release dates.
  const entries = useMemo(() => {
    const out: Array<{
      key: string;
      name: string;
      qty: number;
      img: string | null;
      released: string;
      year: number;
      day: number; // days since 1970-01-01
      set: string | null;
      cn: string | null;
      frame: string | null;
    }> = [];
    for (const c of cards) {
      if (hasSpot && !spotMatch(c)) continue;
      const p = (primaryId && c.examples[primaryId]) || c.default;
      if (!p?.released_at) continue;
      const d = new Date(p.released_at);
      if (Number.isNaN(d.getTime())) continue;
      out.push({
        key: c.name_normalized,
        name: c.name,
        qty: c.qty,
        img: p.image_art_crop ?? p.image_normal ?? null,
        released: ymd(p.released_at),
        year: d.getUTCFullYear(),
        day: Math.floor(d.getTime() / (24 * 3600 * 1000)),
        set: p.set,
        cn: p.collector_number,
        frame: p.frame,
      });
    }
    out.sort((a, b) => a.day - b.day);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, primaryId, spotlight, hasSpot]);

  if (entries.length === 0) {
    return (
      <div className="insight-wrap timeline-wrap">
        <PageDescription id="timeline" title="Timeline — when each printing was released">
          Every card placed on a horizontal axis at its preferred (or spotlight)
          printing's release date, with frame-era bands across the top. Useful
          to see whether your deck is centered in one window or spans 30 years.
          If the timeline looks empty, the backend may not yet have release-date
          data — hit Refresh on the data status banner.
        </PageDescription>
        <div className="empty-state">
          <h3>No release dates available</h3>
          <div className="muted">Try refreshing card data or pick a different spotlight.</div>
        </div>
      </div>
    );
  }

  const minDay = entries[0].day;
  const maxDay = entries[entries.length - 1].day;
  const span = Math.max(1, maxDay - minDay);
  const minYear = entries[0].year;
  const maxYear = entries[entries.length - 1].year;

  // Year tick positions (every year, but we'll only label every Nth based
  // on width).
  const years: number[] = [];
  for (let y = minYear; y <= maxYear; y++) years.push(y);
  const yearStep = years.length > 30 ? 5 : years.length > 15 ? 2 : 1;

  // Frame era bands: only show those that intersect the data range.
  const eras: Array<{ label: string; start: number; end: number; cls: string }> = [
    { label: 'Alpha–4th', start: 1993, end: 1996, cls: 'era-93' },
    { label: 'Classic', start: 1997, end: 2002, cls: 'era-97' },
    { label: 'Modern frame', start: 2003, end: 2014, cls: 'era-03' },
    { label: 'M15 frame', start: 2015, end: 2099, cls: 'era-15' },
  ];
  const eraInRange = eras.filter((e) => e.end >= minYear && e.start <= maxYear);

  const yearToFrac = (y: number) => {
    // Approximate by year-only; sufficient for the band overlay.
    const day = Math.floor(new Date(`${y}-01-01`).getTime() / (24 * 3600 * 1000));
    return Math.max(0, Math.min(1, (day - minDay) / span));
  };

  // Lay out tiles horizontally, with vertical jitter rows to avoid overlap.
  // We use a simple greedy row assignment based on x position + tile width.
  const TILE_PX = 36;
  const ROW_PX = 50;
  const TRACK_PADDING = 8;
  // Width of the timeline body (set via CSS to fill available space).
  // We position tiles by percent so this is responsive.
  type Placed = (typeof entries)[number] & { row: number; xPct: number };
  const placed: Placed[] = [];
  const lastXByRow: number[] = [];
  const totalWidthGuess = 1000; // pixels, used only to compute row collisions
  for (const e of entries) {
    const xPct = (e.day - minDay) / span;
    const xPx = xPct * totalWidthGuess;
    let row = 0;
    while (lastXByRow[row] !== undefined && xPx - lastXByRow[row] < TILE_PX + 4) row++;
    lastXByRow[row] = xPx;
    placed.push({ ...e, row, xPct });
  }
  const rowCount = lastXByRow.length || 1;
  const trackHeight = rowCount * ROW_PX + TRACK_PADDING * 2;

  return (
    <div className="insight-wrap timeline-wrap">
      <PageDescription id="timeline" title="Timeline — when each printing was released">
        Every card placed on a horizontal axis at its preferred (or spotlight)
        printing's release date, with colored bands marking the major frame
        eras (Alpha, Classic, Modern, M15+). Hover a tile to see card and
        printing details; click to open it on Scryfall.
      </PageDescription>
      <div className="muted" style={{ marginBottom: 6, fontSize: 11 }}>
        {entries.length} cards · {minYear}–{maxYear} ·{' '}
        printing source: <strong style={{ color: 'var(--text)' }}>
          {primaryId ? 'spotlight' : 'preferred'}
        </strong>
      </div>

      <div className="timeline-frame">
        {/* Era bands */}
        <div className="timeline-eras">
          {eraInRange.map((e) => {
            const left = yearToFrac(Math.max(minYear, e.start));
            const right = yearToFrac(Math.min(maxYear + 1, e.end + 1));
            return (
              <div
                key={e.label}
                className={'tl-era ' + e.cls}
                style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }}
                title={e.label}
              >
                <span>{e.label}</span>
              </div>
            );
          })}
        </div>

        {/* Year axis */}
        <div className="timeline-axis">
          {years.map((y, i) =>
            i % yearStep === 0 || i === years.length - 1 ? (
              <span
                key={y}
                className="tl-tick"
                style={{ left: `${yearToFrac(y) * 100}%` }}
              >
                {y}
              </span>
            ) : null,
          )}
        </div>

        {/* Tiles */}
        <div className="timeline-track" style={{ height: trackHeight }}>
          {placed.map((e) => (
            <a
              key={e.key + '-' + e.released}
              className={'tl-tile'}
              href={
                e.set && e.cn
                  ? `https://scryfall.com/card/${encodeURIComponent(e.set)}/${encodeURIComponent(e.cn)}`
                  : `https://scryfall.com/search?q=${encodeURIComponent(`!"${e.name}"`)}`
              }
              target="_blank"
              rel="noopener noreferrer"
              style={{
                // Clamp left so the tile never extends past the right edge
                // of the responsive timeline track.
                left: `min(${e.xPct * 100}%, calc(100% - ${TILE_PX}px))`,
                top: TRACK_PADDING + e.row * ROW_PX,
                width: TILE_PX,
              }}
              title={`${e.qty}× ${e.name}\n${e.set?.toUpperCase() ?? ''} ${e.cn ?? ''} · ${e.released}\n${frameEra(e.frame)}`}
            >
              {e.img ? (
                <img src={e.img} alt="" loading="lazy" draggable={false} />
              ) : (
                <div className="tl-tile-empty">{e.name.slice(0, 2)}</div>
              )}
              {e.qty > 1 && <span className="tl-qty">{e.qty}</span>}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
