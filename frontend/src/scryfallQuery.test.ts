import { describe, it, expect } from 'vitest';
import {
  buildMatcher,
  evaluateQuery,
  isQuerySyntax,
  parseQuery,
} from './scryfallQuery';
import type { PerCardRow } from './api';

// Minimal PerCardRow factory; all the gameplay/printing fields are
// optional, so callers only set what their test asserts on.
function card(partial: Partial<PerCardRow>): PerCardRow {
  return {
    name: partial.name ?? 'Test Card',
    name_normalized: partial.name_normalized ?? (partial.name ?? 'test card').toLowerCase(),
    qty: 1,
    oracle_id: 'oid-test',
    sections: ['mainboard'],
    resolved: true,
    available_aesthetics: [],
    examples: {},
    default: partial.default ?? null,
    ...partial,
  } as PerCardRow;
}

const bolt = card({
  name: 'Lightning Bolt',
  name_normalized: 'lightning bolt',
  type_line: 'Instant',
  oracle_text: 'Lightning Bolt deals 3 damage to any target.',
  mana_cost: '{R}',
  cmc: 1,
  colors: ['R'],
  color_identity: ['R'],
  rarity: 'common',
  keywords: [],
  layout: 'normal',
  default: {
    set: 'lea', set_name: 'Alpha', collector_number: '161',
    image_normal: null, image_art_crop: null, price_usd: 1500,
    released_at: '1993-08-05', frame: '1993', is_tournament_legal: true,
    border_color: 'black', full_art: false, textless: false,
    promo: false, digital: false, lang: 'en',
    nonfoil: true, foil: false,
  },
});

const goyf = card({
  name: 'Tarmogoyf',
  name_normalized: 'tarmogoyf',
  type_line: 'Creature — Lhurgoyf',
  oracle_text: "Tarmogoyf's power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus 1.",
  mana_cost: '{1}{G}',
  cmc: 2,
  colors: ['G'],
  color_identity: ['G'],
  power: '*',
  toughness: '1+*',
  rarity: 'mythic',
  keywords: [],
  layout: 'normal',
  default: {
    set: 'fut', set_name: 'Future Sight', collector_number: '153',
    image_normal: null, image_art_crop: null, price_usd: 60,
    released_at: '2007-05-04', frame: 'future', is_tournament_legal: true,
    border_color: 'black', full_art: false, textless: false,
    promo: false, digital: false, lang: 'en',
    nonfoil: true, foil: true,
  },
});

const grizzly = card({
  name: 'Grizzly Bears',
  name_normalized: 'grizzly bears',
  type_line: 'Creature — Bear',
  oracle_text: '',
  mana_cost: '{1}{G}',
  cmc: 2,
  colors: ['G'],
  color_identity: ['G'],
  power: '2',
  toughness: '2',
  rarity: 'common',
  keywords: [],
  layout: 'normal',
  default: {
    set: 'lea', set_name: 'Alpha', collector_number: '203',
    image_normal: null, image_art_crop: null, price_usd: 5,
    released_at: '1993-08-05', frame: '1993', is_tournament_legal: true,
    border_color: 'black', full_art: false, textless: false,
    promo: true, digital: false, lang: 'en',
    nonfoil: true, foil: false,
  },
});

describe('isQuerySyntax', () => {
  it('classifies plain words as substring', () => {
    expect(isQuerySyntax('bolt')).toBe(false);
    expect(isQuerySyntax('lightning bolt')).toBe(false);
  });
  it('detects operator-bearing input as query', () => {
    expect(isQuerySyntax('t:creature')).toBe(true);
    expect(isQuerySyntax('mv>=3')).toBe(true);
    expect(isQuerySyntax('-bolt')).toBe(true);
    expect(isQuerySyntax('foo OR bar')).toBe(true);
    expect(isQuerySyntax('"draw a card"')).toBe(true);
  });
});

describe('parseQuery', () => {
  it('parses a bare key:value', () => {
    const r = parseQuery('t:creature');
    expect(r).toEqual({ ast: { type: 'pred', key: 't', op: ':', value: 'creature' } });
  });
  it('parses AND as default conjunction', () => {
    const r = parseQuery('t:creature mv>=3');
    if ('error' in r) throw new Error(r.error);
    expect(r.ast.type).toBe('and');
  });
  it('parses OR with higher level than AND', () => {
    const r = parseQuery('t:creature OR t:instant');
    if ('error' in r) throw new Error(r.error);
    expect(r.ast.type).toBe('or');
  });
  it('parses negation', () => {
    const r = parseQuery('-t:land');
    if ('error' in r) throw new Error(r.error);
    expect(r.ast.type).toBe('not');
  });
  it('errors on unterminated quote', () => {
    const r = parseQuery('o:"draw');
    expect('error' in r).toBe(true);
  });
});

describe('evaluateQuery', () => {
  const ev = (q: string, c: PerCardRow) => {
    const r = parseQuery(q);
    if ('error' in r) throw new Error(`parse: ${r.error}`);
    return evaluateQuery(r.ast, c);
  };

  it('matches type', () => {
    expect(ev('t:creature', goyf)).toBe(true);
    expect(ev('t:creature', bolt)).toBe(false);
    expect(ev('t:instant', bolt)).toBe(true);
  });
  it('matches oracle substring', () => {
    expect(ev('o:damage', bolt)).toBe(true);
    expect(ev('o:flying', bolt)).toBe(false);
  });
  it('matches color subset (`c:`)', () => {
    expect(ev('c:r', bolt)).toBe(true);
    expect(ev('c:g', goyf)).toBe(true);
    expect(ev('c:r', goyf)).toBe(false);
  });
  it('matches color exactly (`c=`)', () => {
    expect(ev('c=r', bolt)).toBe(true);
    expect(ev('c=rg', bolt)).toBe(false);
  });
  it('matches mana value comparisons', () => {
    expect(ev('mv:1', bolt)).toBe(true);
    expect(ev('mv>=2', goyf)).toBe(true);
    expect(ev('mv<2', bolt)).toBe(true);
    expect(ev('mv<2', goyf)).toBe(false);
  });
  it('matches rarity ordering', () => {
    expect(ev('r:common', bolt)).toBe(true);
    expect(ev('r>rare', goyf)).toBe(true);
    expect(ev('r>rare', bolt)).toBe(false);
  });
  it('matches set on default printing', () => {
    expect(ev('set:lea', bolt)).toBe(true);
    expect(ev('set:fut', goyf)).toBe(true);
    expect(ev('set:lea', goyf)).toBe(false);
  });
  it('matches frame on default printing', () => {
    expect(ev('frame:future', goyf)).toBe(true);
    expect(ev('frame:1993', bolt)).toBe(true);
  });
  it('handles AND of multiple predicates', () => {
    expect(ev('t:creature mv:2 c:g', goyf)).toBe(true);
    expect(ev('t:creature mv:2 c:g', bolt)).toBe(false);
  });
  it('handles OR', () => {
    expect(ev('t:instant OR t:creature', bolt)).toBe(true);
    expect(ev('t:instant OR t:creature', goyf)).toBe(true);
    expect(ev('t:enchantment OR t:land', goyf)).toBe(false);
  });
  it('handles negation', () => {
    expect(ev('-t:land', bolt)).toBe(true);
    expect(ev('-t:instant', bolt)).toBe(false);
  });
  it('matches is:bear', () => {
    expect(ev('is:bear', grizzly)).toBe(true);
    expect(ev('is:bear', goyf)).toBe(false);
  });
  it('matches is:promo on default', () => {
    expect(ev('is:promo', grizzly)).toBe(true);
    expect(ev('is:promo', bolt)).toBe(false);
  });
  it('matches year comparisons', () => {
    expect(ev('year>=2000', goyf)).toBe(true);
    expect(ev('year<2000', bolt)).toBe(true);
  });
  it('matches usd comparisons', () => {
    expect(ev('usd>100', bolt)).toBe(true);
    expect(ev('usd<10', grizzly)).toBe(true);
  });

  // ---- keyword: parity ----
  describe('kw / keyword', () => {
    const flyer = card({
      name: 'Birds of Paradise',
      type_line: 'Creature — Bird',
      oracle_text: 'Flying\n{T}: Add one mana of any color.',
      keywords: ['Flying'],
    });
    const trampler = card({
      name: 'Force of Nature',
      type_line: 'Creature — Elemental',
      oracle_text: 'Trample\nAt the beginning of your upkeep, ...',
      keywords: [],
    });
    const cycler = card({
      name: 'Eternal Dragon',
      type_line: 'Creature — Dragon',
      oracle_text: 'Flying\nPlainscycling {2} ({2}, Discard this card: Search your library for a Plains card, reveal it, and put it into your hand. Then shuffle.)',
      keywords: ['Flying'],
    });
    const fsKnight = card({
      name: 'White Knight',
      type_line: 'Creature — Human Knight',
      oracle_text: 'First strike\nProtection from black',
      keywords: ['First strike', 'Protection from black'],
    });

    it('matches structured keywords case-insensitively', () => {
      expect(ev('kw:flying', flyer)).toBe(true);
      expect(ev('kw:Flying', flyer)).toBe(true);
      expect(ev('keyword:flying', flyer)).toBe(true);
    });
    it('matches keyword by oracle text when keywords[] is empty', () => {
      expect(ev('kw:trample', trampler)).toBe(true);
      expect(ev('kw:flying', trampler)).toBe(false);
    });
    it('matches set-mechanic keywords like cycling', () => {
      expect(ev('kw:cycling', cycler)).toBe(true);
    });
    it('matches multi-word keywords', () => {
      expect(ev('kw:"first strike"', fsKnight)).toBe(true);
      expect(ev('keyword:"first strike"', fsKnight)).toBe(true);
    });
    it('matches via prefix shorthand', () => {
      expect(ev('kw:fly', flyer)).toBe(true);
    });
    it('matches via alias', () => {
      expect(ev('kw:fs', fsKnight)).toBe(true);
    });
    it('respects negation', () => {
      expect(ev('-kw:flying', trampler)).toBe(true);
      expect(ev('-kw:flying', flyer)).toBe(false);
    });
    it('returns false for cards with no keywords', () => {
      expect(ev('kw:flying', bolt)).toBe(false);
    });
  });
});

describe('buildMatcher', () => {
  it('back-compat: bare word matches name substring', () => {
    const m = buildMatcher('bolt');
    if ('error' in m) throw new Error(m.error);
    expect(m.match(bolt)).toBe(true);
    expect(m.match(goyf)).toBe(false);
  });
  it('parse error falls back to substring + reports error', () => {
    const m = buildMatcher('t:creature mv>=');
    expect('error' in m).toBe(true);
  });
  it('empty input matches everything', () => {
    const m = buildMatcher('');
    if ('error' in m) throw new Error(m.error);
    expect(m.match(bolt)).toBe(true);
    expect(m.match(goyf)).toBe(true);
  });
});
