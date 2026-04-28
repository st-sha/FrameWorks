import { useEffect, useMemo, useRef, useState } from 'react';
import type { PerCardExample, PerCardRow, PrintingDetail } from '../api';
import { api } from '../api';
import { filterCards, useAestheticIndex, useStore } from '../store';
import { buildMatcher } from '../scryfallQuery';
import { MtgCard, CardImage } from './MtgCard';

export function GalleryView() {
  const result = useStore((s) => s.result)!;
  const aesthetics = useStore((s) => s.aesthetics);
  const selected = useStore((s) => s.selectedAesthetics);
  const galleryAesthetics = useStore((s) => s.galleryAesthetics);
  const spotExcluded = useStore((s) => s.gallerySpotExcluded);
  const setGalleryAesthetics = useStore((s) => s.setGalleryAesthetics);
  const printingStrategy = useStore((s) => s.printingStrategy);
  // Free-text card filter from the toolbar. Now interpreted as
  // Scryfall-syntax (https://scryfall.com/docs/syntax) when it contains
  // operator-ish characters; bare words remain a name-substring match
  // for back-compat with the legacy textbox.
  const cardNameFilter = useStore((s) => s.cardNameFilter);
  const matcher = useMemo(() => buildMatcher(cardNameFilter), [cardNameFilter]);

  const filtered = useMemo(
    () => {
      const base = filterCards(result.per_card, selected, aesthetics);
      if (!cardNameFilter.trim()) return base;
      return base.filter(matcher.match);
    },
    [result.per_card, selected, aesthetics, cardNameFilter, matcher],
  );

  // Drop spotlight ids that are no longer in the active filter selection,
  // so the indicator never reflects stale entries.
  useEffect(() => {
    if (selected.size === 0) return;
    const stale = galleryAesthetics.filter((id) => !selected.has(id));
    if (stale.length > 0) {
      setGalleryAesthetics(galleryAesthetics.filter((id) => selected.has(id)));
    }
  }, [selected, galleryAesthetics, setGalleryAesthetics]);

  // Primary spotlight: first selected (if any). Determines which printing
  // is rendered as the main Gallery card.
  const primaryId = galleryAesthetics[0] ?? null;
  const focusAes = aesthetics.find((a) => a.id === primaryId) ?? null;
  const idToAes = useAestheticIndex();

  const [hover, setHover] = useState<HoverState | null>(null);
  /** When non-null, the popover is pinned to this card and ignores hover
   *  events on other cards until the user explicitly unpins. */
  const [pinned, setPinned] = useState<PerCardRow | null>(null);
  /** Card whose multi-printing modal is currently open. */
  const [expandCard, setExpandCard] = useState<PerCardRow | null>(null);
  const cache = useRef(new Map<string, PrintingDetail[]>());
  // Cap to prevent unbounded growth on long sessions: each entry holds
  // up to 24 printing dicts (~10KB), so 200 entries ≈ 2MB ceiling.
  const CACHE_MAX = 200;
  const cacheSet = (key: string, val: PrintingDetail[]) => {
    const m = cache.current;
    if (m.has(key)) m.delete(key);
    m.set(key, val);
    while (m.size > CACHE_MAX) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  };

  const openHover = (
    card: PerCardRow,
    anchor: { x: number; y: number },
  ) => {
    if (!card.oracle_id) return;
    if (pinned) return; // hover is suppressed while a card is pinned
    const key = `${card.oracle_id}|${focusAes?.id ?? ''}`;
    const cached = cache.current.get(key);
    setHover({ card, anchor, printings: cached ?? null });
    if (cached) return;
    api
      .printings({
        oracle_id: card.oracle_id,
        aesthetic_id: focusAes?.id,
        printing_strategy: printingStrategy,
        limit: 24,
      })
      .then((r) => {
        cacheSet(key, r.printings);
        setHover((cur) =>
          cur && cur.card.name_normalized === card.name_normalized
            ? { ...cur, printings: r.printings }
            : cur,
        );
      })
      .catch(() => {
        /* swallow */
      });
  };

  /** Click handler for a Gallery card: pins the popover at the click point.
   *  Clicking the same pinned card again unpins. Clicking a different card
   *  re-pins to that one (and loads its printings if not cached). */
  const pinCard = (card: PerCardRow, anchor: { x: number; y: number }) => {
    if (pinned && pinned.name_normalized === card.name_normalized) {
      setPinned(null);
      setHover(null);
      return;
    }
    if (!card.oracle_id) return;
    setPinned(card);
    const key = `${card.oracle_id}|${focusAes?.id ?? ''}`;
    const cached = cache.current.get(key);
    setHover({ card, anchor, printings: cached ?? null });
    if (cached) return;
    api
      .printings({
        oracle_id: card.oracle_id,
        aesthetic_id: focusAes?.id,
        printing_strategy: printingStrategy,
        limit: 24,
      })
      .then((r) => {
        cacheSet(key, r.printings);
        setHover((cur) =>
          cur && cur.card.name_normalized === card.name_normalized
            ? { ...cur, printings: r.printings }
            : cur,
        );
      })
      .catch(() => {
        /* swallow */
      });
  };

  const closePopover = () => {
    setPinned(null);
    setHover(null);
  };

  // Pinned popovers are intentionally STICKY: only the explicit X button
  // (or Esc) dismisses them. We used to auto-close on any document
  // click, but that prevented the user from interacting with the
  // popover itself — scrolling the alternates strip, opening printing
  // links, etc. now all work without accidentally dismissing.

  return (
    <>
      <div className="card-grid">
        {filtered.map((c) => {
          // Pick the printing to display, honoring includes (positive
          // spotlight) AND excludes (negative spotlight):
          //   1. If a primary include is set and this card has it, use it.
          //   2. Else: take the user's preferred (default) printing.
          //   3. If that printing satisfies any *excluded* aesthetic, walk
          //      the available examples for one that doesn't violate any
          //      exclude. Prefer printings that also match an included
          //      spotlight (other than primary, which step 1 handled).
          //   4. If nothing avoids the excludes, leave the slot dimmed
          //      with the "no aesthetic" missing label.
          const excludeSet = spotExcluded;
          const violatesExclude = (sat?: readonly string[] | null): boolean => {
            if (!sat || excludeSet.length === 0) return false;
            for (const id of excludeSet) if (sat.includes(id)) return true;
            return false;
          };

          // Step 1 + 2.
          let printing: PerCardExample | null | undefined =
            focusAes ? c.examples[focusAes.id] : c.default;
          let unavailable = focusAes != null && !c.available_aesthetics.includes(focusAes.id);

          // Step 3 — exclude-aware fallback. Build a candidate pool from
          // the default + every example printing, dedup by (set, cn).
          if (printing && violatesExclude(printing.satisfies)) {
            const seen = new Set<string>();
            type Cand = { p: PerCardExample; score: number };
            const candidates: Cand[] = [];
            const consider = (p: PerCardExample | null | undefined) => {
              if (!p?.image_normal) return;
              const key = `${p.set ?? ''}|${p.collector_number ?? ''}`;
              if (seen.has(key)) return;
              seen.add(key);
              const sat = p.satisfies ?? [];
              if (violatesExclude(sat)) return;
              // Score: cards satisfying a non-primary spotlight include
              // sort first; otherwise just take the order we encountered.
              let score = 0;
              for (const aid of galleryAesthetics) if (sat.includes(aid)) score += 1;
              candidates.push({ p, score });
            };
            consider(c.default);
            for (const ex of Object.values(c.examples)) consider(ex);
            candidates.sort((a, b) => b.score - a.score);
            if (candidates.length > 0) {
              printing = candidates[0].p;
              unavailable = false;
            } else {
              // Nothing satisfies. Both this case and the focus-aesthetic
              // unavailable case render via the SAME `unavailable` flag so
              // the dim treatment + missing-label overlay are identical.
              unavailable = true;
            }
          }

          const fallback = unavailable ? c.default : null;
          const shown = printing ?? fallback;
          // Count how many of the currently spotlit aesthetics this card
          // has a distinct printing for. When >1, surface the badge so the
          // user can expand into a side-by-side comparison view.
          const matchedSpotlights = galleryAesthetics.filter((aid) => !!c.examples[aid]?.image_normal);
          const multiCount = matchedSpotlights.length;
          return (
            <div
              key={c.name_normalized}
              className={
                'gallery-card-wrap' +
                (pinned?.name_normalized === c.name_normalized ? ' pinned' : '')
              }
              onMouseEnter={(e) => openHover(c, { x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => {
                if (pinned) return;
                setHover((h) =>
                  h && h.card.name_normalized === c.name_normalized
                    ? { ...h, anchor: { x: e.clientX, y: e.clientY } }
                    : h,
                );
              }}
              onMouseLeave={() => {
                if (pinned) return;
                setHover((h) => (h?.card.name_normalized === c.name_normalized ? null : h));
              }}
              onClick={(e) => {
                // Stop the document-level dismiss handler from firing.
                e.stopPropagation();
                pinCard(c, { x: e.clientX, y: e.clientY });
              }}
            >
              <MtgCard
                name={c.name}
                printing={shown}
                unavailable={unavailable}
                unresolved={!c.resolved}
                showName={false}
                disableHover
              />
              <CardCaption name={c.name} printing={shown} unresolved={!c.resolved} />
              {multiCount > 1 && (
                <button
                  type="button"
                  className="multi-printing-badge"
                  title={`${multiCount} matching spotlight printings — click to compare`}
                  aria-label={`Show ${multiCount} matching printings`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setHover(null);
                    setExpandCard(c);
                  }}
                >
                  <span className="mp-stack" aria-hidden>▦</span>
                  <span className="mp-count">×{multiCount}</span>
                </button>
              )}
            </div>
          );
        })}
      </div>

      {hover && !expandCard && (
        <PrintingsPopover
          hover={hover}
          aestheticLabel={focusAes?.label ?? null}
          pinned={!!pinned}
          onClose={closePopover}
        />
      )}

      {expandCard && (
        <SpotlightExpandModal
          card={expandCard}
          spotlightIds={galleryAesthetics}
          idToAes={idToAes}
          onClose={() => setExpandCard(null)}
        />
      )}

      {!filtered.length && (
        <div className="empty-state">
          <h3>No cards match the current filters</h3>
          <div>Try clearing some filter chips on the left.</div>
        </div>
      )}
    </>
  );
}

/** Caption rendered beneath each Gallery card: card name, set symbol + set
 *  name. Symbol URL is taken from the /api/sets index (which mirrors
 *  Scryfall's per-set `icon_svg_uri`) — some sets like h2r reuse a parent
 *  set's SVG, so a bare /sets/{code}.svg path 404s. We fall back to that
 *  bare path when the index hasn't loaded yet. */
function CardCaption({
  name,
  printing,
  unresolved,
}: {
  name: string;
  printing: PerCardExample | null | undefined;
  unresolved?: boolean;
}) {
  const setIcons = useStore((s) => s.setIcons);
  const setCode = printing?.set?.toLowerCase() ?? null;
  const setName = printing?.set_name ?? null;
  const symbolUrl = setCode
    ? setIcons[setCode] ?? `https://svgs.scryfall.io/sets/${setCode}.svg`
    : null;
  return (
    <div className={'card-caption' + (unresolved ? ' unresolved' : '')}>
      <div className="cc-line" title={setName ? `${name} · ${setName}` : name}>
        {setCode && (
          <span className="cc-set" title={setName ?? setCode.toUpperCase()}>
            {symbolUrl && (
              <img
                className="cc-set-symbol"
                src={symbolUrl}
                alt=""
                loading="lazy"
                draggable={false}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            )}
            <span className="cc-set-code">{setCode.toUpperCase()}</span>
          </span>
        )}
        {setCode && <span className="cc-sep" aria-hidden>·</span>}
        <span className="cc-name">{name}</span>
      </div>
    </div>
  );
}

/** Lightbox showing every spotlight printing for one card, side-by-side at
 *  full Gallery card size. Click outside or press Esc to dismiss. */
function SpotlightExpandModal({
  card,
  spotlightIds,
  idToAes,
  onClose,
}: {
  card: PerCardRow;
  spotlightIds: string[];
  idToAes: Map<string, { id: string; label: string }>;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cells = spotlightIds
    .map((aid) => ({ aid, ex: card.examples[aid], aes: idToAes.get(aid) }))
    .filter((c) => c.ex?.image_normal);

  return (
    <div
      className="spotlight-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`${card.name} — matching spotlight printings`}
      onClick={onClose}
    >
      <div className="spotlight-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sm-header">
          <span className="sm-title">{card.name}</span>
          <span className="sm-count muted">
            {cells.length} matching printing{cells.length === 1 ? '' : 's'}
          </span>
          <button type="button" className="sm-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="sm-grid">
          {cells.map(({ aid, ex, aes }) => {
            const u = ex?.set && ex?.collector_number
              ? `https://scryfall.com/card/${encodeURIComponent(ex.set)}/${encodeURIComponent(ex.collector_number)}`
              : null;
            return (
              <div key={aid} className="sm-cell">
                <div className="sm-cell-label">{aes?.label ?? aid}</div>
                <a
                  href={u ?? '#'}
                  target={u ? '_blank' : undefined}
                  rel={u ? 'noopener noreferrer' : undefined}
                  className="sm-cell-img"
                >
                  {ex?.image_normal && (
                    <CardImage src={ex.image_normal} alt="" />
                  )}
                </a>
                <div className="sm-cell-meta muted">
                  {ex?.set?.toUpperCase()} {ex?.collector_number}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface HoverState {
  card: PerCardRow;
  anchor: { x: number; y: number };
  printings: PrintingDetail[] | null;
}

/**
 * Hover popover redesigned:
 *   - Single enlarged card on the left (~284 wide at MTG aspect ratio).
 *   - Vertical strip of small alternates on the right (~88 wide each).
 *   - Hovering an alternate swaps it into the enlarged slot.
 *   - Arrow keys move the featured selection; Esc closes.
 *   - Caches printings per (oracle, aesthetic) via the parent's useRef.
 */
function PrintingsPopover({
  hover,
  aestheticLabel,
  pinned,
  onClose,
}: {
  hover: HoverState;
  aestheticLabel: string | null;
  pinned: boolean;
  onClose: () => void;
}) {
  const { card, anchor, printings } = hover;
  const PAD = 16;
  const W = 400;
  const HEADER_H = 30;
  // Strip is side-by-side with featured card so doesn't add to height.
  // Featured card takes (W - padding - gap - strip) wide → 5:7 aspect ratio.
  const FEAT_W = W - 16 - 8 - 92; // 284px
  const FEAT_H = Math.round(FEAT_W * 7 / 5) + 32; // +32 for meta row
  const H = FEAT_H + HEADER_H + 24;

  // When pinned, freeze the position at the moment of pinning so the popover
  // doesn't drift if the cursor moves later.
  const frozenAnchor = useRef(anchor);
  useEffect(() => {
    if (pinned) frozenAnchor.current = anchor;
    // We intentionally only update on the pinned transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned]);
  const useAnchor = pinned ? frozenAnchor.current : anchor;

  let x = useAnchor.x + PAD;
  if (x + W > window.innerWidth) x = useAnchor.x - W - PAD;
  if (x < 8) x = 8;
  let y = useAnchor.y - H / 2;
  if (y < 8) y = 8;
  if (y + H > window.innerHeight) y = Math.max(8, window.innerHeight - H - 8);

  const [featuredIdx, setFeaturedIdx] = useState(0);
  // Reset feature when the card changes.
  useEffect(() => setFeaturedIdx(0), [card.name_normalized]);

  // Keyboard navigation: arrow keys move featured selection, Esc closes.
  useEffect(() => {
    if (!printings || printings.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        setFeaturedIdx((i) => Math.min(printings.length - 1, i + 1));
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setFeaturedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const p = printings[featuredIdx];
        if (p) window.open(scryfallUrlFor(card.name, p), '_blank', 'noopener,noreferrer');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [printings, featuredIdx, onClose, card.name]);

  const featured = printings && printings[featuredIdx] ? printings[featuredIdx] : null;

  return (
    <div
      className={'printings-popover v2' + (pinned ? ' pinned' : '')}
      style={{ left: x, top: y, width: W }}
      role="dialog"
      aria-label={`Printings of ${card.name}`}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="pp-header">
        <span className="pp-name">{card.name}</span>
        {aestheticLabel && <span className="pp-aes">{aestheticLabel}</span>}
        <span className="pp-count">
          {printings ? `${printings.length} printing${printings.length === 1 ? '' : 's'}` : '…'}
        </span>
        {pinned && (
          <button
            type="button"
            className="pp-close"
            onClick={onClose}
            aria-label="Close pinned popover"
            title="Close (Esc)"
          >×</button>
        )}
      </div>

      <div className="pp-body">
      <div className="pp-featured">
        {featured ? (
          <a
            href={scryfallUrlFor(card.name, featured)}
            target="_blank"
            rel="noopener noreferrer"
            title={`${featured.set?.toUpperCase() ?? ''} ${featured.collector_number ?? ''}${featured.released_at ? ` · ${featured.released_at.slice(0, 10)}` : ''}${featured.price_usd != null ? ` · $${featured.price_usd.toFixed(2)}` : ''}`}
          >
            <CardImage src={featured.image_normal} alt="" loading="eager" />
            {featured.is_tournament_legal === false && (
              <div className="not-legal-overlay" aria-hidden>
                <span className="not-legal-band">Not tournament legal</span>
              </div>
            )}
          </a>
        ) : (
          <div className="pp-featured-skel skeleton" />
        )}
        {featured && (
          <div className="pp-featured-meta">
            <span className="pp-set">{featured.set?.toUpperCase()}</span>
            <span className="pp-cn muted">{featured.collector_number}</span>
            {featured.released_at && (
              <span className="pp-date muted">{featured.released_at.slice(0, 10)}</span>
            )}
            {featured.price_usd != null && (
              <span className="pp-price">${featured.price_usd.toFixed(2)}</span>
            )}
          </div>
        )}
      </div>

      <div className="pp-strip" role="listbox" aria-label="Alternate printings">
        {(printings ?? Array.from({ length: 6 }, () => null)).map((p, i) =>
          p ? (
            <button
              type="button"
              key={`${p.set}-${p.collector_number}-${i}`}
              className={'pp-strip-cell' + (i === featuredIdx ? ' active' : '')}
              onMouseEnter={() => setFeaturedIdx(i)}
              onFocus={() => setFeaturedIdx(i)}
              onClick={() =>
                window.open(scryfallUrlFor(card.name, p), '_blank', 'noopener,noreferrer')
              }
              aria-selected={i === featuredIdx}
              role="option"
              title={`${p.set?.toUpperCase() ?? ''} ${p.collector_number ?? ''}${p.released_at ? ` · ${p.released_at.slice(0, 10)}` : ''}`}
            >
              <CardImage src={p.image_normal} alt="" />
              <span className="pp-strip-rank">{i + 1}</span>
              {p.is_tournament_legal === false && (
                <span className="pp-strip-illegal" title="Not tournament legal" aria-hidden>!</span>
              )}
            </button>
          ) : (
            <div key={`sk-${i}`} className="pp-strip-cell skeleton" />
          ),
        )}
        {printings && printings.length === 0 && (
          <div className="pp-empty">No matching printings.</div>
        )}
      </div>
      </div>
    </div>
  );
}

function scryfallUrlFor(name: string, p: PrintingDetail): string {
  if (p.set && p.collector_number) {
    return `https://scryfall.com/card/${encodeURIComponent(p.set)}/${encodeURIComponent(p.collector_number)}`;
  }
  return `https://scryfall.com/search?q=${encodeURIComponent(`!"${name}"`)}`;
}
