import { useEffect } from 'react';
import { useStore } from '../store';
import { MtgCard } from './MtgCard';

export function Drawer() {
  const drawerId = useStore((s) => s.drawerAestheticId);
  const close = useStore((s) => s.openDrawer);
  const result = useStore((s) => s.result);
  const aesthetics = useStore((s) => s.aesthetics);

  // Close on Esc.
  useEffect(() => {
    if (!drawerId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerId, close]);

  if (!drawerId || !result) return null;
  const ae = aesthetics.find((a) => a.id === drawerId);
  if (!ae) return null;

  const cards = result.per_card.filter((r) => r.available_aesthetics.includes(drawerId));
  const missing = result.per_card.filter(
    (r) => r.resolved && !r.available_aesthetics.includes(drawerId),
  );

  return (
    <div className="drawer-backdrop" onClick={() => close(null)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={() => close(null)} aria-label="Close">×</button>
        {ae.group && <small style={{ display: 'block', fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 }}>{ae.group}</small>}
        <h1 style={{ marginRight: 24 }}>{ae.label}</h1>
        {ae.description && <div className="muted" style={{ marginBottom: 16 }}>{ae.description}</div>}

        <h2>Available · {cards.length}</h2>
        <div className="card-grid dense">
          {cards.map((c) => (
            <MtgCard
              key={c.name_normalized}
              name={c.name}
              qty={c.qty}
              printing={c.examples[drawerId]}
              showName
            />
          ))}
          {!cards.length && <div className="muted">None</div>}
        </div>

        {missing.length > 0 && (
          <>
            <h2>Missing · {missing.length}</h2>
            <div className="card-grid dense">
              {missing.map((c) => (
                <MtgCard
                  key={c.name_normalized}
                  name={c.name}
                  qty={c.qty}
                  printing={c.default}
                  unavailable
                  missingLabel="Not in this aesthetic"
                  showName
                />
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
