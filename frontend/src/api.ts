// API types and client.

export type Section = 'mainboard' | 'sideboard' | 'commander' | 'companion';

/** A preference spec is a string of the form "kind" or "kind:value".
 *  Examples: "first", "latest", "most_valuable", "border:black",
 *  "frame:future", "foil:nonfoil", "promo:nonpromo". */
export type PrintingPref = string;

/** Ordered list of preferences, highest priority first. Empty list = default tiebreaker only. */
export type PrintingStrategy = PrintingPref[];

export interface Aesthetic {
  id: string;
  label: string;
  description: string;
  group: string | null;
  icon: string | null;
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

export interface PerCardExample {
  set: string | null;
  set_name: string | null;
  collector_number: string | null;
  image_normal: string | null;
  image_art_crop: string | null;
  price_usd: number | null;
  released_at: string | null;
  frame: string | null;
  /** Aesthetic ids this specific printing satisfies. Populated by the
   *  backend so the Gallery view can pick a next-best printing that
   *  avoids any spotlight-excluded aesthetics. May be missing on older
   *  backends. */
  satisfies?: string[];
  /** False iff this printing is from a non-tournament-legal source
   *  (gold/silver border, funny / memorabilia set_type, 30A). The
   *  frontend overlays a red "Not tournament legal" banner on these.
   *  Optional for backwards compatibility. */
  is_tournament_legal?: boolean;
}

export interface PerCardRow {
  name: string;
  name_normalized: string;
  qty: number;
  oracle_id: string | null;
  sections: Section[];
  resolved: boolean;
  available_aesthetics: string[];
  /** Aesthetics whose predicate is satisfied by the chosen `default` printing.
   *  Subset of available_aesthetics. May be missing on older backends. */
  default_aesthetics?: string[];
  /** Per-aesthetic count of distinct printings of this card that satisfy
   *  that aesthetic. Used by the Coverage view to show "N versions" per
   *  cell. May be missing on older backends. */
  version_counts?: Record<string, number>;
  examples: Record<string, PerCardExample>;
  default: PerCardExample | null;
}

export interface AnalyzeResponse {
  summary: SummaryRow[];
  per_card: PerCardRow[];
  warnings: string[];
  data_version: string | null;
  totals: { unique_cards: number; total_qty: number; unresolved: number };
  elapsed_ms: number;
}

export interface HealthResponse {
  status: string;
  data_version: string | null;
  refresh_age_seconds: number | null;
  aesthetics_loaded: number;
  version: string;
}

const BASE = ''; // same-origin

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`${r.status} ${r.statusText}: ${detail}`);
  }
  return r.json() as Promise<T>;
}

export interface PrintingDetail extends PerCardExample {
  border_color: string | null;
  frame: string | null;
  lang: string | null;
  digital: boolean | null;
  full_art: boolean | null;
  textless: boolean | null;
  promo: boolean | null;
  promo_types: string[];
  frame_effects: string[];
  security_stamp: string | null;
  set_type: string | null;
  released_at: string | null;
  price_usd: number | null;
}

export interface PrintingsResponse {
  oracle_id: string;
  printings: PrintingDetail[];
}

export interface SetInfo {
  code: string;
  name: string;
  set_type: string | null;
  released_at: string | null;
  printing_count: number;
  unique_card_count: number;
  icon: string | null;
  is_tournament_legal: boolean;
  is_digital: boolean;
}

export const api = {
  health: () => jfetch<HealthResponse>('/api/health'),
  aesthetics: () => jfetch<{ aesthetics: Aesthetic[] }>('/api/aesthetics'),
  importers: () => jfetch<{ importers: { name: string; hosts: string[] }[] }>('/api/importers'),
  sets: () => jfetch<{ sets: Record<string, string> }>('/api/sets'),
  setsList: () => jfetch<{ sets: SetInfo[] }>('/api/sets/list'),
  analyze: (body: {
    decklist: { text?: string; url?: string };
    aesthetic_ids?: string[];
    include_sideboard: boolean;
    include_basics: boolean;
    allow_non_tournament?: boolean;
    allow_digital?: boolean;
    disabled_sets?: string[];
    printing_strategy?: PrintingStrategy;
  }) =>
    jfetch<AnalyzeResponse>('/api/analyze', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  printings: (body: {
    oracle_id?: string;
    name?: string;
    aesthetic_id?: string;
    printing_strategy?: PrintingStrategy;
    allow_non_tournament?: boolean;
    allow_digital?: boolean;
    disabled_sets?: string[];
    limit?: number;
  }) =>
    jfetch<PrintingsResponse>('/api/printings', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
