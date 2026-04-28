import { useEffect, useMemo, useState } from 'react';
import type { Aesthetic, PerCardRow } from '../api';
import { filterCards, groupAesthetics, useAestheticIndex, useStore } from '../store';
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
  const persistedTarget = useStore((s) => s.outliersTarget);
  const setOutliersTarget = useStore((s) => s.setOutliersTarget);

  const cards = useMemo(
    () => filterCards(result.per_card, selected, aesthetics),
    [result.per_card, selected, aesthetics],
  );
  const visible = useMemo(() => visibleAesthetics(aesthetics, 'outliers'), [aesthetics]);
  const cov = useMemo(() => aestheticCoverage(cards, visible), [cards, visible]);
  const aesById = useAestheticIndex();

  // Default target priority:
  //   1. Persisted user choice (survives reloads via the store).
  //   2. Top spotlight pick if it's still a valid aesthetic.
  //   3. Highest-coverage visible aesthetic.
  //   4. First aesthetic loaded.
  const defaultTarget = useMemo(() => {
    if (persistedTarget && aesById.has(persistedTarget)) return persistedTarget;
    if (spotlight[0] && aesById.has(spotlight[0])) return spotlight[0];
    const best = [...cov].sort((a, b) => b.pct - a.pct)[0];
    return best?.id ?? aesthetics[0]?.id ?? '';
  }, [persistedTarget, spotlight, cov, aesById, aesthetics]);

  const target = defaultTarget;
  const setTarget = setOutliersTarget;

  /** Card whose "all substitutes" modal is currently open. */
  const [subModalCard, setSubModalCard] = useState<PerCardRow | null>(null);

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
                      onClick={() => setSubModalCard(card)}
                      title={
                        (crossGroup ? 'Different group — ' : '') +
                        `${aesById.get(subId)?.label} — ${subPrinting.set?.toUpperCase() ?? ''} ${subPrinting.collector_number ?? ''}\nClick to see all substitutes ranked & grouped`
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
                      const img = card.examples[id]?.image_normal ?? null;
                      return (
                        <span key={id} className={'hover-preview ot-other-chip' + (img ? '' : '')}>
                          <button
                            type="button"
                            className={'chip linklike ' + groupClass(a.group)}
                            onClick={() => openDrawer(id)}
                            title={`${a.label} — ${a.group ?? 'Other'}`}
                          >
                            {a.label}
                          </button>
                          {img && (
                            <span className="hover-preview-card" aria-hidden>
                              <img src={img} alt="" loading="lazy" />
                            </span>
                          )}
                        </span>
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

      {subModalCard && targetAes && (
        <SubstitutesModal
          card={subModalCard}
          target={targetAes}
          aesthetics={aesthetics}
          aesById={aesById}
          onClose={() => setSubModalCard(null)}
          onPick={(aid) => {
            openDrawer(aid, {
              oracle_id: subModalCard.oracle_id,
              name: subModalCard.name,
            });
            setSubModalCard(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Substitutes modal: for one blocking card, list every aesthetic this card
 * IS available in, split into:
 *
 *   1. Same group as the target aesthetic — the visually closest swaps.
 *   2. Other groups — the "next best" alternates, grouped by canonical
 *      group order so the user can scan by visual category.
 *
 * Each row shows the aesthetic label and the actual printing's art crop
 * inline so the user can decide at a glance whether the substitute
 * preserves the look they want. Clicking a row opens the focused drawer
 * for that card+aesthetic so all matching versions can be browsed.
 */
function SubstitutesModal({
  card,
  target,
  aesthetics,
  aesById,
  onClose,
  onPick,
}: {
  card: PerCardRow;
  target: Aesthetic;
  aesthetics: Aesthetic[];
  aesById: Map<string, Aesthetic>;
  onClose: () => void;
  onPick: (aestheticId: string) => void;
}) {
  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Walk aesthetics in canonical (group-ordered) order so the modal
  // lists same-group entries in the same sequence as the chip list.
  const ordered = useMemo(() => {
    const out: Aesthetic[] = [];
    for (const [, items] of groupAesthetics(aesthetics)) {
      for (const a of items) out.push(a);
    }
    return out;
  }, [aesthetics]);

  const available = useMemo(
    () => ordered.filter((a) => card.available_aesthetics.includes(a.id) && a.id !== target.id),
    [ordered, card.available_aesthetics, target.id],
  );

  const sameGroup = available.filter((a) => a.group === target.group);
  const otherGroups = available.filter((a) => a.group !== target.group);

  // Cluster cross-group alternates by their group so they read as
  // "next best within Border, next best within Treatment, …".
  const otherByGroup = useMemo(() => {
    const m = new Map<string, Aesthetic[]>();
    for (const a of otherGroups) {
      const k = a.group ?? 'Other';
      const arr = m.get(k) ?? [];
      arr.push(a);
      m.set(k, arr);
    }
    return Array.from(m.entries());
  }, [otherGroups]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer substitutes-modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        <small
          style={{
            display: 'block',
            fontSize: 10,
            color: 'var(--muted)',
            textTransform: 'uppercase',
            letterSpacing: 1,
            marginBottom: 2,
          }}
        >
          Substitutes for blocked aesthetic
        </small>
        <h1 style={{ marginRight: 24 }}>{card.name}</h1>
        <div className="muted" style={{ marginBottom: 16, fontSize: 12 }}>
          Can’t be printed with{' '}
          <strong style={{ color: 'var(--text)' }}>{target.label}</strong>. Pick the
          closest swap below — same group first, then next-best alternates.
        </div>

        {available.length === 0 && (
          <div className="muted">
            This card has no other matching aesthetics under the current filters.
          </div>
        )}

        {sameGroup.length > 0 && (
          <section className="sub-section">
            <h2>
              Closest substitutes
              <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
                same group as {target.group ?? 'target'} · {sameGroup.length}
              </span>
            </h2>
            <div className="sub-grid">
              {sameGroup.map((a) => (
                <SubstituteTile
                  key={a.id}
                  aesthetic={a}
                  card={card}
                  onPick={() => onPick(a.id)}
                />
              ))}
            </div>
          </section>
        )}

        {otherByGroup.length > 0 && (
          <section className="sub-section">
            <h2>
              Next best
              <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
                other groups · {otherGroups.length}
              </span>
            </h2>
            {otherByGroup.map(([groupName, members]) => (
              <div key={groupName} className="sub-subgroup">
                <div className={'sub-subgroup-head ' + groupClass(groupName)}>
                  <span className="sub-subgroup-name">{groupName}</span>
                  <span className="muted" style={{ fontSize: 10 }}>
                    {members.length} option{members.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="sub-grid">
                  {members.map((a) => (
                    <SubstituteTile
                      key={a.id}
                      aesthetic={a}
                      card={card}
                      onPick={() => onPick(a.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}
      </aside>
    </div>
  );
  void aesById;
}

function SubstituteTile({
  aesthetic,
  card,
  onPick,
}: {
  aesthetic: Aesthetic;
  card: PerCardRow;
  onPick: () => void;
}) {
  const printing = card.examples[aesthetic.id];
  const img = printing?.image_normal ?? printing?.image_art_crop ?? null;
  const setCode = printing?.set?.toUpperCase();
  return (
    <button
      type="button"
      className={'sub-tile ' + groupClass(aesthetic.group)}
      onClick={onPick}
      title={`${aesthetic.label} — ${setCode ?? ''} ${printing?.collector_number ?? ''}\nClick to view all matching versions`}
    >
      <span className="sub-tile-img">
        {img ? (
          <img src={img} alt="" loading="lazy" />
        ) : (
          <span className="sub-tile-placeholder" aria-hidden />
        )}
      </span>
      <span className="sub-tile-meta">
        <span className="sub-tile-label">{aesthetic.label}</span>
        {setCode && (
          <span className="sub-tile-set muted">
            {setCode} · {printing?.collector_number}
          </span>
        )}
      </span>
    </button>
  );
}
