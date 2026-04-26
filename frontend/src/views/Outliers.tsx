import { useMemo, useState } from 'react';
import { filterCards, useStore } from '../store';
import { aestheticCoverage, groupClass, moneyShort, visibleAesthetics } from './insightsUtil';
import { PageDescription, priceFor } from './PageDescription';

/**
 * Outliers — for a chosen "target" aesthetic, show every card in the deck
 * that is NOT available with that aesthetic, ranked by quantity. The
 * "closest substitute" column always renders the substitute's art crop
 * inline so you can decide at a glance whether the swap is acceptable;
 * hovering the card name pops a full-card preview.
 */
export function OutliersView() {
  const result = useStore((s) => s.result)!;
  const aesthetics = useStore((s) => s.aesthetics);
  const selected = useStore((s) => s.selectedAesthetics);
  const spotlight = useStore((s) => s.galleryAesthetics);
  const openDrawer = useStore((s) => s.openDrawer);

  const cards = useMemo(
    () => filterCards(result.per_card, selected, aesthetics),
    [result.per_card, selected, aesthetics],
  );
  const visible = useMemo(() => visibleAesthetics(aesthetics, 'outliers'), [aesthetics]);
  const cov = useMemo(() => aestheticCoverage(cards, visible), [cards, visible]);
  const aesById = useMemo(() => {
    const m = new Map<string, (typeof aesthetics)[number]>();
    for (const a of aesthetics) m.set(a.id, a);
    return m;
  }, [aesthetics]);

  const defaultTarget = useMemo(() => {
    if (spotlight[0] && aesById.has(spotlight[0])) return spotlight[0];
    const best = [...cov].sort((a, b) => b.pct - a.pct)[0];
    return best?.id ?? aesthetics[0]?.id ?? '';
  }, [spotlight, cov, aesById, aesthetics]);

  const [target, setTarget] = useState<string>(defaultTarget);
  if (target === '' && defaultTarget) setTarget(defaultTarget);

  const targetAes = aesById.get(target);

  const blockers = useMemo(() => {
    if (!target) return [];
    const targetGroup = targetAes?.group ?? null;
    const sameGroupIds = visible
      .filter((a) => a.group === targetGroup && a.id !== target)
      .map((a) => a.id);
    return cards
      .filter((c) => !c.available_aesthetics.includes(target))
      .map((c) => {
        // Prefer a same-group substitute (closest visual swap), but if the
        // card has none in that group, fall back to its first available
        // aesthetic in any other group so the row is still actionable.
        let subId = sameGroupIds.find((id) => c.available_aesthetics.includes(id)) ?? null;
        let crossGroup = false;
        if (!subId) {
          subId = c.available_aesthetics.find((id) => id !== target && aesById.has(id)) ?? null;
          crossGroup = subId != null;
        }
        const subPrinting = subId ? c.examples[subId] ?? null : null;
        return { card: c, subId, subPrinting, crossGroup };
      })
      .sort((a, b) => b.card.qty - a.card.qty || a.card.name.localeCompare(b.card.name));
  }, [cards, target, visible, targetAes, aesById]);

  const totalQty = cards.reduce((s, c) => s + c.qty, 0) || 1;
  const blockerQty = blockers.reduce((s, b) => s + b.card.qty, 0);
  const blockerCost = blockers.reduce((s, b) => s + priceFor(b.card) * b.card.qty, 0);

  return (
    <div className="insight-wrap outliers-wrap">
      <PageDescription id="outliers" title="Blockers — what's stopping a full commitment?">
        Pick a target aesthetic (defaults to your top spotlight). Every card
        that <em>can't</em> be printed with that aesthetic is listed below,
        sorted by how many copies you'd need to swap. The "closest substitute"
        column shows the same-group treatment that <em>is</em> available for
        that card, with its art inline; if no same-group option exists we fall
        back to the card's next-best printing from any other group (marked
        with a small dot). Hover any card name to preview the full card.
      </PageDescription>

      <div className="outliers-toolbar">
        <label>
          <span className="muted" style={{ fontSize: 11, marginRight: 6 }}>Target aesthetic:</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {visible.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {a.group ? ` — ${a.group}` : ''}
              </option>
            ))}
          </select>
        </label>
        {targetAes && (
          <span className="muted" style={{ fontSize: 11 }}>
            <strong style={{ color: 'var(--text)' }}>
              {totalQty - blockerQty}/{totalQty}
            </strong>{' '}
            already match · <strong style={{ color: 'var(--text)' }}>{blockers.length}</strong>{' '}
            blocking unique card{blockers.length === 1 ? '' : 's'} ({blockerQty} qty,{' '}
            ~{moneyShort(blockerCost)} default printings)
          </span>
        )}
      </div>

      <table className="outliers-table">
        <thead>
          <tr>
            <th className="ot-qty">Qty</th>
            <th>Card</th>
            <th>Closest substitute</th>
            <th className="ot-other">All available aesthetics</th>
          </tr>
        </thead>
        <tbody>
          {blockers.map(({ card, subId, subPrinting, crossGroup }) => {
            const cardImg = card.default?.image_normal ?? null;
            return (
              <tr key={card.name_normalized}>
                <td className="ot-qty">{card.qty}×</td>
                <td className="ot-name">
                  <span className="ot-card hover-preview">
                    {card.name}
                    {cardImg && (
                      <span className="hover-preview-card" aria-hidden>
                        <img src={cardImg} alt="" loading="lazy" />
                      </span>
                    )}
                  </span>
                  {card.default?.set && (
                    <span className="muted ot-set"> · {card.default.set.toUpperCase()}</span>
                  )}
                </td>
                <td>
                  {subId && subPrinting ? (
                    <button
                      type="button"
                      className={'ot-sub ' + groupClass(aesById.get(subId)?.group) + (crossGroup ? ' cross-group' : '')}
                      onClick={() => openDrawer(subId)}
                      title={
                        (crossGroup ? 'Different group — ' : '') +
                        `${aesById.get(subId)?.label} — ${subPrinting.set?.toUpperCase() ?? ''} ${subPrinting.collector_number ?? ''}`
                      }
                    >
                      {(subPrinting.image_art_crop ?? subPrinting.image_normal) && (
                        <img
                          src={(subPrinting.image_art_crop ?? subPrinting.image_normal)!}
                          alt=""
                          loading="lazy"
                        />
                      )}
                      <span className="ot-sub-label">
                        {aesById.get(subId)?.label}
                        {crossGroup && (
                          <span className="ot-sub-group muted"> · {aesById.get(subId)?.group ?? 'Other'}</span>
                        )}
                      </span>
                    </button>
                  ) : (
                    <span className="muted">— no other printing</span>
                  )}
                </td>
                <td className="ot-other">
                  {card.available_aesthetics.length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    card.available_aesthetics.map((id) => {
                      const a = aesById.get(id);
                      if (!a) return null;
                      return (
                        <button
                          key={id}
                          type="button"
                          className={'chip linklike ' + groupClass(a.group)}
                          onClick={() => openDrawer(id)}
                          title={`${a.label} — ${a.group ?? 'Other'}`}
                        >
                          {a.label}
                        </button>
                      );
                    })
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {blockers.length === 0 && targetAes && (
        <div className="empty-state">
          <h3>Every card is available with “{targetAes.label}”</h3>
          <div className="muted">No blockers — this aesthetic fully covers your deck.</div>
        </div>
      )}
    </div>
  );
}
