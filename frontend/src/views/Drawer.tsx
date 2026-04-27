import { useEffect, useState } from 'react';
import { api, type PrintingDetail } from '../api';
import { useStore } from '../store';
import { MtgCard } from './MtgCard';

export function Drawer() {
  const drawerId = useStore((s) => s.drawerAestheticId);
  const drawerCardOracleId = useStore((s) => s.drawerCardOracleId);
  const drawerCardName = useStore((s) => s.drawerCardName);
  const close = useStore((s) => s.openDrawer);
  const result = useStore((s) => s.result);
  const aesthetics = useStore((s) => s.aesthetics);
  const printingStrategy = useStore((s) => s.printingStrategy);
  const allowNonTournament = useStore((s) => s.allowNonTournament);
  const allowDigital = useStore((s) => s.allowDigital);
  const disabledSets = useStore((s) => s.disabledSets);
  const format = useStore((s) => s.format);

  const [focusedPrintings, setFocusedPrintings] = useState<PrintingDetail[] | null>(null);
  const [focusedLoading, setFocusedLoading] = useState(false);
  const [focusedError, setFocusedError] = useState<string | null>(null);

  // Close on Esc.
  useEffect(() => {
    if (!drawerId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerId, close]);

  // Fetch all matching printings of the focused card whenever a per-card
  // cell opens the drawer. Skipped when the drawer was opened from a
  // generic header / chip (no card focus).
  useEffect(() => {
    if (!drawerId || (!drawerCardOracleId && !drawerCardName)) {
      setFocusedPrintings(null);
      setFocusedError(null);
      return;
    }
    let cancelled = false;
    setFocusedLoading(true);
    setFocusedError(null);
    api
      .printings({
        oracle_id: drawerCardOracleId ?? undefined,
        name: drawerCardOracleId ? undefined : drawerCardName ?? undefined,
        aesthetic_id: drawerId,
        printing_strategy: printingStrategy,
        allow_non_tournament: allowNonTournament,
        allow_digital: allowDigital,
        disabled_sets: disabledSets,
        format: format || undefined,
        limit: 500,
      })
      .then((r) => {
        if (cancelled) return;
        setFocusedPrintings(r.printings);
      })
      .catch((e) => {
        if (cancelled) return;
        setFocusedError(e instanceof Error ? e.message : String(e));
        setFocusedPrintings(null);
      })
      .finally(() => {
        if (!cancelled) setFocusedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [drawerId, drawerCardOracleId, drawerCardName, printingStrategy, allowNonTournament, allowDigital, disabledSets, format]);

  if (!drawerId || !result) return null;
  const ae = aesthetics.find((a) => a.id === drawerId);
  if (!ae) return null;

  const cards = result.per_card.filter((r) => r.available_aesthetics.includes(drawerId));
  const missing = result.per_card.filter(
    (r) => r.resolved && !r.available_aesthetics.includes(drawerId),
  );

  const focusedCard = drawerCardName
    ? result.per_card.find(
        (r) =>
          (drawerCardOracleId && r.oracle_id === drawerCardOracleId) ||
          r.name === drawerCardName,
      )
    : null;

  // When opened from a per-card cell, the focused card already has its
  // own "matching versions" section above — don't repeat it in the
  // "other cards" list below.
  const otherCards = focusedCard
    ? cards.filter((c) => c.name_normalized !== focusedCard.name_normalized)
    : cards;
  const otherHeading = focusedCard
    ? 'Other cards in this deck with this aesthetic'
    : 'Cards in this deck with this aesthetic';

  return (
    <div className="drawer-backdrop" onClick={() => close(null)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={() => close(null)} aria-label="Close">×</button>
        {ae.group && <small style={{ display: 'block', fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 }}>{ae.group}</small>}
        <h1 style={{ marginRight: 24 }}>{ae.label}</h1>
        {ae.description && <div className="muted" style={{ marginBottom: 16 }}>{ae.description}</div>}

        {drawerCardName && (
          <section className="drawer-section drawer-focused">
            <h2>
              {drawerCardName} · matching versions
              {focusedPrintings && ` · ${focusedPrintings.length}`}
            </h2>
            {focusedLoading && <div className="muted">Loading versions…</div>}
            {focusedError && <div className="muted">Couldn't load versions: {focusedError}</div>}
            {focusedPrintings && focusedPrintings.length === 0 && (
              <div className="muted">No printings found for this combination.</div>
            )}
            {focusedPrintings && focusedPrintings.length > 0 && (
              <div className="card-grid dense">
                {focusedPrintings.map((p, i) => (
                  <MtgCard
                    key={`${p.set}-${p.collector_number}-${p.lang ?? ''}-${i}`}
                    name={drawerCardName}
                    printing={p}
                    showName={false}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        <h2>{otherHeading} · {otherCards.length}</h2>
        <div className="card-grid dense">
          {otherCards.map((c) => (
            <MtgCard
              key={c.name_normalized}
              name={c.name}
              printing={c.examples[drawerId]}
              showName
            />
          ))}
          {!otherCards.length && <div className="muted">None</div>}
        </div>

        {missing.length > 0 && (
          <>
            <h2>Missing · {missing.length}</h2>
            <div className="card-grid dense">
              {missing.map((c) => (
                <MtgCard
                  key={c.name_normalized}
                  name={c.name}
                  printing={c.default}
                  unavailable
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
