import { memo, useEffect, useState } from 'react';
import type { PerCardExample } from '../api';

/** Single canonical message for any "this card slot can't be filled" case.
 *  Centralized so the dim treatment + copy stay identical across views
 *  (Gallery, Drawer, future Compare). */
export const NO_PRINTING_MESSAGE = 'No printing matches filters';

/** Resilient `<img>` for Scryfall card art.
 *
 *  Scryfall's CDN occasionally serves transient 404/5xx responses (CDN
 *  cache misses, rolling deploys, brief unavailability) or the browser
 *  silently cancels a `loading="lazy"` request that hasn't reached the
 *  viewport yet — both surface to the user as a stuck placeholder.
 *
 *  This wrapper retries once with a cache-buster query param when an
 *  image errors out, which forces a fresh CDN fetch + bypasses any
 *  poisoned browser-cache entry. After the retry fails we fall back to
 *  hiding the image so the placeholder/caption can take over rather
 *  than rendering a broken-image icon.
 */
export function CardImage({
  src,
  alt,
  className,
  loading = 'lazy',
  draggable = false,
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  loading?: 'eager' | 'lazy';
  draggable?: boolean;
}) {
  // `effective` is what we actually pass to <img>. We swap to a cache-
  // busted URL on the first error and to `null` (hide) on the second.
  const [effective, setEffective] = useState<string | null>(src ?? null);
  const [retried, setRetried] = useState(false);
  useEffect(() => {
    setEffective(src ?? null);
    setRetried(false);
  }, [src]);
  if (!effective) return null;
  return (
    <img
      src={effective}
      alt={alt}
      className={className}
      loading={loading}
      draggable={draggable}
      onError={() => {
        if (!src) return;
        if (!retried) {
          // Append/refresh a cache-buster. Use timestamp so concurrent
          // mounts don't collide on the same query value.
          const sep = src.includes('?') ? '&' : '?';
          setEffective(`${src}${sep}_r=${Date.now()}`);
          setRetried(true);
        } else {
          setEffective(null);
        }
      }}
    />
  );
}

interface Props {
  name: string;
  printing: PerCardExample | null | undefined;
  unavailable?: boolean;
  unresolved?: boolean;
  showName?: boolean;
  onClick?: () => void;
  overlay?: React.ReactNode;
  missingLabel?: string;
  /** Suppress the built-in single-card hover popover (use when the parent
   *  renders its own richer hover UI). */
  disableHover?: boolean;
}

export const MtgCard = memo(function MtgCard({
  name,
  printing,
  unavailable,
  unresolved,
  showName = true,
  onClick,
  overlay,
  missingLabel,
  disableHover,
}: Props) {
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const img = printing?.image_normal;

  return (
    <div className="card-cell">
      <div
        className={'mtg-card ' + (unavailable ? 'unavailable ' : '') + (img ? '' : 'placeholder')}
        onClick={onClick}
        onMouseMove={(e) => {
          if (disableHover || !img) return;
          const padX = 16;
          const popW = 296;
          const popH = 412;
          let x = e.clientX + padX;
          if (x + popW > window.innerWidth) x = e.clientX - popW - padX;
          let y = e.clientY - popH / 2;
          if (y < 8) y = 8;
          if (y + popH > window.innerHeight) y = window.innerHeight - popH - 8;
          setHover({ x, y });
        }}
        onMouseLeave={() => setHover(null)}
      >
        {img ? (
          <CardImage src={img} alt={name} />
        ) : (
          <div>
            {unresolved ? 'Unrecognized card' : name}
          </div>
        )}
        {overlay}
        {/* Diagonal red banner for non-tournament-legal printings. Only
            renders when the backend explicitly tagged the printing as
            non-legal AND we actually have an image to overlay (so the
            placeholder card doesn't get the banner). */}
        {img && printing && printing.is_tournament_legal === false && (
          <div className="not-legal-overlay" aria-hidden>
            <span className="not-legal-band">Not tournament legal</span>
          </div>
        )}
      </div>
      {/* Missing label sits as a SIBLING of .mtg-card (not a child) so the
          card's grayscale+brightness filter doesn't drag the label down
          with it. Positioned absolutely over the card via .card-cell. */}
      {unavailable && (
        <div className="missing-overlay">{missingLabel ?? NO_PRINTING_MESSAGE}</div>
      )}
      {showName && (
        <div className={'card-name ' + (unresolved ? 'unresolved' : '')}>
          {name}
        </div>
      )}
      {hover && img && !disableHover && (
        <div className="card-popover" style={{ left: hover.x, top: hover.y }}>
          <CardImage src={img} alt="" loading="eager" />
        </div>
      )}
    </div>
  );
});
