import { useEffect, useMemo, useState } from 'react';
import { api, type SetInfo } from '../api';
import { useStore } from '../store';

/**
 * Settings modal — surfaced from a small "Settings" button in the left
 * nav. Currently exposes:
 *
 *   - Per-set kill switches: every set in the catalogue with a checkbox,
 *     grouped by `set_type` and searchable by code/name. Toggling a set
 *     drops every printing in that set from the analysis pool. Useful
 *     for excluding specific products even when the broader
 *     "non-tournament-legal" toggle is left on.
 *
 * Bulk actions per group make it easy to e.g. one-click-disable every
 * `funny` set without hunting them down individually.
 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const disabledSets = useStore((s) => s.disabledSets);
  const setDisabledSets = useStore((s) => s.setDisabledSets);
  const toggleDisabledSet = useStore((s) => s.toggleDisabledSet);
  const allowNonTournament = useStore((s) => s.allowNonTournament);
  const setAllowNonTournament = useStore((s) => s.setAllowNonTournament);
  const allowDigital = useStore((s) => s.allowDigital);
  const setAllowDigital = useStore((s) => s.setAllowDigital);

  const [sets, setSets] = useState<SetInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .setsList()
      .then((r) => {
        if (cancelled) return;
        setSets(r.sets);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const disabledSet = useMemo(() => new Set(disabledSets), [disabledSets]);

  const filtered = useMemo(() => {
    if (!sets) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return sets;
    return sets.filter(
      (s) =>
        s.code.toLowerCase().includes(q) ||
        (s.name ?? '').toLowerCase().includes(q) ||
        (s.set_type ?? '').toLowerCase().includes(q),
    );
  }, [sets, filter]);

  // Group by set_type so the user can scan / bulk-toggle by category.
  const grouped = useMemo(() => {
    const m = new Map<string, SetInfo[]>();
    for (const s of filtered) {
      const k = s.set_type ?? 'unknown';
      const arr = m.get(k) ?? [];
      arr.push(s);
      m.set(k, arr);
    }
    // Sort groups so non-tournament-legal types float to the top —
    // they're the most likely to be toggled.
    const order = (k: string) =>
      k === 'memorabilia' || k === 'funny'
        ? 0
        : k === 'promo' || k === 'token' || k === 'minigame'
          ? 1
          : 2;
    return Array.from(m.entries()).sort((a, b) => {
      const oa = order(a[0]);
      const ob = order(b[0]);
      if (oa !== ob) return oa - ob;
      return a[0].localeCompare(b[0]);
    });
  }, [filtered]);

  const totalDisabled = disabledSets.length;

  const toggleGroup = (members: SetInfo[]) => {
    const codes = members.map((m) => m.code);
    const allDisabled = codes.every((c) => disabledSet.has(c));
    const next = new Set(disabledSets);
    if (allDisabled) {
      for (const c of codes) next.delete(c);
    } else {
      for (const c of codes) next.add(c);
    }
    setDisabledSets(Array.from(next));
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer settings-modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h1 style={{ marginRight: 24 }}>Settings</h1>

        <section className="settings-section">
          <h2>Printing sources</h2>
          <label className="row">
            <input
              type="checkbox"
              checked={allowDigital}
              onChange={(e) => setAllowDigital(e.target.checked)}
            />
            Include digital-only printings (MTGA, MTGO, Alchemy)
          </label>
          <div className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 12 }}>
            Off by default — most users care about physical cards. Turn
            on if you're working with an Arena or MTGO deck.
          </div>
          <label className="row">
            <input
              type="checkbox"
              checked={allowNonTournament}
              onChange={(e) => setAllowNonTournament(e.target.checked)}
            />
            Allow non-tournament-legal cards (gold border, 30A, un-sets,
            memorabilia)
          </label>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            When off, these cards are excluded from every view. Use the
            per-set list below for finer control.
          </div>
        </section>

        <section className="settings-section">
          <h2>
            Per-set toggles
            {totalDisabled > 0 && (
              <span style={{ color: 'var(--accent)', marginLeft: 8 }}>
                · {totalDisabled} disabled
              </span>
            )}
            {totalDisabled > 0 && (
              <button
                type="button"
                className="linklike"
                style={{ marginLeft: 12, fontSize: 11 }}
                onClick={() => setDisabledSets([])}
              >
                clear all
              </button>
            )}
          </h2>

          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by code, name, or type…"
            style={{ width: '100%', marginBottom: 8 }}
          />

          {loading && <div className="muted">Loading set list…</div>}
          {error && <div className="muted">Couldn't load sets: {error}</div>}

          {grouped.map(([group, members]) => {
            const allDisabled = members.every((m) => disabledSet.has(m.code));
            const someDisabled = members.some((m) => disabledSet.has(m.code));
            return (
              <div key={group} className="settings-group">
                <div className="settings-group-head">
                  <span className="settings-group-name">{group}</span>
                  <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
                    {members.length} set{members.length === 1 ? '' : 's'}
                  </span>
                  <button
                    type="button"
                    className="linklike"
                    style={{ marginLeft: 'auto', fontSize: 11 }}
                    onClick={() => toggleGroup(members)}
                  >
                    {allDisabled ? 'enable all' : someDisabled ? 'disable rest' : 'disable all'}
                  </button>
                </div>
                <ul className="settings-set-list">
                  {members.map((s) => {
                    const off = disabledSet.has(s.code);
                    return (
                      <li
                        key={s.code}
                        className={'settings-set-row' + (off ? ' off' : '')}
                      >
                        <label className="row">
                          <input
                            type="checkbox"
                            checked={!off}
                            onChange={() => toggleDisabledSet(s.code)}
                          />
                          {s.icon && (
                            <img
                              src={s.icon}
                              alt=""
                              className="settings-set-icon"
                              loading="lazy"
                            />
                          )}
                          <span className="settings-set-code">{s.code.toUpperCase()}</span>
                          <span className="settings-set-name">{s.name}</span>
                          <span className="muted settings-set-meta">
                            {s.released_at ? s.released_at.slice(0, 4) : '—'} ·{' '}
                            {s.unique_card_count} cards
                          </span>
                          {!s.is_tournament_legal && (
                            <span
                              className="settings-set-flag"
                              title="Not tournament-legal"
                            >
                              non-tournament
                            </span>
                          )}
                          {s.is_digital && (
                            <span
                              className="settings-set-flag"
                              title="Digital-only set"
                            >
                              digital
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </section>
      </aside>
    </div>
  );
}
