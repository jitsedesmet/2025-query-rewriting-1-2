import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import { describe, it } from 'vitest';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext, parseQuery } from '../lib/transformContext.js';

describe('algebraUtils.certainlyBoundVariables', () => {
  const c = <TransformContext> createPartialContext();

  function bound(query: string, extendBinds = false): string[] {
    const algebra = parseQuery(c, query);
    return [ ...algebraUtils.certainlyBoundVariables(algebra, { extendBinds }) ].sort();
  }

  it('reports the variables of a basic graph pattern as certainly bound', ({ expect }) => {
    expect(bound('SELECT * WHERE { ?s <ex://p> ?o }')).toEqual([ 'o', 's' ]);
  });

  it('intersects branches of a UNION', ({ expect }) => {
    expect(bound('SELECT * WHERE { { ?s <ex://p> ?o } UNION { ?s <ex://q> ?x } }')).toEqual([ 's' ]);
  });

  it('only keeps the required side of an OPTIONAL', ({ expect }) => {
    expect(bound('SELECT * WHERE { ?s <ex://p> ?o OPTIONAL { ?s <ex://q> ?x } }')).toEqual([ 'o', 's' ]);
  });

  it('respects projection', ({ expect }) => {
    expect(bound('SELECT ?s WHERE { ?s <ex://p> ?o }')).toEqual([ 's' ]);
  });

  it('treats VALUES variables as bound only when every row provides a value', ({ expect }) => {
    // Second row leaves ?o UNDEF, so only ?s is certainly bound.
    expect(bound('SELECT * WHERE { VALUES (?s ?o) { (<ex://a> <ex://b>) (<ex://c> UNDEF) } }')).toEqual([ 's' ]);
  });

  describe('extendBinds option', () => {
    const query = 'SELECT * WHERE { ?s <ex://p> ?o BIND(<ex://z> AS ?b) }';

    it('ignores BIND by default (safeVars behaviour)', ({ expect }) => {
      expect(bound(query)).toEqual([ 'o', 's' ]);
    });

    it('treats a constant BIND as certainly bound when enabled', ({ expect }) => {
      expect(bound(query, true)).toEqual([ 'b', 'o', 's' ]);
    });

    it('treats a variable-copy BIND as bound iff its source is bound', ({ expect }) => {
      expect(bound('SELECT * WHERE { ?s <ex://p> ?o BIND(?o AS ?b) }', true)).toEqual([ 'b', 'o', 's' ]);
    });

    it('does not treat a BIND over an unbound variable as certainly bound', ({ expect }) => {
      // ?u is not bound anywhere, so BIND(?u AS ?b) does not make ?b certainly bound.
      expect(bound('SELECT * WHERE { ?s <ex://p> ?o BIND(?u AS ?b) }', true)).toEqual([ 'o', 's' ]);
    });

    it('ignores a BIND of a non-term (possibly erroring) expression', ({ expect }) => {
      expect(bound('SELECT * WHERE { ?s <ex://p> ?o BIND(?o + 1 AS ?b) }', true)).toEqual([ 'o', 's' ]);
    });
  });

  describe('isVariableCertainlyBound', () => {
    it('answers by name and by variable term', ({ expect }) => {
      const algebra = parseQuery(c, 'SELECT * WHERE { ?s <ex://p> ?o }');
      expect(algebraUtils.isVariableCertainlyBound(algebra, 's')).toBe(true);
      expect(algebraUtils.isVariableCertainlyBound(algebra, c.DF.variable('o'))).toBe(true);
      expect(algebraUtils.isVariableCertainlyBound(algebra, 'missing')).toBe(false);
    });
  });
});
