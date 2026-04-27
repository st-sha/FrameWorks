import { useState } from 'react';
import type { PerCardExample } from '../api';

/** Single canonical message for any "this card slot can't be filled" case.
 *  Centralized so the dim treatment + copy stay identical across views
 *  (Gallery, Drawer, future Compare). */
export const NO_PRINTING_MESSAGE = 'No printing matches filters';

interface Props {
  name: string;
  qty?: number;
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

export function MtgCard({
  name,
  qty,
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
          <img src={img} alt={name} loading="lazy" draggable={false} />
        ) : (
          <div>
            {unresolved ? 'Unrecognized card' : name}
          </div>
        )}
        {qty != null && img && <div className="qty-badge">{qty}×</div>}
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
          <img src={img} alt="" />
        </div>
      )}
    </div>
  );
}
