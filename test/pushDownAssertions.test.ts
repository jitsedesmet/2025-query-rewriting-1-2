import { QueryEngine } from '@comunica/query-sparql-file';
import { toAst } from '@traqula/algebra-sparql-1-2';
import type { Algebra as AlgebraTypes } from '@traqula/algebra-transformations-1-2';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import * as arrayifyStreamNS from 'arrayify-stream';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { pushDownAssertions } from '../lib/transformations/pushDownAssertions.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext, parseQuery } from '../lib/transformContext.js';
import type { CPMeta } from '../lib/utils/certainlyBoundVars.js';
import { withCpVars } from '../lib/utils/certainlyBoundVars.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

const prefixes = `PREFIX : <ex://>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
`;

describe('pushDownAssertions', () => {
  // PushDownAssertions only uses AF / DF / astTransformer / generator from the context, never the
  // mapping, so a mapping-less partial context is sufficient here.
  const c = <TransformContext> createPartialContext();

  function transform(query: string): string {
    const transformed = pushDownAssertions(c, parseQuery(c, prefixes + query));
    return c.generator.generate(toAst(transformed)).trim();
  }

  /** Runs the FILTER(FALSE) normalisation of the design's normalisation pass on top of the pushdown. */
  function transformAndNormalise(query: string): string {
    const pushed = pushDownAssertions(c, parseQuery(c, prefixes + query));
    return c.generator.generate(toAst(transformFilterFalse(c, pushed))).trim();
  }

  function expectTransform(expect: typeof Expect, query: string, expected: string): void {
    expect(transform(query)).toEqual(expected.trim());
  }

  describe('base cases', () => {
    it('substitutes the term into a BGP and re-binds the variable', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y . ?y :q ?z FILTER(sameTerm(?x, :c)) }',
        `SELECT ( <ex://c> AS ?x ) ?y ?z WHERE {
  <ex://c> <ex://p> ?y .
  ?y <ex://q> ?z .
}`,
      );
    });

    it('empties a BGP that would need a literal in the subject position', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, "lit")) }',
        `SELECT ?x ?y WHERE {
  ?x <ex://p> ?y .
  FILTER ( FALSE )
}`,
      );
    });

    it('substitutes the exact term, keeping a non-canonical lexical form (sameTerm, not =)', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?x FILTER(sameTerm(?x, "01"^^xsd:integer)) }',
        `SELECT ?s ( "01"^^<http://www.w3.org/2001/XMLSchema#integer> AS ?x ) WHERE {
  ?s <ex://p> "01"^^<http://www.w3.org/2001/XMLSchema#integer> .
}`,
      );
    });

    it('substitutes into a property path', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :step* ?y FILTER(sameTerm(?x, :a)) }',
        `SELECT ( <ex://a> AS ?x ) ?y WHERE {
  <ex://a> (<ex://step>*) ?y .
}`,
      );
    });

    it('drops the VALUES rows that contradict the assertion, UNDEF included', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { VALUES (?x ?y) { (:c :a) (UNDEF :b) (:d :e) } FILTER(sameTerm(?x, :c)) }',
        `SELECT ( <ex://c> AS ?x ) ?y WHERE {
  VALUES ?y {
    <ex://a>
  }
}`,
      );
    });

    it('drops the asserted column from the surviving VALUES rows, not just from its variables', ({ expect }) => {
      // The generator only prints the declared variables, so a row still carrying the asserted column
      // reads correctly while the algebra is malformed. Check the rows themselves.
      const pushed = pushDownAssertions(c, parseQuery(
        c,
        `${prefixes}SELECT * WHERE { VALUES (?x ?y) { (:c :a) (:c :b) (:d :e) } FILTER(sameTerm(?x, :c)) }`,
      ));
      const values: AlgebraTypes.Values[] = [];
      algebraUtils.visitOperation(pushed, { [Algebra.Types.VALUES]: { visitor: (op) => {
        values.push(op);
      } }});
      expect(values).toHaveLength(1);
      expect(values[0].variables.map(variable => variable.value)).toEqual([ 'y' ]);
      expect(values[0].bindings.map(binding => Object.keys(binding))).toEqual([[ 'y' ], [ 'y' ]]);
    });

    it('replaces a VALUES the assertions leave one empty row of by the empty BGP', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { VALUES (?x) { (:c) (:d) } FILTER(sameTerm(?x, :c)) }',
        `SELECT ( <ex://c> AS ?x ) WHERE {
}`,
      );
    });

    it('keeps a VALUES the assertions leave several empty rows of, one solution per row', ({ expect }) => {
      // `VALUES () { () () }` is two empty solution mappings, which the empty BGP cannot express.
      expectTransform(
        expect,
        'SELECT * WHERE { VALUES (?x) { (:c) (:c) (:d) } FILTER(sameTerm(?x, :c)) }',
        `SELECT ( <ex://c> AS ?x ) WHERE {
  VALUES( ){
    ( )
    ( )
  }
}`,
      );
    });

    it('empties a VALUES no row of which satisfies the assertion', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { VALUES (?x ?y) { (:d :e) } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?x ?y WHERE {
  VALUES( ?x ?y ){
    ( <ex://d> <ex://e> )
  }
  FILTER ( FALSE )
}`,
      );
    });
  });

  describe('structural rules', () => {
    it('sends the assertion into both UNION branches, emptying the one that cannot bind it', ({ expect }) => {
      // The worked example of the design: `?x ∉ cVars(A₁)` fails the first disjunct of L, but
      // `?x ∉ pVars(A₂)` holds, so the assertion gets below the join and (FUPush) reaches the branches.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { { ?x :p ?y } UNION { ?z :q ?w } }
          { SELECT ?a ?b WHERE { ?a :r ?b } }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?a ?b ?w ?x ?y ?z WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  UNION {
    ?z <ex://q> ?w .
    FILTER ( FALSE )
  }
  {
    SELECT ?a ?b WHERE {
      ?a <ex://r> ?b .
    }
  }
}`,
      );
    });

    it('normalises the emptied UNION branch away', ({ expect }) => {
      expect(transformAndNormalise(`SELECT * WHERE {
        { { ?x :p ?y } UNION { ?z :q ?w } }
        { SELECT ?a ?b WHERE { ?a :r ?b } }
        FILTER(sameTerm(?x, :c))
      }`)).toEqual(`SELECT ?a ?b ?w ?x ?y ?z WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  {
    SELECT ?a ?b WHERE {
      ?a <ex://r> ?b .
    }
  }
}`);
    });

    it('replicates the assertion into both sides of a join that both bind it certainly', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?x :p ?y } { ?x :q ?z } FILTER(sameTerm(?x, :c)) }',
        `SELECT ( <ex://c> AS ?x ) ?y ?z WHERE {
  <ex://c> <ex://p> ?y .
  <ex://c> <ex://q> ?z .
}`,
      );
    });

    it('turns an OPTIONAL over an optional-only variable into a plain join', ({ expect }) => {
      const result = transform('SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?x } FILTER(sameTerm(?x, :c)) }');
      expect(result).toEqual(`SELECT ?o ?s ?x WHERE {
  ?s <ex://p> ?o .
  {
    ?s <ex://q> <ex://c> .
    BIND( <ex://c> AS ?x )
  }
}`);
      expect(result).not.toContain('OPTIONAL');
    });

    it('keeps the MINUS and prunes its right hand side only weakly', ({ expect }) => {
      // The right hand side may not take the strong assertion: `∖` is anti-monotone in it, so the row
      // binding no ?x at all has to stay, and the whole MINUS has to stay.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?x :p ?y
          MINUS { VALUES (?x ?y) { (:c :a) (UNDEF :b) (:d :e) } }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?x ?y WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  MINUS {
    VALUES( ?x ?y ){
      ( <ex://c> <ex://a> )
      ( UNDEF <ex://b> )
    }
  }
}`,
      );
    });

    it('leaves a MINUS right hand side that cannot bind the variable alone', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y MINUS { ?z :q ?y } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?x ?y WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  MINUS {
    ?z <ex://q> ?y .
  }
}`,
      );
    });

    it('collapses the weak assertion per branch inside a MINUS right hand side', ({ expect }) => {
      // W becomes the strong assertion in the branch that certainly binds ?x, and `true` - dropped,
      // never empty - in the branch that cannot bind it at all.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?x :p ?y
          MINUS { { ?x :q ?y } UNION { ?z :r ?y } }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?x ?y WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  MINUS {
    {
      <ex://c> <ex://q> ?y .
      BIND( <ex://c> AS ?x )
    }
    UNION {
      ?z <ex://r> ?y .
    }
  }
}`,
      );
    });

    it('keeps the weak assertion above an OPTIONAL inside a MINUS right hand side', ({ expect }) => {
      // ?x is possible but not certain there, and pushing W into the right argument of a left join is
      // unsound, so it stays on top of it in its weak form.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?x :p ?y
          MINUS { ?y :s ?w OPTIONAL { ?y :q ?x } }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?x ?y WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  MINUS {
    {
      ?y <ex://s> ?w .
      OPTIONAL {
        ?y <ex://q> ?x .
      }
      FILTER ( ( ! BOUND( ?x ) || SAMETERM( ?x , <ex://c> ) ) )
    }
  }
}`,
      );
    });

    it('is transparent for GRAPH, and selects the single graph when asserting its name', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?x :p ?y } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?g ( <ex://c> AS ?x ) ?y WHERE {
  GRAPH ?g {
    <ex://c> <ex://p> ?y .
  }
}`,
      );
      expectTransform(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?x :p ?y } FILTER(sameTerm(?g, :g1)) }',
        `SELECT ( <ex://g1> AS ?g ) ?x ?y WHERE {
  GRAPH <ex://g1> {
    ?x <ex://p> ?y .
  }
}`,
      );
    });

    it('empties a GRAPH whose name is asserted to be a literal', ({ expect }) => {
      // No graph is named by a literal, so the pattern - which carries the graph name in quad mode -
      // can never match.
      expectTransform(
        expect,
        'SELECT * WHERE { GRAPH ?g { ?x :p ?y } FILTER(sameTerm(?g, "lit")) }',
        `SELECT ?g ?x ?y WHERE {
  GRAPH ?g {
    {
      ?x <ex://p> ?y .
      FILTER ( FALSE )
    }
  }
}`,
      );
    });

    it('stops above a SLICE', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?x ?y WHERE { ?x :p ?y } LIMIT 3 } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?x ?y WHERE {
  {
    SELECT ?x ?y WHERE {
      ?x <ex://p> ?y .
    }
    LIMIT 3
  }
  FILTER ( SAMETERM( ?x , <ex://c> ) )
}`,
      );
    });

    it('stops above a SERVICE', ({ expect }) => {
      // Sound to push, but it has to be a replication rather than a move because of SILENT, so this
      // pass treats it as a barrier.
      expectTransform(
        expect,
        'SELECT * WHERE { SERVICE <ex://endpoint> { ?x :p ?y } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?x ?y WHERE {
  SERVICE <ex://endpoint> {
    ?x <ex://p> ?y .
  }
  FILTER ( SAMETERM( ?x , <ex://c> ) )
}`,
      );
    });

    it('keeps pushing the assertions it finds below a barrier', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT * WHERE {
          { SELECT ?x ?y WHERE { ?x :p ?y FILTER(sameTerm(?y, :d)) } LIMIT 3 }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?x ?y WHERE {
  {
    SELECT ?x ( <ex://d> AS ?y ) WHERE {
      ?x <ex://p> <ex://d> .
    }
    LIMIT 3
  }
  FILTER ( SAMETERM( ?x , <ex://c> ) )
}`,
      );
    });

    it('pushes below a GROUP BY for a grouping key', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT ?x (COUNT(?y) AS ?count) WHERE { ?x :p ?y }
         GROUP BY ?x HAVING(sameTerm(?x, :c))`,
        `SELECT ?x ( COUNT( ?y ) AS ?count ) WHERE {
  <ex://c> <ex://p> ?y .
  BIND( <ex://c> AS ?x )
}
GROUP BY ?x`,
      );
    });

    it('stops above a GROUP BY for a variable that is not a grouping key', ({ expect }) => {
      // Filtering an aggregate before the aggregation would change it. Not reachable from query text -
      // a HAVING over an aggregate references the internal variable the translation coins for it - so
      // the plan is built directly here.
      const { AF, DF } = c;
      const group = AF.createGroup(
        AF.createBgp([ AF.createPattern(DF.variable('x'), DF.namedNode('ex://p'), DF.variable('y')) ]),
        [ DF.variable('x') ],
        [ AF.createBoundAggregate(
          DF.variable('total'),
          'count',
          AF.createTermExpression(DF.variable('y')),
          false,
        ) ],
      );
      const pushed = pushDownAssertions(c, AF.createFilter(group, AF.createOperatorExpression('sameterm', [
        AF.createTermExpression(DF.variable('total')),
        AF.createTermExpression(DF.namedNode('ex://c')),
      ])));

      expect(pushed.type).toBe('filter');
      expect((pushed).input.type).toBe('group');
      expect((<AlgebraTypes.Group> (pushed).input).input.type).toBe('bgp');
    });
  });

  describe('condition handling', () => {
    it('propagates the assertion through a renaming BIND', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?x ?y WHERE { ?z :p ?y BIND(?z AS ?x) } } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?x ?y WHERE {
  SELECT ( <ex://c> AS ?x ) ?y WHERE {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?z )
  }
}`,
      );
    });

    it('turns the assertion on a fallible BIND target into a condition on its expression', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?x ?a WHERE { ?a :p ?b BIND(?a + ?b AS ?x) } } FILTER(sameTerm(?x, :c)) }',
        `SELECT ?a ?x WHERE {
  SELECT ( <ex://c> AS ?x ) ?a WHERE {
    ?a <ex://p> ?b .
    FILTER ( SAMETERM( ( ?a + ?b ) , <ex://c> ) )
  }
}`,
      );
    });

    it('propagates an assertion between two variables asserted equal', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c) && sameTerm(?y, ?x)) }',
        `SELECT ( <ex://c> AS ?x ) ( <ex://c> AS ?y ) WHERE {
  <ex://c> <ex://p> <ex://c> .
}`,
      );
    });

    it('folds bound(?x) of an asserted variable to true instead of substituting it', ({ expect }) => {
      // Substituting would produce the ungrammatical `BOUND(<ex://c>)`.
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c) && (BOUND(?x) && ?y > 2)) }',
        `SELECT ?x ?y WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  FILTER ( ( ?y > "2"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('collapses the !bound(?x) negation idiom to the empty result', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?s :p ?o OPTIONAL { ?s :q ?x } }
          FILTER(sameTerm(?x, :c) && !BOUND(?x))
        }`,
        `SELECT ?o ?s ?x WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    ?s <ex://q> ?x .
  }
  FILTER ( FALSE )
}`,
      );
    });

    it('empties a filter asserting one variable to be two distinct terms', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c) && sameTerm(?x, :d)) }',
        `SELECT ?x ?y WHERE {
  ?x <ex://p> ?y .
  FILTER ( FALSE )
}`,
      );
    });

    it('substitutes into the pattern of an EXISTS', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c) && EXISTS { ?x :q ?w }) }',
        `SELECT ?x ?y WHERE {
  {
    <ex://c> <ex://p> ?y .
    BIND( <ex://c> AS ?x )
  }
  FILTER ( EXISTS {
    <ex://c> <ex://q> ?w .
  }
  )
}`,
      );
    });

    it('re-serialises to valid SPARQL, never emitting BOUND of a term', ({ expect }) => {
      const result = transform(`SELECT * WHERE {
        ?x :p ?y
        OPTIONAL { ?y :q ?z }
        FILTER(sameTerm(?x, :c) && (BOUND(?z) || BOUND(?x)) && EXISTS { ?w :r ?x FILTER(BOUND(?x)) })
      }`);
      expect(result).not.toContain('BOUND( <');
      // A round trip over the whole plan is the real check: the generated query has to parse again.
      expect(() => parseQuery(c, result)).not.toThrow();
    });
  });

  describe('equality against an IRI', () => {
    // `=` raises a type error only when both of its arguments are literals, so against an IRI it is
    // term identity - the very function `sameTerm` is - and it may travel as an assertion.
    it('is an assertion, and reaches the pattern like sameTerm does', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(?x = :c) }',
        `SELECT ( <ex://c> AS ?x ) ?y WHERE {
  <ex://c> <ex://p> ?y .
}`,
      );
    });

    it('reads the IRI on either side', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(:c = ?x) }',
        `SELECT ( <ex://c> AS ?x ) ?y WHERE {
  <ex://c> <ex://p> ?y .
}`,
      );
    });

    it('joins the conjunction, and contradicts it like any other assertion', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(?x = :c && sameTerm(?x, :d)) }',
        `SELECT ?x ?y WHERE {
  ?x <ex://p> ?y .
  FILTER ( FALSE )
}`,
      );
    });

    it('decides two IRIs against each other, false included', ({ expect }) => {
      // The general `=` may only fold to true: comparing literals of unsupported datatypes raises an
      // error, and an error is not false everywhere. Between IRIs it may fold either way.
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(:c = :d) }',
        `SELECT ?x ?y WHERE {
  ?x <ex://p> ?y .
  FILTER ( FALSE )
}`,
      );
    });

    it('leaves an equality against a literal alone', ({ expect }) => {
      // The case the two functions genuinely differ in, so it stays a value comparison on top.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :value ?o FILTER(?o = "01"^^xsd:integer) }',
        `SELECT ?o ?s WHERE {
  ?s <ex://value> ?o .
  FILTER ( ( ?o = "01"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });
  });

  describe('the conjunction that travels', () => {
    it('substitutes a conjunction of assertions in one go', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y . ?y :q ?z FILTER(sameTerm(?x, :c) && sameTerm(?y, :d)) }',
        `SELECT ( <ex://c> AS ?x ) ( <ex://d> AS ?y ) ?z WHERE {
  <ex://c> <ex://p> <ex://d> .
  <ex://d> <ex://q> ?z .
}`,
      );
    });

    it('absorbs the assertions of a filter it passes', ({ expect }) => {
      // The second filter is met on the way down, and its assertion joins the conjunction rather than
      // starting a traversal of its own.
      expectTransform(
        expect,
        'SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c)) FILTER(sameTerm(?y, :d)) }',
        `SELECT ( <ex://c> AS ?x ) ( <ex://d> AS ?y ) WHERE {
  <ex://c> <ex://p> <ex://d> .
}`,
      );
    });

    it('empties the plan where a passed assertion contradicts the conjunction', ({ expect }) => {
      // ?x cannot be both, so everything below is skipped rather than rewritten - the inner filter is
      // left exactly as it was.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :d)) } }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?x ?y WHERE {
  SELECT ?x ?y WHERE {
    {
      ?x <ex://p> ?y .
      FILTER ( SAMETERM( ?x , <ex://d> ) )
    }
    FILTER ( FALSE )
  }
}`,
      );
    });
  });

  describe('metadata', () => {
    /** Every `metadata` in `value`, of the operations that carry one. */
    function metadataIn(value: unknown, found: CPMeta[] = []): CPMeta[] {
      if (value === null || typeof value !== 'object') {
        return found;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          metadataIn(item, found);
        }
        return found;
      }
      const meta = (<{ metadata?: CPMeta }> value).metadata;
      if (meta?.pVars !== undefined) {
        found.push(meta);
      }
      for (const [ key, child ] of Object.entries(value)) {
        if (key !== 'metadata') {
          metadataIn(child, found);
        }
      }
      return found;
    }

    const query = `${prefixes}SELECT * WHERE {
      { { ?x :p ?y } UNION { ?z :q ?w } }
      OPTIONAL { ?x :s ?t }
      FILTER(sameTerm(?x, :c))
    }`;

    it('starts from the plan it is given, not from what an earlier pass cached on it', ({ expect }) => {
      const algebra = parseQuery(c, `${prefixes}SELECT * WHERE { ?x :p ?y FILTER(sameTerm(?x, :c)) }`);
      // A cache claiming this BGP binds nothing would make the (FBndII) check empty the whole plan.
      algebraUtils.visitOperation(algebra, { [Algebra.Types.BGP]: { visitor: (bgp) => {
        (<{ metadata: CPMeta }> <unknown> bgp).metadata = { cVars: new Set(), pVars: new Set() };
      } }});

      expect(c.generator.generate(toAst(pushDownAssertions(c, algebra))).trim())
        .toEqual(`SELECT ( <ex://c> AS ?x ) ?y WHERE {
  <ex://c> <ex://p> ?y .
}`);
    });

    it('leaves the sets it computed readable on the result', ({ expect }) => {
      const cached = metadataIn(pushDownAssertions(c, parseQuery(c, query)));
      expect(cached.length).toBeGreaterThan(0);
      // A `Set` that a traversal not knowing about `metadata` shallow copied keeps its prototype but
      // loses its contents, and throws when read. Reading them back is what tells the two apart.
      for (const { cVars, pVars } of cached) {
        expect([ ...cVars ].every(name => pVars.has(name))).toBe(true);
      }
      expect(cached.some(({ pVars }) => pVars.size > 0)).toBe(true);
    });

    it('describes the rewritten plan, not the one it started from', ({ expect }) => {
      const { cVars, pVars } = withCpVars(pushDownAssertions(c, parseQuery(c, query))).metadata;
      // The rewrite preserves the in-scope variables exactly, and the assertion makes ?x certain.
      expect([ ...pVars ].sort()).toEqual([ 't', 'w', 'x', 'y', 'z' ]);
      expect([ ...cVars ].sort()).toEqual([ 'x' ]);
    });
  });

  describe('soundness guards', () => {
    it('does not push into a join operand whose BIND may leave the variable unbound', ({ expect }) => {
      // ?x is not certainly bound in the left operand (`?a / ?b` errors when ?b is 0), and it is
      // possible in the right one, so L fails for the left: only the right operand may take it.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { SELECT ?x ?a ?b WHERE { ?a :p ?b BIND(?a / ?b AS ?x) } }
          { SELECT ?x ?d WHERE { ?x :q ?d } }
          FILTER(sameTerm(?x, :c))
        }`,
        `SELECT ?a ?b ?d ?x WHERE {
  {
    SELECT ( ( ?a / ?b ) AS ?x ) ?a ?b WHERE {
      ?a <ex://p> ?b .
    }
  }
  {
    SELECT ( <ex://c> AS ?x ) ?d WHERE {
      <ex://c> <ex://q> ?d .
    }
  }
}`,
      );
    });

    it('keeps the projected variables of a plan a branch of which becomes empty', ({ expect }) => {
      const query = `${prefixes}SELECT * WHERE {
        { { ?x :p ?y } UNION { ?z :q ?w } }
        { SELECT ?a ?b WHERE { ?a :r ?b } }
        FILTER(sameTerm(?x, :c))
      }`;
      const algebra = <AlgebraTypes.Project> parseQuery(c, query);
      const pushed = pushDownAssertions(c, algebra);
      expect(pushed.variables.map(variable => variable.value))
        .toEqual(algebra.variables.map(variable => variable.value));
    });

    it('leaves the input tree untouched', ({ expect }) => {
      const algebra = parseQuery(c, `${prefixes}SELECT * WHERE {
        { { ?x :p ?y } UNION { ?z :q ?w } }
        ?x :r ?b
        OPTIONAL { ?x :s ?t }
        FILTER(sameTerm(?x, :c))
      }`);
      const before = JSON.stringify(algebra);
      pushDownAssertions(c, algebra);
      expect(JSON.stringify(algebra)).toEqual(before);
    });

    it('applying the transformation twice yields the same result as once', ({ expect }) => {
      const query = `${prefixes}SELECT * WHERE {
        { { ?x :p ?y } UNION { ?z :q ?w } }
        OPTIONAL { ?x :s ?t }
        { SELECT ?x ?b WHERE { ?x :r ?b } LIMIT 5 }
        FILTER(sameTerm(?x, :c))
      }`;
      const once = pushDownAssertions(c, parseQuery(c, query));
      const twice = pushDownAssertions(c, pushDownAssertions(c, parseQuery(c, query)));
      expect(c.generator.generate(toAst(twice))).toEqual(c.generator.generate(toAst(once)));
    });
  });

  describe('semantic equivalence (evaluation)', () => {
    const engine = new QueryEngine();

    async function bindings(query: string): Promise<string[]> {
      const stream = await engine.queryBindings(query, {
        sources: [ './test/statics/assertionPushdown.ttl' ],
      });
      const rows: any[] = await arrayifyStream(stream);
      // Sorted, but duplicates kept: the multiplicity of every row is part of the answer.
      return rows
        .map(row => [ ...row ].map(([ k, v ]: [any, any]) => `${k.value}=${v.value}`).sort().join('|'))
        .sort();
    }

    async function assertEquivalent(
      expect: typeof Expect,
      query: string,
      expectedRows: number,
    ): Promise<void> {
      const original = await bindings(prefixes + query);
      const transformed = await bindings(transform(query));
      expect(transformed).toEqual(original);
      expect(original).toHaveLength(expectedRows);
    }

    it('still yields one solution when the VALUES collapses to the empty BGP', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        VALUES (?x) { (:a) (:b) }
        FILTER(sameTerm(?x, :a))
      }`, 1);
    });

    it('keeps one solution per row of a VALUES the assertion strips every column from', async({ expect }) => {
      // The empty BGP is one empty solution mapping, so it may only replace a *single* remaining row.
      await assertEquivalent(expect, `SELECT * WHERE {
        VALUES (?x) { (:a) (:a) (:b) }
        FILTER(sameTerm(?x, :a))
      }`, 2);
    });

    it('keeps the multiplicities a UNION produces', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        { { ?x :p ?y } UNION { ?x :p ?y } }
        FILTER(sameTerm(?x, :a))
      }`, 2);
    });

    it('keeps the per-pair witness count of a property path', async({ expect }) => {
      await assertEquivalent(expect, `SELECT ?x ?y WHERE {
        ?x :step/:onwards ?y
        FILTER(sameTerm(?x, :a))
      }`, 2);
    });

    it('keeps a MINUS whose right hand side shares only the object variable', async({ expect }) => {
      // The trap: a strong prune empties the right hand side by (FBndII), `A ∖ Empty ≡ A` deletes the
      // MINUS, and the query returns everything where the answer is nothing.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?x :p ?y
        MINUS { ?z :q ?y }
        FILTER(sameTerm(?x, :a))
      }`, 0);
    });

    it('keeps the UNDEF row of a VALUES on the right of a MINUS', async({ expect }) => {
      // The UNDEF row is what excludes the only answer: dropping it - as a strong prune would - turns
      // the empty answer into one row.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?x :p ?y
        MINUS { VALUES (?x ?y) { (:d :shared) (UNDEF :shared) } }
        FILTER(sameTerm(?x, :a))
      }`, 0);
    });

    it('does not match a literal with another lexical form (sameTerm, not =)', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :value ?o
        FILTER(sameTerm(?o, "01"^^xsd:integer))
      }`, 0);
      // The very same query under `=` does match, which is why this pass may never generalise to `=`.
      expect(await bindings(`${prefixes}SELECT * WHERE {
        ?s :value ?o
        FILTER(?o = "01"^^xsd:integer)
      }`)).toHaveLength(1);
    });

    it('keeps the row an equality against a literal matches', async({ expect }) => {
      // The regression the IRI case has to stay clear of: reading this `=` as an assertion would
      // substitute "01"^^xsd:integer into the pattern and lose the row holding "1"^^xsd:integer.
      await assertEquivalent(expect, `SELECT * WHERE {
        ?s :value ?o
        FILTER(?o = "01"^^xsd:integer)
      }`, 1);
    });

    it('matches what an equality against an IRI matched', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?x :p ?y
        FILTER(?x = :a)
      }`, 1);
    });

    it('keeps an OPTIONAL turned into a join equivalent', async({ expect }) => {
      await assertEquivalent(expect, `SELECT * WHERE {
        ?x :step ?m
        OPTIONAL { ?m :onwards ?y }
        FILTER(sameTerm(?y, :end))
      }`, 2);
    });
  });
});
