// Shared helpers for the Insights views.
import type { Aesthetic, PerCardRow } from '../api';

/** Map 0..1 to a heatmap color (cool dark → muted blue → warm amber). */
export function heat(p: number): string {
  const t = Math.max(0, Math.min(1, p));
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  let r: number, g: number, b: number;
  if (t < 0.5) {
    const u = t / 0.5;
    r = lerp(40, 92, u);
    g = lerp(46, 128, u);
    b = lerp(54, 168, u);
  } else {
    const u = (t - 0.5) / 0.5;
    r = lerp(92, 200, u);
    g = lerp(128, 160, u);
    b = lerp(168, 88, u);
  }
  return `rgb(${r}, ${g}, ${b})`;
}

export function groupClass(group: string | null | undefined): string {
  const k = (group ?? 'Other').toLowerCase();
  // Showcase Treatment must be matched BEFORE the generic "treat" branch
  // since both group names contain "treat".
  if (k.includes('showcase')) return 'g-showcase';
  if (k.includes('frame')) return 'g-frame';
  if (k.includes('border')) return 'g-border';
  if (k.includes('treat')) return 'g-treat';
  if (k.includes('promo')) return 'g-promo';
  if (k.includes('origin')) return 'g-origin';
  return 'g-other';
}

/**
 * Aesthetics that are uninformative on aggregate/analytical views — e.g.
 * `paper_only` is true for the vast majority of any sensible deck and
 * just inflates scores or pollutes top-N lists. We hide it on those
 * specific views; per-card / visual views (Coverage, Mosaic, Gallery,
 * Art Grid, Timeline, Set Heatmap, side filter, Spotlight) still show it
 * because filtering by paper-only is sometimes useful.
 */
export const HIDDEN_AESTHETICS_PER_VIEW: Record<string, Set<string>> = {
  consistency: new Set(['paper_only']),
  funnel: new Set(['paper_only']),
  outliers: new Set(['paper_only']),
  compare: new Set(['paper_only']),
};

export function visibleAesthetics<T extends { id: string }>(
  all: T[],
  view: string,
): T[] {
  const hidden = HIDDEN_AESTHETICS_PER_VIEW[view];
  if (!hidden || hidden.size === 0) return all;
  return all.filter((a) => !hidden.has(a.id));
}

/** Compute, for each aesthetic, the share of total deck quantity covered. */
export function aestheticCoverage(cards: PerCardRow[], aesthetics: Aesthetic[]) {
  const totalQty = cards.reduce((s, c) => s + c.qty, 0) || 1;
  return aesthetics.map((a) => {
    let qty = 0;
    let unique = 0;
    for (const c of cards) {
      if (c.available_aesthetics.includes(a.id)) {
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

export interface CoverageRow {
  id: string;
  label: string;
  group: string;
  qty: number;
  unique: number;
  pct: number;
}

/** Map Scryfall `frame` value (e.g. "1993", "1997", "2003", "2015", "future") to a friendly era label. */
export function frameEra(frame: string | null | undefined): string {
  switch (frame) {
    case '1993':
      return 'Alpha–4th (1993–1995)';
    case '1997':
      return 'Classic (1997–2002)';
    case '2003':
      return 'Modern frame (2003–2014)';
    case '2015':
      return 'M15 frame (2015–today)';
    case 'future':
      return 'Future Sight (2007)';
    default:
      return frame ? `Frame: ${frame}` : 'Unknown frame';
  }
}

export function ymd(s: string | null | undefined): string {
  return s ? s.slice(0, 10) : '';
}

export function year(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s.slice(0, 4), 10);
  return Number.isFinite(n) ? n : null;
}

export function moneyShort(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}
