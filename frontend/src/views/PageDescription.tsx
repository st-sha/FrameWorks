import { useState, useEffect } from 'react';

/**
 * Collapsible explanatory header for a view. Persists open/closed state
 * per `id` in localStorage so the description stays out of the way after
 * the user has read it once.
 */
export function PageDescription({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  const key = `desc-collapsed:${id}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, collapsed ? '1' : '0');
    } catch {
      /* noop */
    }
  }, [key, collapsed]);

  return (
    <div className={'page-desc' + (collapsed ? ' collapsed' : '')}>
      <button
        type="button"
        className="page-desc-toggle"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        title={collapsed ? 'Show description' : 'Hide description'}
      >
        <span className="page-desc-chev" aria-hidden>{collapsed ? '▸' : '▾'}</span>
        <span className="page-desc-title">{title}</span>
      </button>
      {!collapsed && <div className="page-desc-body">{children}</div>}
    </div>
  );
}

/**
 * Pick the most representative non-null price for a card. Tries the
 * default printing first; if that's null (common for fresh Secret Lairs
 * and Universes Beyond drops), falls back to the cheapest non-null price
 * among the spotlight examples. Returns 0 if nothing is priced.
 */
export function priceFor(card: {
  default: { price_usd: number | null } | null;
  examples: Record<string, { price_usd: number | null }>;
}): number {
  const d = card.default?.price_usd;
  if (d != null && d > 0) return d;
  let best: number | null = null;
  for (const ex of Object.values(card.examples)) {
    if (ex?.price_usd != null && ex.price_usd > 0) {
      if (best == null || ex.price_usd < best) best = ex.price_usd;
    }
  }
  return best ?? 0;
}
