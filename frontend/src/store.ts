import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Aesthetic, AnalyzeResponse, HealthResponse, PerCardRow, PrintingStrategy } from './api';

export type ViewMode =
  | 'gallery'
  | 'percard'
  | 'art'
  | 'consistency'
  | 'mosaic'
  | 'funnel'
  | 'outliers'
  | 'timeline'
  | 'compare';

interface State {
  // Inputs
  decklistText: string;
  decklistUrl: string;
  /** Selected aesthetic ids — act as filter chips (OR within group, AND across groups). */
  selectedAesthetics: Set<string>;
  /** Aesthetic ids whose printing should be highlighted in Gallery view.
   *  When non-empty, the FIRST id is the primary printing displayed; any
   *  additional ids appear as a small thumbnail strip beneath each card.
   *  These also act as **positive** spotlight filters in views that dim
   *  non-matching cards (Mosaic, Art Grid, Timeline, Coverage). */
  galleryAesthetics: string[];
  /** Aesthetic ids that act as **negative** spotlight filters: cards that
   *  satisfy any of these are dimmed (or excluded from the spotlight set). */
  gallerySpotExcluded: string[];
  includeSideboard: boolean;
  includeBasics: boolean;
  printingStrategy: PrintingStrategy;
  view: ViewMode;
  /** Card image size in pixels (longest controllable axis: card width).
   *  Legacy global value, kept for backwards compat as a fallback. */
  cardSize: number;
  /** Per-view overrides for card size. When unset, the resolved size for a
   *  view is computed via {@link defaultCardSizeFor} the first time the
   *  view is shown, then persisted. */
  cardSizeByView: Partial<Record<ViewMode, number>>;
  drawerAestheticId: string | null;
  /** Two aesthetic ids selected for the Compare view. */
  compareAesthetics: [string | null, string | null];
  /** Coverage table density: compact / default / comfortable. */
  coverageDensity: 'compact' | 'default' | 'comfortable';
  /** Aesthetic groups collapsed in the Coverage view. */
  coverageCollapsedGroups: string[];
  /** Filter group names collapsed in the left sidebar (per-group toggle). */
  collapsedFilterGroups: string[];
  /** Spotlight group names collapsed in the top spotlight bar (per-group toggle). */
  collapsedSpotlightGroups: string[];
  /** Master collapse: if true the entire Spotlight bar shows only its summary row. */
  spotlightBarCollapsed: boolean;

  // Loaded
  aesthetics: Aesthetic[];
  health: HealthResponse | null;
  result: AnalyzeResponse | null;
  loading: boolean;
  error: string | null;

  // Actions
  setText: (s: string) => void;
  setUrl: (s: string) => void;
  toggleAesthetic: (id: string) => void;
  /** Toggle every aesthetic in `groupName`. If any chip in the group is
   *  unselected, select all `eligibleIds`; otherwise clear them all. */
  toggleGroup: (groupName: string, eligibleIds: string[]) => void;
  selectAllAesthetics: () => void;
  clearAesthetics: () => void;
  setIncludeSideboard: (v: boolean) => void;
  setIncludeBasics: (v: boolean) => void;
  setPrintingStrategy: (s: PrintingStrategy) => void;
  setView: (v: ViewMode) => void;
  setCardSize: (n: number) => void;
  /** Set the card size for a specific view (per-view persistence). */
  setCardSizeForView: (v: ViewMode, n: number) => void;
  setAesthetics: (a: Aesthetic[]) => void;
  setHealth: (h: HealthResponse) => void;
  setResult: (r: AnalyzeResponse | null) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  openDrawer: (id: string | null) => void;
  setCompareAesthetics: (ids: [string | null, string | null]) => void;
  setCoverageDensity: (d: 'compact' | 'default' | 'comfortable') => void;
  toggleCoverageGroup: (group: string) => void;
  toggleFilterGroupCollapsed: (group: string) => void;
  toggleSpotlightGroupCollapsed: (group: string) => void;
  setSpotlightBarCollapsed: (v: boolean) => void;
  /** Clear both spotlight include and exclude lists in one action. */
  clearSpotlight: () => void;
  setGalleryAesthetics: (ids: string[]) => void;
  toggleGalleryAesthetic: (id: string) => void;
  /** Cycle a chip through the three spotlight states:
   *  off → include → exclude → off. */
  cycleSpotlightAesthetic: (id: string) => void;
  /** Toggle every aesthetic in `groupName` for the spotlight. */
  toggleSpotlightGroup: (groupName: string, eligibleIds: string[]) => void;
}

export const useStore = create<State>()(
  persist(
    (set) => ({
      decklistText: '',
      decklistUrl: '',
      selectedAesthetics: new Set(),
      galleryAesthetics: [],
      gallerySpotExcluded: [],
      includeSideboard: true,
      includeBasics: false,
      printingStrategy: ['paper', 'lang:en', 'foil:nonfoil', 'border:black', 'first'],
      view: 'consistency',
      cardSize: 168,
      cardSizeByView: {},
      drawerAestheticId: null,
      compareAesthetics: [null, null],
      coverageDensity: 'default',
      coverageCollapsedGroups: [],
      collapsedFilterGroups: [],
      collapsedSpotlightGroups: [],
      spotlightBarCollapsed: false,

      aesthetics: [],
      health: null,
      result: null,
      loading: false,
      error: null,

      setText: (s) => set({ decklistText: s }),
      setUrl: (s) => set({ decklistUrl: s }),
      toggleAesthetic: (id) =>
        set((st) => {
          const next = new Set(st.selectedAesthetics);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return { selectedAesthetics: next };
        }),
      toggleGroup: (_groupName, eligibleIds) =>
        set((st) => {
          const next = new Set(st.selectedAesthetics);
          const allSelected = eligibleIds.length > 0 && eligibleIds.every((id) => next.has(id));
          if (allSelected) {
            for (const id of eligibleIds) next.delete(id);
          } else {
            for (const id of eligibleIds) next.add(id);
          }
          return { selectedAesthetics: next };
        }),
      selectAllAesthetics: () => set({ selectedAesthetics: new Set() }),
      clearAesthetics: () => set({ selectedAesthetics: new Set() }),
      setIncludeSideboard: (v) => set({ includeSideboard: v }),
      setIncludeBasics: (v) => set({ includeBasics: v }),
      setPrintingStrategy: (s) => set({ printingStrategy: s }),
      setView: (v) => set({ view: v }),
      setCardSize: (n) => set({ cardSize: Math.max(80, Math.min(360, Math.round(n))) }),
      setCardSizeForView: (v, n) =>
        set((st) => ({
          cardSizeByView: {
            ...st.cardSizeByView,
            [v]: Math.max(80, Math.min(360, Math.round(n))),
          },
        })),
      setAesthetics: (a) => set({ aesthetics: a }),
      setHealth: (h) => set({ health: h }),
      setResult: (r) => set({ result: r }),
      setLoading: (b) => set({ loading: b }),
      setError: (e) => set({ error: e }),
      openDrawer: (id) => set({ drawerAestheticId: id }),
      setCompareAesthetics: (ids) => set({ compareAesthetics: ids }),
      setCoverageDensity: (d) => set({ coverageDensity: d }),
      toggleCoverageGroup: (group) =>
        set((st) => {
          const cur = st.coverageCollapsedGroups;
          return {
            coverageCollapsedGroups: cur.includes(group)
              ? cur.filter((g) => g !== group)
              : [...cur, group],
          };
        }),
      toggleFilterGroupCollapsed: (group) =>
        set((st) => {
          const cur = st.collapsedFilterGroups;
          return {
            collapsedFilterGroups: cur.includes(group)
              ? cur.filter((g) => g !== group)
              : [...cur, group],
          };
        }),
      toggleSpotlightGroupCollapsed: (group) =>
        set((st) => {
          const cur = st.collapsedSpotlightGroups;
          return {
            collapsedSpotlightGroups: cur.includes(group)
              ? cur.filter((g) => g !== group)
              : [...cur, group],
          };
        }),
      setSpotlightBarCollapsed: (v) => set({ spotlightBarCollapsed: v }),
      clearSpotlight: () => set({ galleryAesthetics: [], gallerySpotExcluded: [] }),
      setGalleryAesthetics: (ids) => set({ galleryAesthetics: ids }),
      toggleGalleryAesthetic: (id) =>
        set((st) => {
          const cur = st.galleryAesthetics;
          // Always keep include and exclude mutually exclusive.
          const nextExcl = st.gallerySpotExcluded.filter((x) => x !== id);
          return {
            galleryAesthetics: cur.includes(id)
              ? cur.filter((x) => x !== id)
              : [...cur, id],
            gallerySpotExcluded: nextExcl,
          };
        }),
      cycleSpotlightAesthetic: (id) =>
        set((st) => {
          const inIncl = st.galleryAesthetics.includes(id);
          const inExcl = st.gallerySpotExcluded.includes(id);
          if (!inIncl && !inExcl) {
            // off → include
            return {
              galleryAesthetics: [...st.galleryAesthetics, id],
              gallerySpotExcluded: st.gallerySpotExcluded,
            };
          }
          if (inIncl) {
            // include → exclude (move from incl to excl)
            return {
              galleryAesthetics: st.galleryAesthetics.filter((x) => x !== id),
              gallerySpotExcluded: [...st.gallerySpotExcluded, id],
            };
          }
          // exclude → off
          return {
            galleryAesthetics: st.galleryAesthetics,
            gallerySpotExcluded: st.gallerySpotExcluded.filter((x) => x !== id),
          };
        }),
      toggleSpotlightGroup: (_groupName, eligibleIds) =>
        set((st) => {
          const cur = st.galleryAesthetics;
          const allOn = eligibleIds.length > 0 && eligibleIds.every((id) => cur.includes(id));
          if (allOn) {
            return { galleryAesthetics: cur.filter((id) => !eligibleIds.includes(id)) };
          }
          // Adding ids to the include list — also strip them from the
          // exclude list so a chip can never end up in both states. The
          // visible include badge would otherwise hide a still-active
          // exclude that silently filters out cards.
          const next = [...cur];
          for (const id of eligibleIds) if (!next.includes(id)) next.push(id);
          const eligibleSet = new Set(eligibleIds);
          const nextExcl = st.gallerySpotExcluded.filter((id) => !eligibleSet.has(id));
          return { galleryAesthetics: next, gallerySpotExcluded: nextExcl };
        }),
    }),
    {
      name: 'deckaesthetics-prefs',
      storage: createJSONStorage(() => localStorage),
      // Only persist user preferences — never the loaded data or transient UI.
      // Sets aren't JSON-serializable, so we round-trip via arrays.
      partialize: (s) => ({
        decklistText: s.decklistText,
        decklistUrl: s.decklistUrl,
        selectedAesthetics: Array.from(s.selectedAesthetics),
        galleryAesthetics: s.galleryAesthetics,
        gallerySpotExcluded: s.gallerySpotExcluded,
        includeSideboard: s.includeSideboard,
        includeBasics: s.includeBasics,
        printingStrategy: s.printingStrategy,
        view: s.view,
        cardSize: s.cardSize,
        cardSizeByView: s.cardSizeByView,
        coverageDensity: s.coverageDensity,
        coverageCollapsedGroups: s.coverageCollapsedGroups,
        collapsedFilterGroups: s.collapsedFilterGroups,
        collapsedSpotlightGroups: s.collapsedSpotlightGroups,
        spotlightBarCollapsed: s.spotlightBarCollapsed,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State> & {
          selectedAesthetics?: unknown;
          galleryAesthetic?: unknown;
        };
        const sel = Array.isArray(p.selectedAesthetics)
          ? new Set(p.selectedAesthetics as string[])
          : current.selectedAesthetics;
        // Migrate v1 single-select galleryAesthetic -> array.
        let gallery = current.galleryAesthetics;
        if (Array.isArray(p.galleryAesthetics)) {
          gallery = p.galleryAesthetics as string[];
        } else if (typeof p.galleryAesthetic === 'string') {
          gallery = [p.galleryAesthetic];
        }
        return {
          ...current,
          ...p,
          selectedAesthetics: sel,
          galleryAesthetics: gallery,
          // Defensive: persisted state from older builds may be missing
          // these fields. Spread above would set them to `undefined`,
          // which breaks `.includes` / `.length` calls downstream.
          gallerySpotExcluded: Array.isArray(p.gallerySpotExcluded)
            ? p.gallerySpotExcluded
            : current.gallerySpotExcluded,
          collapsedFilterGroups: Array.isArray(p.collapsedFilterGroups)
            ? p.collapsedFilterGroups
            : current.collapsedFilterGroups,
          collapsedSpotlightGroups: Array.isArray(p.collapsedSpotlightGroups)
            ? p.collapsedSpotlightGroups
            : current.collapsedSpotlightGroups,
          coverageCollapsedGroups: Array.isArray(p.coverageCollapsedGroups)
            ? p.coverageCollapsedGroups
            : current.coverageCollapsedGroups,
          cardSizeByView:
            p.cardSizeByView && typeof p.cardSizeByView === 'object'
              ? p.cardSizeByView
              : current.cardSizeByView,
          spotlightBarCollapsed:
            typeof p.spotlightBarCollapsed === 'boolean'
              ? p.spotlightBarCollapsed
              : current.spotlightBarCollapsed,
          coverageDensity:
            p.coverageDensity === 'compact' || p.coverageDensity === 'default' || p.coverageDensity === 'comfortable'
              ? p.coverageDensity
              : current.coverageDensity,
          // Removed view modes — fall back to a sensible default.
          view:
            (p.view as string) === 'matrix' ||
            (p.view as string) === 'recommend' ||
            (p.view as string) === 'sets' ||
            !p.view
              ? current.view
              : (p.view as ViewMode),
        };
      },
      version: 2,
    },
  ),
);

// ----- Cross-filter helpers (pure) -----

/**
 * Compute whether a card matches the current spotlight selection.
 *
 * Tri-state spotlight:
 *   - `included`: positive filter — card matches if it has *any* of these
 *     in its `available` list (Gallery will swap the displayed printing).
 *   - `excluded`: negative filter — card is removed if its *currently
 *     displayed* printing satisfies any of these. We pass the chosen
 *     printing's `defaultSatisfies` separately so excluding "M15 frame"
 *     hides cards whose preferred printing is M15-framed, not every card
 *     that happens to also have one M15-era reprint somewhere.
 *
 * Rules (in order):
 *   1. If both arrays are empty: no spotlight → match = true.
 *   2. If the card's defaultSatisfies set has any excluded id → false.
 *      (Falls back to `available` when defaultSatisfies isn't supplied,
 *      e.g. older backend without `default_aesthetics`.)
 *   3. If `included` is non-empty: match iff `available` has any included id.
 *   4. Else: match = true.
 */
export function matchesSpotlight(
  available: readonly string[],
  included: readonly string[],
  excluded: readonly string[],
  defaultSatisfies?: readonly string[] | null,
): boolean {
  if (included.length === 0 && excluded.length === 0) return true;
  if (excluded.length > 0) {
    const excludeProbe = defaultSatisfies ?? available;
    for (const id of excluded) if (excludeProbe.includes(id)) return false;
  }
  if (included.length > 0) {
    for (const id of included) if (available.includes(id)) return true;
    return false;
  }
  return true;
}

/**
 * Whether the Spotlight bar should appear on this view. Spotlight has
 * meaning on per-card visual surfaces (Gallery swaps printings; Mosaic /
 * Art Grid / Timeline / Coverage dim non-matches). It's noise on the
 * aggregate / analytical surfaces.
 */
export function viewSupportsSpotlight(view: ViewMode): boolean {
  return (
    view === 'gallery' ||
    view === 'mosaic' ||
    view === 'art' ||
    view === 'timeline' ||
    view === 'percard'
  );
}

/** Group aesthetic ids by their group string.
 *
 *  Within each group the items are sorted to keep the sidebar predictable:
 *  most groups have an explicit canonical order (Frame Era chronological,
 *  Border by visual prominence, Origin by Magic-first, Promo/Other by
 *  rarity); anything not in the canonical map sorts alphabetically by
 *  label. */
export function groupAesthetics(aesthetics: Aesthetic[]): Map<string, Aesthetic[]> {
  const g = new Map<string, Aesthetic[]>();
  for (const a of aesthetics) {
    const key = a.group ?? 'Other';
    if (!g.has(key)) g.set(key, []);
    g.get(key)!.push(a);
  }
  for (const [key, items] of g) {
    const k = key.toLowerCase();
    const canonical = CANONICAL_ORDERS[k];
    if (canonical) {
      items.sort((a, b) => {
        const ai = canonical.indexOf(a.id);
        const bi = canonical.indexOf(b.id);
        // Items in the canonical list come first in canonical order; the
        // rest fall to the end alphabetically.
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.label.localeCompare(b.label);
      });
    } else if (k.startsWith('frame')) {
      // Generic frame-era sort by embedded year, with `future` last.
      items.sort((a, b) => {
        const ay = yearFromFrameId(a.id);
        const by = yearFromFrameId(b.id);
        if (ay != null && by != null) return ay - by;
        if (ay != null) return -1;
        if (by != null) return 1;
        return a.label.localeCompare(b.label);
      });
    } else {
      items.sort((a, b) => a.label.localeCompare(b.label));
    }
  }
  return g;
}

/** Canonical per-group orderings for the sidebar. Keys are lower-case
 *  group names; values are arrays of aesthetic ids in display order.
 *  Ids not present in the array fall through to alphabetical order. */
const CANONICAL_ORDERS: Record<string, string[]> = {
  'frame era': ['frame_1993', 'frame_1997', 'frame_2003', 'frame_2015', 'frame_future'],
  border: ['border_black', 'border_white', 'borderless', 'border_silver', 'border_gold'],
  origin: ['universes_within', 'universes_beyond', 'paper_only'],
  other: [
    'promo_retro',
    'promo_serialized',
    'prerelease_stamp',
    'promo_pack',
    'bundle_promo',
    'oversized',
  ],
};

function yearFromFrameId(id: string): number | null {
  const m = /(\d{4})/.exec(id);
  return m ? Number(m[1]) : null;
}

/** Resolve the card-image size for a view. Returns the per-view persisted
 *  size if one is set; otherwise a viewport-aware default. */
export function resolveCardSize(
  view: ViewMode,
  byView: Partial<Record<ViewMode, number>>,
): number {
  const v = byView[view];
  if (typeof v === 'number') return v;
  return defaultCardSizeFor(view);
}

/** Heuristic default card size based on viewport dimensions and the view.
 *  Kept dependency-free so it can run at module load time. */
export function defaultCardSizeFor(view: ViewMode): number {
  if (typeof window === 'undefined') return 168;
  const w = window.innerWidth || 1280;
  // Gallery / Mosaic want lots of cards per row; Art Grid wants the cards
  // big enough to read set + collector number; Compare benefits from large.
  const widthBucket = w >= 2200 ? 'xl' : w >= 1600 ? 'lg' : w >= 1200 ? 'md' : w >= 900 ? 'sm' : 'xs';
  const table: Record<ViewMode, Record<string, number>> = {
    gallery:     { xl: 200, lg: 176, md: 156, sm: 140, xs: 120 },
    mosaic:      { xl: 144, lg: 128, md: 116, sm: 100, xs:  88 },
    art:         { xl: 220, lg: 196, md: 176, sm: 156, xs: 132 },
    compare:     { xl: 220, lg: 196, md: 176, sm: 156, xs: 132 },
    percard:     { xl: 168, lg: 160, md: 152, sm: 140, xs: 120 },
    consistency: { xl: 168, lg: 168, md: 168, sm: 168, xs: 168 },
    funnel:      { xl: 168, lg: 168, md: 168, sm: 168, xs: 168 },
    outliers:    { xl: 168, lg: 168, md: 168, sm: 168, xs: 168 },
    timeline:    { xl: 168, lg: 168, md: 168, sm: 168, xs: 168 },
  };
  return table[view][widthBucket] ?? 168;
}

/** Build a map: group -> set of selected aesthetic ids in that group. */
function selectionsByGroup(
  selected: Set<string>,
  aesthetics: Aesthetic[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const idToGroup = new Map<string, string>();
  for (const a of aesthetics) idToGroup.set(a.id, a.group ?? 'Other');
  for (const id of selected) {
    const g = idToGroup.get(id);
    if (!g) continue;
    if (!out.has(g)) out.set(g, new Set());
    out.get(g)!.add(id);
  }
  return out;
}

/** Build a map: group -> set of ALL aesthetic ids in that group (regardless
 *  of selection state). Used by `cardMatches` to detect groups that simply
 *  don't apply to a given card. */
function allIdsByGroup(aesthetics: Aesthetic[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const a of aesthetics) {
    const g = a.group ?? 'Other';
    if (!out.has(g)) out.set(g, new Set());
    out.get(g)!.add(a.id);
  }
  return out;
}

/**
 * Does this card pass the given group->selectedIds filter?
 *
 * Within group: OR. Across groups: AND.
 *
 * **Skip-if-inapplicable rule**: if the card has *zero* available
 * aesthetics across the entire group (not just the selected subset), the
 * group's constraint is treated as "not applicable" and the card passes
 * automatically. This prevents a treatment-style filter (e.g. selecting
 * "Phyrexian" under Showcase Treatment) from excluding cards that simply
 * have no Showcase Treatment options at all — those rows should remain.
 *
 * Pass `groupAllIdsMap` from `allIdsByGroup(aesthetics)`. When omitted
 * the strict legacy behavior is used (every selected group must match).
 */
export function cardMatches(
  card: PerCardRow,
  selectionsByGroupMap: Map<string, Set<string>>,
  groupAllIdsMap?: Map<string, Set<string>>,
  /** Pre-built `Set(card.available_aesthetics)` — pass this when calling
   *  cardMatches in a tight loop to avoid re-constructing the set per
   *  call. Built lazily otherwise. */
  cardAvailSet?: Set<string>,
): boolean {
  if (!card.resolved) return false;
  const cardSet = cardAvailSet ?? new Set(card.available_aesthetics);
  for (const [groupName, groupSel] of selectionsByGroupMap) {
    if (groupSel.size === 0) continue;
    // Skip-if-inapplicable: if the card has nothing in this group at all,
    // the constraint is vacuously satisfied.
    const groupAll = groupAllIdsMap?.get(groupName);
    if (groupAll) {
      let anyInGroup = false;
      for (const id of groupAll) {
        if (cardSet.has(id)) { anyInGroup = true; break; }
      }
      if (!anyInGroup) continue;
    }
    let any = false;
    for (const aid of groupSel) {
      if (cardSet.has(aid)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }
  return true;
}

/** Cards passing the current selection. */
export function filterCards(cards: PerCardRow[], selected: Set<string>, aesthetics: Aesthetic[]): PerCardRow[] {
  const sbg = selectionsByGroup(selected, aesthetics);
  if (sbg.size === 0) return cards.filter((c) => c.resolved);
  const allByGroup = allIdsByGroup(aesthetics);
  // Pre-build per-card Set once instead of inside cardMatches per call.
  return cards.filter((c) => {
    if (!c.resolved) return false;
    return cardMatches(c, sbg, allByGroup, new Set(c.available_aesthetics));
  });
}

/**
 * Bulk: for each aesthetic id, return the set of cards that would be
 * visible if that chip were toggled into its OPPOSITE state under the
 * current selection. Computes the per-card available_aesthetics set once
 * up-front (avoiding `cards × aesthetics` set-construction) and the
 * groupAll map once. Replaces what was 41 separate filterCards() calls
 * in the App's chipCounts useMemo.
 */
export function chipToggleCounts(
  cards: PerCardRow[],
  selected: Set<string>,
  aesthetics: Aesthetic[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (cards.length === 0) {
    for (const a of aesthetics) out.set(a.id, 0);
    return out;
  }
  const resolvedCards = cards.filter((c) => c.resolved);
  const availSets: Set<string>[] = resolvedCards.map(
    (c) => new Set(c.available_aesthetics),
  );
  const allByGroup = allIdsByGroup(aesthetics);
  // Build the base SBG once.
  const baseSbg = selectionsByGroup(selected, aesthetics);
  const idToGroup = new Map<string, string>();
  for (const a of aesthetics) idToGroup.set(a.id, a.group ?? 'Other');

  // For each aesthetic we want SBG with that one chip's membership flipped.
  // Cloning the entire map per aesthetic is wasteful; instead, mutate just
  // the affected group's set, then restore after counting.
  for (const a of aesthetics) {
    const group = idToGroup.get(a.id) ?? 'Other';
    const wasIn = selected.has(a.id);

    // Mutate baseSbg for just this group.
    let restoreSet: Set<string> | undefined;
    let groupAdded = false;
    let groupRemoved = false;
    const existing = baseSbg.get(group);
    if (wasIn) {
      // Toggling OFF: drop a.id from the group.
      if (existing) {
        if (existing.size === 1) {
          baseSbg.delete(group);
          restoreSet = existing;
          groupRemoved = true;
        } else {
          existing.delete(a.id);
        }
      }
    } else {
      // Toggling ON: add a.id to the group (creating set if needed).
      if (existing) existing.add(a.id);
      else {
        baseSbg.set(group, new Set([a.id]));
        groupAdded = true;
      }
    }

    let n = 0;
    if (baseSbg.size === 0) {
      n = resolvedCards.length;
    } else {
      for (let i = 0; i < resolvedCards.length; i++) {
        if (cardMatchesIndexed(availSets[i], baseSbg, allByGroup)) n++;
      }
    }
    out.set(a.id, n);

    // Restore baseSbg for the next iteration.
    if (wasIn) {
      if (groupRemoved) baseSbg.set(group, restoreSet!);
      else baseSbg.get(group)!.add(a.id);
    } else {
      if (groupAdded) baseSbg.delete(group);
      else baseSbg.get(group)!.delete(a.id);
    }
  }
  return out;
}

/** Inner-loop variant of cardMatches that takes pre-built data only. */
function cardMatchesIndexed(
  availSet: Set<string>,
  selectionsByGroupMap: Map<string, Set<string>>,
  groupAllIdsMap: Map<string, Set<string>>,
): boolean {
  for (const [groupName, groupSel] of selectionsByGroupMap) {
    if (groupSel.size === 0) continue;
    const groupAll = groupAllIdsMap.get(groupName);
    if (groupAll) {
      let anyInGroup = false;
      for (const id of groupAll) if (availSet.has(id)) { anyInGroup = true; break; }
      if (!anyInGroup) continue;
    }
    let any = false;
    for (const aid of groupSel) if (availSet.has(aid)) { any = true; break; }
    if (!any) return false;
  }
  return true;
}

export interface SummaryRow {
  aesthetic_id: string;
  label: string;
  group: string | null;
  available_unique: number;
  total_unique: number;
  available_qty: number;
  total_qty: number;
  coverage_pct: number;
}

/** Recompute the per-aesthetic summary against a (possibly filtered) card set. */
export function computeSummary(
  cards: PerCardRow[],
  aesthetics: Aesthetic[],
): SummaryRow[] {
  const totalUnique = cards.length;
  const totalQty = cards.reduce((s, c) => s + c.qty, 0);
  return aesthetics.map((a) => {
    let availU = 0;
    let availQ = 0;
    for (const c of cards) {
      if (c.available_aesthetics.includes(a.id)) {
        availU++;
        availQ += c.qty;
      }
    }
    return {
      aesthetic_id: a.id,
      label: a.label,
      group: a.group,
      available_unique: availU,
      total_unique: totalUnique,
      available_qty: availQ,
      total_qty: totalQty,
      coverage_pct: totalQty ? Math.round((availQ / totalQty) * 1000) / 10 : 0,
    };
  });
}
