import { useEffect, useMemo } from 'react';
import { filterCards, useAestheticIndex, useStore } from '../store';
import { groupClass, visibleAesthetics } from './insightsUtil';
import { PageDescription } from './PageDescription';

/**
 * Aesthetic Compare — pick A and B; show three columns: cards available
 * in BOTH, only A, only B. Lets you weigh the tradeoffs of committing
 * to one treatment vs another (or seeing where two treatments overlap
 * usefully, e.g. "borderless ∩ retro frame").
 */
export function CompareView() {
  const result = useStore((s) => s.result)!;
  const aesthetics = useStore((s) => s.aesthetics);
  const selected = useStore((s) => s.selectedAesthetics);
  const compare = useStore((s) => s.compareAesthetics);
  const setCompare = useStore((s) => s.setCompareAesthetics);
  const openDrawer = useStore((s) => s.openDrawer);

  const cards = useMemo(
    () => filterCards(result.per_card, selected, aesthetics),
    [result.per_card, selected, aesthetics],
  );
  const visible = useMemo(() => visibleAesthetics(aesthetics, 'compare'), [aesthetics]);
  const aesById = useAestheticIndex();

  // Default to Black Border vs White Border when both exist; fall back to
  // top-2-by-coverage otherwise. Persisted, so user picks survive.
  useEffect(() => {
    if (compare[0] && compare[1]) return;
    const hasBlack = aesById.has('border_black');
    const hasWhite = aesById.has('border_white');
    if (hasBlack && hasWhite && !compare[0] && !compare[1]) {
      setCompare(['border_black', 'border_white']);
      return;
    }
    const totalQty = cards.reduce((s, c) => s + c.qty, 0) || 1;
    const cov = visible
      .map((a) => {
        let qty = 0;
        for (const c of cards) if (c.available_aesthetics.includes(a.id)) qty += c.qty;
        return { id: a.id, pct: qty / totalQty };
      })
      .sort((a, b) => b.pct - a.pct);
    const a = compare[0] ?? cov[0]?.id ?? null;
    const b = compare[1] ?? cov.find((r) => r.id !== a)?.id ?? null;
    if (a !== compare[0] || b !== compare[1]) setCompare([a, b]);
  }, [aesthetics, visible, cards, compare, setCompare, aesById]);

  const idA = compare[0];
  const idB = compare[1];
  const aA = idA ? aesById.get(idA) : null;
  const aB = idB ? aesById.get(idB) : null;

  const buckets = useMemo(() => {
    const both: typeof cards = [];
    const onlyA: typeof cards = [];
    const onlyB: typeof cards = [];
    const neither: typeof cards = [];
    for (const c of cards) {
      const inA = !!idA && c.available_aesthetics.includes(idA);
      const inB = !!idB && c.available_aesthetics.includes(idB);
      if (inA && inB) both.push(c);
      else if (inA) onlyA.push(c);
      else if (inB) onlyB.push(c);
      else neither.push(c);
    }
    return { both, onlyA, onlyB, neither };
  }, [cards, idA, idB]);

  const totalQty = cards.reduce((s, c) => s + c.qty, 0) || 1;
  const sumQty = (rows: typeof cards) => rows.reduce((s, c) => s + c.qty, 0);

  return (
    <div className="insight-wrap compare-wrap">
      <PageDescription id="compare" title="Compare — weigh two aesthetics side by side">
        Pick A and B. The three columns show what's <em>only available with
        A</em>, what's available with <em>both</em>, and what's <em>only
        available with B</em>. The red panel underneath calls out the cards
        that match <em>neither</em> aesthetic — these are the blockers if
        you tried to commit to either one.
      </PageDescription>
      <div className="compare-toolbar">
        <label>
          <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>A:</span>
          <select
            value={idA ?? ''}
            onChange={(e) => setCompare([e.target.value || null, idB])}
          >
            <option value="">— pick aesthetic A —</option>
            {visible.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {a.group ? ` — ${a.group}` : ''}
              </option>
            ))}
          </select>
        </label>
        <button className="tab" onClick={() => setCompare([idB, idA])} title="Swap A ↔ B">
          ⇄
        </button>
        <label>
          <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>B:</span>
          <select
            value={idB ?? ''}
            onChange={(e) => setCompare([idA, e.target.value || null])}
          >
            <option value="">— pick aesthetic B —</option>
            {visible.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {a.group ? ` — ${a.group}` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="compare-grid">
        <Col
          title={aA ? `Only ${aA.label}` : 'Only A'}
          subtitle={aA ? aA.group ?? '' : ''}
          rows={buckets.onlyA}
          totalQty={totalQty}
          sumQty={sumQty}
          aestheticIdForOpen={idA}
          onOpen={openDrawer}
          cls={aA ? groupClass(aA.group) : 'g-other'}
        />
        <Col
          title="In both"
          subtitle="overlap"
          rows={buckets.both}
          totalQty={totalQty}
          sumQty={sumQty}
          aestheticIdForOpen={null}
          onOpen={openDrawer}
          cls="g-other compare-both"
        />
        <Col
          title={aB ? `Only ${aB.label}` : 'Only B'}
          subtitle={aB ? aB.group ?? '' : ''}
          rows={buckets.onlyB}
          totalQty={totalQty}
          sumQty={sumQty}
          aestheticIdForOpen={idB}
          onOpen={openDrawer}
          cls={aB ? groupClass(aB.group) : 'g-other'}
        />
      </div>

      {buckets.neither.length > 0 && (
        <section className="compare-neither-panel">
          <header className="compare-neither-h">
            <span className="compare-neither-badge">Matches neither</span>
            <span className="compare-neither-stats">
              <strong>{buckets.neither.length}</strong> unique ·{' '}
              <strong>{sumQty(buckets.neither)}</strong> qty ·{' '}
              {((sumQty(buckets.neither) / totalQty) * 100).toFixed(0)}% of deck
            </span>
          </header>
          <div className="compare-neither-grid">
            {buckets.neither.map((c) => {
              const img = c.default?.image_art_crop ?? c.default?.image_normal ?? null;
              return (
                <div key={c.name_normalized} className="compare-neither-card">
                  {img && <img src={img} alt="" loading="lazy" />}
                  <div className="compare-neither-meta">
                    <span className="compare-card-qty">{c.qty}×</span>
                    <span className="compare-card-name">{c.name}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function Col({
  title,
  subtitle,
  rows,
  totalQty,
  sumQty,
  aestheticIdForOpen,
  onOpen,
  cls,
}: {
  title: string;
  subtitle: string;
  rows: ReturnType<typeof filterCards>;
  totalQty: number;
  sumQty: (rows: ReturnType<typeof filterCards>) => number;
  aestheticIdForOpen: string | null;
  onOpen: (id: string) => void;
  cls: string;
}) {
  const qty = sumQty(rows);
  const pct = (qty / totalQty) * 100;
  return (
    <section className={`compare-col ${cls}`}>
      <header className="compare-col-h">
        <div className="compare-col-title">
          {aestheticIdForOpen ? (
            <button
              type="button"
              className="linklike"
              onClick={() => onOpen(aestheticIdForOpen)}
              title="Open drawer for this aesthetic"
            >
              {title}
            </button>
          ) : (
            title
          )}
        </div>
        <div className="muted compare-col-sub">{subtitle}</div>
        <div className="compare-col-stats">
          <span className="compare-col-pct">{pct.toFixed(0)}%</span>
          <span className="muted">
            {' '}
            ({rows.length} unique · {qty} qty)
          </span>
        </div>
      </header>
      <div className="compare-col-list">
        {rows.map((c) => {
          const img = c.default?.image_art_crop ?? c.default?.image_normal ?? null;
          return (
            <div key={c.name_normalized} className="compare-card">
              {img && <img src={img} alt="" loading="lazy" />}
              <div className="compare-card-meta">
                <span className="compare-card-qty">{c.qty}×</span>
                <span className="compare-card-name">{c.name}</span>
              </div>
            </div>
          );
        })}
        {rows.length === 0 && <div className="muted compare-empty">— none —</div>}
      </div>
    </section>
  );
}
