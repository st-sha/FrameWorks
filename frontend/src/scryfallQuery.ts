// Scryfall-syntax query parser + evaluator for the top-of-page filter.
//
// Supports a useful subset of https://scryfall.com/docs/syntax against the
// per-card data we have client-side (PerCardRow + its `default` printing).
// Bare words are treated as a name substring match for back-compat with
// the previous textbox behaviour. Boolean operators (AND / OR / NOT / -),
// parentheses, quoted strings, and comparison operators are supported.
//
// Predicates implemented:
//   - name:               bare word, or `name:`    substring on name
//   - t:    / type:       substring on type_line
//   - o:    / oracle:     substring on oracle_text
//   - c:    / color:      color set ops on `colors`
//   - id:   / identity:   color set ops on `color_identity`
//   - m:    / mana:       substring on mana_cost (matches both faces)
//   - mv:   / cmc:        numeric on cmc
//   - pow:  / power:      numeric (or string) on power
//   - tou:  / toughness:  numeric (or string) on toughness
//   - loy:  / loyalty:    numeric on loyalty
//   - r:    / rarity:     equality (common/uncommon/rare/mythic + ordering)
//   - kw:   / keyword:    case-insensitive includes on keywords[]
//   - layout:             equality on layout
//   - produces / prod:    color/list ops on produced_mana
//   - set:  / s: / e: / edition: equality on default printing's set code
//   - cn:   / number:     equality on default.collector_number
//   - border:             equality on default.border_color
//   - frame:              equality on default.frame
//   - stamp:              equality on default.security_stamp
//   - lang:               equality on default.lang
//   - year:               numeric year from default.released_at
//   - date:               ISO date comparison on default.released_at
//   - usd:                numeric on default.price_usd
//   - is: / not:          flag tokens (foil, nonfoil, promo, fullart,
//                         textless, digital, vanilla, french-vanilla,
//                         permanent, historic, commander, legendary,
//                         bear, paper, tournament-legal)
//
// Anything we can't evaluate (missing data, unknown key) returns false
// for that predicate without raising — the user sees an empty result
// rather than a crash.

import type { PerCardRow, PerCardExample } from './api';

// ---------------------------------------------------------------------------
// AST types
// ---------------------------------------------------------------------------

export type Op = ':' | '=' | '!=' | '<' | '<=' | '>' | '>=';

export type AstNode =
  | { type: 'and'; children: AstNode[] }
  | { type: 'or'; children: AstNode[] }
  | { type: 'not'; child: AstNode }
  | { type: 'pred'; key: string; op: Op; value: string };

export type ParseResult = { ast: AstNode } | { error: string };

// ---------------------------------------------------------------------------
// Heuristic: does this look like Scryfall syntax, or just a bare-name search?
// ---------------------------------------------------------------------------

/** True if the input contains anything that suggests query syntax (operators,
 *  quotes, parens, boolean keywords). Otherwise treat as bare-name substring
 *  for back-compat with the old filter. */
export function isQuerySyntax(input: string): boolean {
  const s = input.trim();
  if (!s) return false;
  // Operator-ish characters that wouldn't appear in a card name search.
  if (/[:=<>"()]/.test(s)) return true;
  // A leading `-` flips a token from "include" to "exclude".
  if (s.startsWith('-')) return true;
  // Bare boolean keywords (uppercase or surrounded by spaces).
  if (/(?:^|\s)(?:AND|OR|NOT)(?:\s|$)/.test(s)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'word'; value: string }
  | { kind: 'op'; value: Op }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'and' }
  | { kind: 'or' }
  | { kind: 'not' };

function tokenize(input: string): Token[] | { error: string } {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

  while (i < n) {
    const ch = input[i];
    if (isSpace(ch)) { i++; continue; }

    if (ch === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
    if (ch === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }

    // Comparison operators that can stand on their own only when
    // immediately preceded by a key word (handled in parser via context).
    // Here we scan multi-char ops greedily so the parser sees them as one
    // token attached to the next value via the operator slot.

    // Quoted string (double-quote only; Scryfall accepts ' too — ignored
    // for simplicity).
    if (ch === '"') {
      let j = i + 1;
      let buf = '';
      while (j < n && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < n) { buf += input[j + 1]; j += 2; continue; }
        buf += input[j];
        j++;
      }
      if (j >= n) return { error: 'Unterminated quoted string' };
      tokens.push({ kind: 'word', value: buf });
      i = j + 1;
      continue;
    }

    // Leading `-` is a NOT prefix (only when followed by a non-space).
    if (ch === '-' && i + 1 < n && !isSpace(input[i + 1]) && input[i + 1] !== ')') {
      tokens.push({ kind: 'not' });
      i++;
      continue;
    }

    // Word run: read until whitespace/paren. Inside the run, we may hit
    // an operator (`:`, `=`, `<`, `<=`, `>`, `>=`, `!=`); split there so
    // `t:creature` becomes [word "t", op ":", word "creature"].
    let j = i;
    let buf = '';
    let opSeen = false;
    while (j < n) {
      const cj = input[j];
      if (isSpace(cj) || cj === '(' || cj === ')') break;
      if (cj === '"') break;
      if (!opSeen) {
        // Detect operator boundary inside the run.
        if (cj === ':' || cj === '=') {
          // Push the key word, then the op.
          if (buf) tokens.push({ kind: 'word', value: buf });
          tokens.push({ kind: 'op', value: cj as Op });
          buf = '';
          opSeen = true;
          j++;
          continue;
        }
        if (cj === '<' || cj === '>') {
          if (buf) tokens.push({ kind: 'word', value: buf });
          // Two-char form?
          if (j + 1 < n && input[j + 1] === '=') {
            tokens.push({ kind: 'op', value: (cj + '=') as Op });
            j += 2;
          } else {
            tokens.push({ kind: 'op', value: cj as Op });
            j++;
          }
          buf = '';
          opSeen = true;
          continue;
        }
        if (cj === '!' && j + 1 < n && input[j + 1] === '=') {
          if (buf) tokens.push({ kind: 'word', value: buf });
          tokens.push({ kind: 'op', value: '!=' });
          buf = '';
          opSeen = true;
          j += 2;
          continue;
        }
      }
      buf += cj;
      j++;
    }
    if (buf) {
      // Bare boolean keywords.
      const upper = buf.toUpperCase();
      if (upper === 'AND' && !opSeen) tokens.push({ kind: 'and' });
      else if (upper === 'OR' && !opSeen) tokens.push({ kind: 'or' });
      else if (upper === 'NOT' && !opSeen) tokens.push({ kind: 'not' });
      else tokens.push({ kind: 'word', value: buf });
    }
    i = j;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent: OR > AND > NOT > atom)
// ---------------------------------------------------------------------------

export function parseQuery(input: string): ParseResult {
  const toks = tokenize(input);
  if ('error' in toks) return toks;
  if (toks.length === 0) return { error: 'Empty query' };

  let pos = 0;
  const peek = (): Token | undefined => toks[pos];
  const eat = (): Token | undefined => toks[pos++];

  function parseOr(): AstNode | { error: string } {
    const left = parseAnd();
    if ('error' in left) return left;
    const parts: AstNode[] = [left];
    while (peek()?.kind === 'or') {
      eat();
      const r = parseAnd();
      if ('error' in r) return r;
      parts.push(r);
    }
    return parts.length === 1 ? parts[0] : { type: 'or', children: parts };
  }

  function parseAnd(): AstNode | { error: string } {
    const parts: AstNode[] = [];
    while (true) {
      const t = peek();
      if (!t) break;
      if (t.kind === 'rparen' || t.kind === 'or') break;
      if (t.kind === 'and') { eat(); continue; }
      const r = parseNot();
      if ('error' in r) return r;
      parts.push(r);
    }
    if (parts.length === 0) return { error: 'Expected an expression' };
    return parts.length === 1 ? parts[0] : { type: 'and', children: parts };
  }

  function parseNot(): AstNode | { error: string } {
    if (peek()?.kind === 'not') {
      eat();
      const r = parseNot();
      if ('error' in r) return r;
      return { type: 'not', child: r };
    }
    return parseAtom();
  }

  function parseAtom(): AstNode | { error: string } {
    const t = eat();
    if (!t) return { error: 'Unexpected end of input' };
    if (t.kind === 'lparen') {
      const inner = parseOr();
      if ('error' in inner) return inner;
      const close = eat();
      if (!close || close.kind !== 'rparen') return { error: 'Expected )' };
      return inner;
    }
    if (t.kind === 'word') {
      // Look ahead for an operator to form a key:value pred.
      const next = peek();
      if (next && next.kind === 'op') {
        eat();
        const v = eat();
        if (!v || v.kind !== 'word') return { error: `Expected a value after ${t.value}${next.value}` };
        return { type: 'pred', key: t.value.toLowerCase(), op: next.value, value: v.value };
      }
      // Bare word — implicit name substring.
      return { type: 'pred', key: 'name', op: ':', value: t.value };
    }
    if (t.kind === 'op') return { error: `Unexpected operator ${t.value}` };
    if (t.kind === 'rparen') return { error: 'Unexpected )' };
    return { error: 'Unexpected token' };
  }

  const ast = parseOr();
  if ('error' in ast) return ast;
  if (pos < toks.length) return { error: 'Unexpected extra tokens' };
  return { ast };
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

const COLOR_LETTERS = new Set(['w', 'u', 'b', 'r', 'g']);

const COLOR_ALIASES: Record<string, string> = {
  white: 'w', blue: 'u', black: 'b', red: 'r', green: 'g',
  colorless: '', c: '',
  // Two-color guilds
  azorius: 'wu', dimir: 'ub', rakdos: 'br', gruul: 'rg', selesnya: 'wg',
  orzhov: 'wb', izzet: 'ur', golgari: 'bg', boros: 'wr', simic: 'ug',
  // Three-color shards/wedges
  bant: 'wug', esper: 'wub', grixis: 'ubr', jund: 'brg', naya: 'wrg',
  abzan: 'wbg', jeskai: 'wur', sultai: 'ubg', mardu: 'wbr', temur: 'urg',
  // Four-color
  yore: 'wubr', glint: 'ubrg', dune: 'wbrg', ink: 'wurg', witch: 'wubg',
  chaos: 'ubrg', aggression: 'wbrg', altruism: 'wurg', growth: 'wubg', artifice: 'wubr',
  // Five-color
  wubrg: 'wubrg', '5c': 'wubrg', fivecolor: 'wubrg', fivecolour: 'wubrg', rainbow: 'wubrg',
};

function parseColors(value: string): Set<string> {
  const v = value.toLowerCase().trim();
  if (v in COLOR_ALIASES) {
    const letters = COLOR_ALIASES[v];
    return new Set(letters.split(''));
  }
  const out = new Set<string>();
  for (const ch of v) {
    if (COLOR_LETTERS.has(ch)) out.add(ch);
  }
  return out;
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function compareColors(actual: Set<string>, query: Set<string>, op: Op): boolean {
  switch (op) {
    case ':':  // ":" is "contains all of" (subset), per Scryfall
      return isSubset(query, actual);
    case '=':
      return setEquals(actual, query);
    case '!=':
      return !setEquals(actual, query);
    case '<':
      return isSubset(actual, query) && !setEquals(actual, query);
    case '<=':
      return isSubset(actual, query);
    case '>':
      return isSubset(query, actual) && !setEquals(actual, query);
    case '>=':
      return isSubset(query, actual);
    default:
      return false;
  }
}

function compareNumeric(actual: number | undefined | null, query: number, op: Op): boolean {
  if (actual === undefined || actual === null || Number.isNaN(actual)) return false;
  switch (op) {
    case ':': case '=': return actual === query;
    case '!=': return actual !== query;
    case '<': return actual < query;
    case '<=': return actual <= query;
    case '>': return actual > query;
    case '>=': return actual >= query;
    default: return false;
  }
}

function compareString(actual: string | undefined | null, query: string, op: Op): boolean {
  if (actual === undefined || actual === null) return false;
  const a = actual.toLowerCase();
  const q = query.toLowerCase();
  switch (op) {
    case ':': return a.includes(q);
    case '=': return a === q;
    case '!=': return a !== q;
    case '<': return a < q;
    case '<=': return a <= q;
    case '>': return a > q;
    case '>=': return a >= q;
    default: return false;
  }
}

const RARITY_RANK: Record<string, number> = {
  common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4, bonus: 5,
};
function rarityCompare(actual: string | undefined, query: string, op: Op): boolean {
  if (!actual) return false;
  const a = actual.toLowerCase();
  const q = query.toLowerCase();
  if (op === ':' || op === '=') return a === q || a.startsWith(q);
  if (op === '!=') return a !== q && !a.startsWith(q);
  const ar = RARITY_RANK[a];
  const qr = RARITY_RANK[q];
  if (ar === undefined || qr === undefined) return false;
  switch (op) {
    case '<': return ar < qr;
    case '<=': return ar <= qr;
    case '>': return ar > qr;
    case '>=': return ar >= qr;
    default: return false;
  }
}

// Power/toughness/loyalty can be `*`, `1+*`, `X`, etc. Numeric ops work on
// the parseable subset; equality/substring works on anything.
function ptCompare(actual: string | undefined | null, query: string, op: Op): boolean {
  if (actual === undefined || actual === null) return false;
  if (op === ':' || op === '=') return actual.toLowerCase() === query.toLowerCase();
  if (op === '!=') return actual.toLowerCase() !== query.toLowerCase();
  const a = Number(actual);
  const q = Number(query);
  if (Number.isNaN(a) || Number.isNaN(q)) return false;
  return compareNumeric(a, q, op);
}

function yearOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^(\d{4})/.exec(iso);
  return m ? Number(m[1]) : null;
}

function defaultExample(card: PerCardRow): PerCardExample | null {
  return card.default ?? null;
}

// ---------------------------------------------------------------------------
// Keyword recognition (Scryfall-parity)
// ---------------------------------------------------------------------------
//
// Scryfall's `keyword:` predicate uses an internal whitelist of MTG
// keyword abilities and ability words. Their `keywords` field on a card
// is *also* curated against that list. Because Scryfall's bulk data
// occasionally omits keywords from the structured field on older
// printings, we widen the match to also scan the oracle text using a
// curated regex per known keyword.
//
// This list intentionally errs on the side of completeness; unmatched
// values still fall back to a substring scan of the keywords[] array
// and a word-boundary scan of oracle_text, which keeps niche / set-
// specific keywords (e.g. very-recent set mechanics) usable until the
// next refresh of this list.

const KEYWORD_ALIASES: Record<string, string> = {
  // Common shorthand / typos so users get Scryfall-like behaviour.
  fs: 'first strike',
  ds: 'double strike',
  dt: 'deathtouch',
  ll: 'lifelink',
  vig: 'vigilance',
  fly: 'flying',
  haste: 'haste',
  trample: 'trample',
  reach: 'reach',
  hexproof: 'hexproof',
  shroud: 'shroud',
  defender: 'defender',
  flash: 'flash',
  prowess: 'prowess',
  menace: 'menace',
  ward: 'ward',
};

// Each entry is the canonical lower-case name; the regex matches the
// keyword anywhere in oracle text, allowing for trailing reminder text,
// numeric costs, and end-of-line punctuation.
const KNOWN_KEYWORDS: { name: string; pattern: RegExp }[] = [
  // Evergreen (alphabetical)
  { name: 'deathtouch', pattern: /\bdeathtouch\b/i },
  { name: 'defender', pattern: /\bdefender\b/i },
  { name: 'double strike', pattern: /\bdouble strike\b/i },
  { name: 'enchant', pattern: /\benchant\b/i },
  { name: 'equip', pattern: /\bequip\b/i },
  { name: 'first strike', pattern: /\bfirst strike\b/i },
  { name: 'flash', pattern: /\bflash\b/i },
  { name: 'flying', pattern: /\bflying\b/i },
  { name: 'haste', pattern: /\bhaste\b/i },
  { name: 'hexproof', pattern: /\bhexproof\b/i },
  { name: 'indestructible', pattern: /\bindestructible\b/i },
  { name: 'lifelink', pattern: /\blifelink\b/i },
  { name: 'menace', pattern: /\bmenace\b/i },
  { name: 'protection', pattern: /\bprotection from\b/i },
  { name: 'prowess', pattern: /\bprowess\b/i },
  { name: 'reach', pattern: /\breach\b/i },
  { name: 'scry', pattern: /\bscry \d/i },
  { name: 'shroud', pattern: /\bshroud\b/i },
  { name: 'trample', pattern: /\btrample\b/i },
  { name: 'vigilance', pattern: /\bvigilance\b/i },
  { name: 'ward', pattern: /\bward\b/i },
  // Common deciduous & set-mechanic keywords
  { name: 'absorb', pattern: /\babsorb \d/i },
  { name: 'affinity', pattern: /\baffinity for\b/i },
  { name: 'afflict', pattern: /\bafflict \d/i },
  { name: 'aftermath', pattern: /\baftermath\b/i },
  { name: 'amplify', pattern: /\bamplify \d/i },
  { name: 'annihilator', pattern: /\bannihilator \d/i },
  { name: 'awaken', pattern: /\bawaken\b/i },
  { name: 'banding', pattern: /\bbanding\b/i },
  { name: 'bargain', pattern: /\bbargain\b/i },
  { name: 'bestow', pattern: /\bbestow\b/i },
  { name: 'blitz', pattern: /\bblitz\b/i },
  { name: 'bloodthirst', pattern: /\bbloodthirst \d/i },
  { name: 'bushido', pattern: /\bbushido \d/i },
  { name: 'buyback', pattern: /\bbuyback\b/i },
  { name: 'cascade', pattern: /\bcascade\b/i },
  { name: 'casualty', pattern: /\bcasualty \d/i },
  { name: 'champion', pattern: /\bchampion an?\b/i },
  { name: 'changeling', pattern: /\bchangeling\b/i },
  { name: 'channel', pattern: /\bchannel\b/i },
  { name: 'cipher', pattern: /\bcipher\b/i },
  { name: 'cleave', pattern: /\bcleave\b/i },
  { name: 'compleated', pattern: /\bcompleated\b/i },
  { name: 'conspire', pattern: /\bconspire\b/i },
  { name: 'convoke', pattern: /\bconvoke\b/i },
  { name: 'crew', pattern: /\bcrew \d/i },
  { name: 'cumulative upkeep', pattern: /\bcumulative upkeep\b/i },
  { name: 'cycling', pattern: /cycling\b/i },
  { name: 'dash', pattern: /\bdash\b/i },
  { name: 'daybound', pattern: /\bdaybound\b/i },
  { name: 'decayed', pattern: /\bdecayed\b/i },
  { name: 'delve', pattern: /\bdelve\b/i },
  { name: 'demonstrate', pattern: /\bdemonstrate\b/i },
  { name: 'devoid', pattern: /\bdevoid\b/i },
  { name: 'devour', pattern: /\bdevour \d/i },
  { name: 'disturb', pattern: /\bdisturb\b/i },
  { name: 'dredge', pattern: /\bdredge \d/i },
  { name: 'echo', pattern: /\becho\b/i },
  { name: 'embalm', pattern: /\bembalm\b/i },
  { name: 'emerge', pattern: /\bemerge\b/i },
  { name: 'encore', pattern: /\bencore\b/i },
  { name: 'enlist', pattern: /\benlist\b/i },
  { name: 'entwine', pattern: /\bentwine\b/i },
  { name: 'epic', pattern: /\bepic\b/i },
  { name: 'escalate', pattern: /\bescalate\b/i },
  { name: 'escape', pattern: /\bescape\b/i },
  { name: 'eternalize', pattern: /\beternalize\b/i },
  { name: 'evoke', pattern: /\bevoke\b/i },
  { name: 'evolve', pattern: /\bevolve\b/i },
  { name: 'exalted', pattern: /\bexalted\b/i },
  { name: 'exploit', pattern: /\bexploit\b/i },
  { name: 'explore', pattern: /\bexplore\b/i },
  { name: 'extort', pattern: /\bextort\b/i },
  { name: 'fabricate', pattern: /\bfabricate \d/i },
  { name: 'fading', pattern: /\bfading \d/i },
  { name: 'fateseal', pattern: /\bfateseal \d/i },
  { name: 'fear', pattern: /\bfear\b/i },
  { name: 'flanking', pattern: /\bflanking\b/i },
  { name: 'flashback', pattern: /\bflashback\b/i },
  { name: 'forecast', pattern: /\bforecast\b/i },
  { name: 'foretell', pattern: /\bforetell\b/i },
  { name: 'fortify', pattern: /\bfortify\b/i },
  { name: 'frenzy', pattern: /\bfrenzy \d/i },
  { name: 'fuse', pattern: /\bfuse\b/i },
  { name: 'graft', pattern: /\bgraft \d/i },
  { name: 'gravestorm', pattern: /\bgravestorm\b/i },
  { name: 'haunt', pattern: /\bhaunt\b/i },
  { name: 'hideaway', pattern: /\bhideaway\b/i },
  { name: 'horsemanship', pattern: /\bhorsemanship\b/i },
  { name: 'improvise', pattern: /\bimprovise\b/i },
  { name: 'infect', pattern: /\binfect\b/i },
  { name: 'ingest', pattern: /\bingest\b/i },
  { name: 'intimidate', pattern: /\bintimidate\b/i },
  { name: 'investigate', pattern: /\binvestigate\b/i },
  { name: 'jump-start', pattern: /\bjump-start\b/i },
  { name: 'kicker', pattern: /\bkicker\b/i },
  { name: 'landfall', pattern: /\blandfall\b/i },
  { name: 'landwalk', pattern: /\b(plains|island|swamp|mountain|forest)walk\b/i },
  { name: 'level up', pattern: /\blevel up\b/i },
  { name: 'living weapon', pattern: /\bliving weapon\b/i },
  { name: 'madness', pattern: /\bmadness\b/i },
  { name: 'megamorph', pattern: /\bmegamorph\b/i },
  { name: 'melee', pattern: /\bmelee\b/i },
  { name: 'mentor', pattern: /\bmentor\b/i },
  { name: 'metalcraft', pattern: /\bmetalcraft\b/i },
  { name: 'miracle', pattern: /\bmiracle\b/i },
  { name: 'modular', pattern: /\bmodular \d/i },
  { name: 'morbid', pattern: /\bmorbid\b/i },
  { name: 'morph', pattern: /\bmorph\b/i },
  { name: 'multikicker', pattern: /\bmultikicker\b/i },
  { name: 'mutate', pattern: /\bmutate\b/i },
  { name: 'myriad', pattern: /\bmyriad\b/i },
  { name: 'ninjutsu', pattern: /\bninjutsu\b/i },
  { name: 'offering', pattern: /\boffering\b/i },
  { name: 'outlast', pattern: /\boutlast\b/i },
  { name: 'overload', pattern: /\boverload\b/i },
  { name: 'partner', pattern: /\bpartner\b/i },
  { name: 'persist', pattern: /\bpersist\b/i },
  { name: 'phasing', pattern: /\bphasing\b/i },
  { name: 'poisonous', pattern: /\bpoisonous \d/i },
  { name: 'populate', pattern: /\bpopulate\b/i },
  { name: 'proliferate', pattern: /\bproliferate\b/i },
  { name: 'provoke', pattern: /\bprovoke\b/i },
  { name: 'prowl', pattern: /\bprowl\b/i },
  { name: 'rampage', pattern: /\brampage \d/i },
  { name: 'ravenous', pattern: /\bravenous\b/i },
  { name: 'rebound', pattern: /\brebound\b/i },
  { name: 'reconfigure', pattern: /\breconfigure\b/i },
  { name: 'recover', pattern: /\brecover\b/i },
  { name: 'reinforce', pattern: /\breinforce\b/i },
  { name: 'renown', pattern: /\brenown \d/i },
  { name: 'replicate', pattern: /\breplicate\b/i },
  { name: 'retrace', pattern: /\bretrace\b/i },
  { name: 'riot', pattern: /\briot\b/i },
  { name: 'ripple', pattern: /\bripple \d/i },
  { name: 'scavenge', pattern: /\bscavenge\b/i },
  { name: 'shadow', pattern: /\bshadow\b/i },
  { name: 'skulk', pattern: /\bskulk\b/i },
  { name: 'soulbond', pattern: /\bsoulbond\b/i },
  { name: 'soulshift', pattern: /\bsoulshift \d/i },
  { name: 'spectacle', pattern: /\bspectacle\b/i },
  { name: 'splice', pattern: /\bsplice onto\b/i },
  { name: 'split second', pattern: /\bsplit second\b/i },
  { name: 'storm', pattern: /\bstorm\b/i },
  { name: 'sunburst', pattern: /\bsunburst\b/i },
  { name: 'support', pattern: /\bsupport \d/i },
  { name: 'surge', pattern: /\bsurge\b/i },
  { name: 'suspend', pattern: /\bsuspend\b/i },
  { name: 'threshold', pattern: /\bthreshold\b/i },
  { name: 'totem armor', pattern: /\btotem armor\b/i },
  { name: 'training', pattern: /\btraining\b/i },
  { name: 'transfigure', pattern: /\btransfigure\b/i },
  { name: 'transmute', pattern: /\btransmute\b/i },
  { name: 'tribute', pattern: /\btribute \d/i },
  { name: 'undaunted', pattern: /\bundaunted\b/i },
  { name: 'undying', pattern: /\bundying\b/i },
  { name: 'unearth', pattern: /\bunearth\b/i },
  { name: 'unleash', pattern: /\bunleash\b/i },
  { name: 'vanishing', pattern: /\bvanishing\b/i },
  { name: 'wither', pattern: /\bwither\b/i },
];

const KNOWN_KEYWORD_NAMES = new Set(KNOWN_KEYWORDS.map((k) => k.name));

function hasKeyword(card: PerCardRow, query: string): boolean {
  const q = (KEYWORD_ALIASES[query] ?? query).toLowerCase().trim();
  if (!q) return false;
  // 1. Structured `keywords` field (case-insensitive). Scryfall's
  // canonical match is exact, but we accept prefix/substring so
  // `kw:fly` matches `Flying` and `kw:first` matches `First strike`.
  const kws = (card.keywords ?? []).map((x) => x.toLowerCase());
  if (kws.includes(q)) return true;
  if (kws.some((k) => k === q || k.startsWith(q + ' ') || k.includes(q))) return true;
  // 2. Known keyword whitelist matched against oracle text.
  const ot = (card.oracle_text ?? '').toLowerCase();
  if (!ot) return false;
  // Exact known keyword: scan oracle text for the canonical pattern.
  const known = KNOWN_KEYWORDS.find((k) => k.name === q);
  if (known) return known.pattern.test(ot);
  // Prefix / fuzzy match against the known list ("fly" -> "flying").
  const fuzzy = KNOWN_KEYWORDS.find((k) => k.name.startsWith(q));
  if (fuzzy) return fuzzy.pattern.test(ot);
  // 3. Last resort: word-boundary substring scan of oracle text. Lets
  // the user search for a niche keyword that hasn't been added to the
  // whitelist yet (e.g. brand-new set mechanics). Quote special regex
  // chars in `q` to avoid building an invalid pattern.
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${safe}\\b`, 'i');
  return pattern.test(ot);
}

// Exported only for tests.
export const _KEYWORDS_FOR_TEST = KNOWN_KEYWORD_NAMES;

// `is:` / `not:` flag handlers. Each returns true / false / null
// (null = "we don't have the data for this flag, treat as no-match").
function evalFlag(card: PerCardRow, flag: string): boolean {
  const f = flag.toLowerCase();
  const ex = defaultExample(card);
  const tl = (card.type_line ?? '').toLowerCase();
  const ot = (card.oracle_text ?? '').toLowerCase();
  switch (f) {
    case 'foil':       return !!ex?.foil;
    case 'nonfoil':    return !!ex?.nonfoil;
    case 'promo':      return !!ex?.promo;
    case 'fullart':    return !!ex?.full_art;
    case 'textless':   return !!ex?.textless;
    case 'digital':    return !!ex?.digital;
    case 'paper':      return ex?.digital === false;
    case 'tournament':
    case 'tournament-legal':
    case 'legal':      return ex?.is_tournament_legal !== false;
    case 'commander':
    case 'legendary':  return tl.includes('legendary');
    case 'creature':   return tl.includes('creature');
    case 'permanent':  return /artifact|creature|enchantment|land|planeswalker|battle/.test(tl);
    case 'historic':   return /legendary|artifact|saga/.test(tl);
    case 'vanilla':    return tl.includes('creature') && ot.trim() === '';
    case 'french-vanilla':
    case 'frenchvanilla': {
      if (!tl.includes('creature')) return false;
      // No oracle text other than keyword abilities (heuristic: comma-separated, no period).
      return ot === '' || (!ot.includes('.') && !ot.includes('\n'));
    }
    case 'bear':
      return tl.includes('creature') && Number(card.power) === 2 && Number(card.toughness) === 2 && card.cmc === 2;
    case 'split':      return (card.layout ?? '') === 'split';
    case 'dfc':
    case 'transform':  return ['transform', 'modal_dfc', 'double_faced_token', 'reversible_card'].includes(card.layout ?? '');
    case 'flip':       return (card.layout ?? '') === 'flip';
    case 'meld':       return (card.layout ?? '') === 'meld';
    case 'leveler':    return (card.layout ?? '') === 'leveler';
    case 'saga':       return tl.includes('saga');
    case 'planeswalker': return tl.includes('planeswalker');
    case 'token':      return (card.layout ?? '') === 'token';
    default:
      return false;
  }
}

function evalPred(card: PerCardRow, key: string, op: Op, value: string): boolean {
  const ex = defaultExample(card);
  switch (key) {
    case 'name':
      return compareString(card.name_normalized, value.toLowerCase(), op === '=' ? '=' : ':');

    case 't': case 'type':
      return compareString(card.type_line ?? '', value, op === '=' ? '=' : ':');

    case 'o': case 'oracle':
      return compareString(card.oracle_text ?? '', value, op === '=' ? '=' : ':');

    case 'c': case 'color': case 'colors':
      return compareColors(new Set((card.colors ?? []).map((x) => x.toLowerCase())), parseColors(value), op);

    case 'id': case 'identity': case 'ci':
      return compareColors(new Set((card.color_identity ?? []).map((x) => x.toLowerCase())), parseColors(value), op);

    case 'm': case 'mana':
      return compareString(card.mana_cost ?? '', value, op === '=' ? '=' : ':');

    case 'mv': case 'cmc':
      return compareNumeric(card.cmc, Number(value), op);

    case 'pow': case 'power':
      return ptCompare(card.power ?? null, value, op);

    case 'tou': case 'toughness':
      return ptCompare(card.toughness ?? null, value, op);

    case 'loy': case 'loyalty':
      return ptCompare(card.loyalty ?? null, value, op);

    case 'r': case 'rarity':
      return rarityCompare(card.rarity, value, op);

    case 'kw': case 'keyword': case 'keywords': {
      const v = value.toLowerCase().trim();
      if (!v) return false;
      const present = hasKeyword(card, v);
      return op === '!=' ? !present : present;
    }

    case 'layout':
      return compareString(card.layout ?? '', value, op === '=' ? '=' : ':');

    case 'produces': case 'prod':
      return compareColors(new Set((card.produced_mana ?? []).map((x) => x.toLowerCase())), parseColors(value), op);

    // ---- Printing-aesthetic predicates: evaluated against default ----

    case 'set': case 's': case 'e': case 'edition':
      return compareString(ex?.set ?? '', value, '=');

    case 'cn': case 'number':
      return compareString(ex?.collector_number ?? '', value, '=');

    case 'border':
      return compareString(ex?.border_color ?? '', value, '=');

    case 'frame':
      return compareString(ex?.frame ?? '', value, '=');

    case 'stamp':
      return compareString(ex?.security_stamp ?? '', value, '=');

    case 'lang':
      return compareString(ex?.lang ?? '', value, '=');

    case 'year': {
      const y = yearOf(ex?.released_at);
      return compareNumeric(y, Number(value), op);
    }

    case 'date':
      return compareString(ex?.released_at ?? '', value, op);

    case 'usd':
      return compareNumeric(ex?.price_usd ?? null, Number(value), op);

    case 'is':
      return evalFlag(card, value);

    case 'not':
      return !evalFlag(card, value);

    default:
      return false;
  }
}

export function evaluateQuery(ast: AstNode, card: PerCardRow): boolean {
  switch (ast.type) {
    case 'and':
      return ast.children.every((c) => evaluateQuery(c, card));
    case 'or':
      return ast.children.some((c) => evaluateQuery(c, card));
    case 'not':
      return !evaluateQuery(ast.child, card);
    case 'pred':
      return evalPred(card, ast.key, ast.op, ast.value);
  }
}

// ---------------------------------------------------------------------------
// Convenience: combined parse-and-build matcher.
// Returns either a matcher function (PerCardRow -> bool) or an error string.
// On any input that doesn't look like query syntax, falls back to the legacy
// substring-on-name behaviour for back-compat.
// ---------------------------------------------------------------------------

export type Matcher = (card: PerCardRow) => boolean;

export function buildMatcher(input: string): { match: Matcher } | { error: string; match: Matcher } {
  const trimmed = input.trim();
  if (!trimmed) return { match: () => true };
  if (!isQuerySyntax(trimmed)) {
    const q = trimmed.toLowerCase();
    return { match: (c) => c.name_normalized.includes(q) };
  }
  const r = parseQuery(trimmed);
  if ('error' in r) {
    // On parse error, fall back to substring so the user still sees
    // *something* relevant. The textbox UI surfaces the error message.
    const q = trimmed.toLowerCase();
    return { error: r.error, match: (c) => c.name_normalized.includes(q) };
  }
  const ast = r.ast;
  return { match: (c) => evaluateQuery(ast, c) };
}
