import { toAlgebra, toAst } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { expect as Expect } from 'vitest';
import { describe, it } from 'vitest';
import { EXTENSION_FUNCTION_BNODE } from '../lib/consts.js';
import { pullUpExtends } from '../lib/transformations/pullUpExtends.js';
import { pushDownAssertions } from '../lib/transformations/pushDownAssertions.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext, parseQuery } from '../lib/transformContext.js';
import { withCpVars, withoutCpVars } from '../lib/utils/certainlyBoundVars.js';
import { expressionsEqual, isStableExpression } from '../lib/utils/expressionHelpers.js';
import { peelExtends } from '../lib/utils/extendChain.js';

const prefixes = `PREFIX : <ex://>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
`;

describe('pullUpExtends', () => {
  // The pass only uses AF / DF / astTransformer from the context, never the mapping, so a mapping-less
  // partial context is sufficient here - as it is for the pushdown this mirrors.
  const c = <TransformContext> createPartialContext();

  function transform(query: string): string {
    return c.generator.generate(toAst(pullUpExtends(c, parseQuery(c, prefixes + query)))).trim();
  }

  /** The variables bound by the EXTEND chain at the top of an operation, in evaluation order. */
  function bindsAtTopOf(op: Algebra.Operation): string[] {
    return peelExtends(c, op).binds.map(bind => bind.variable.value);
  }

  /**
   * What an operation puts in scope, as two sorted lists: the variables every solution binds, and the keys
   * of the ranges, which is what `SELECT *` expands to.
   */
  function scopeOf(op: Algebra.Operation): { cVars: string[]; pVars: string[] } {
    const { cVars, vRanges } = withCpVars(withoutCpVars(op)).metadata;
    return { cVars: [ ...cVars ].sort(), pVars: [ ...vRanges.keys() ].sort() };
  }

  /** Whether any operation of a tree still carries a cached `CPMeta`. */
  function holdsCachedMetadata(op: Algebra.Operation): boolean {
    let found = false;
    c.astTransformer.visitObject(op, (object) => {
      if ('type' in object && 'metadata' in object) {
        found = true;
      }
      return object;
    });
    return found;
  }

  /**
   * The three checks every case of every phase owes, run on top of the string comparison: the scope
   * invariant of the rewrite, idempotence of the pass, and the metadata hygiene the licences depend on.
   *
   * The scope invariant is what the string comparison cannot see. A hoist that lost a variable out of
   * `cVars` still prints as a plausible query, and only changes what `SELECT *` returns on data that
   * leaves something unbound.
   */
  function expectTransform(expect: typeof Expect, query: string, expected: string): void {
    const input = parseQuery(c, prefixes + query);
    const output = pullUpExtends(c, input);
    expect(c.generator.generate(toAst(output)).trim()).toEqual(expected.trim());
    expect(scopeOf(output)).toEqual(scopeOf(parseQuery(c, prefixes + query)));
    expect(holdsCachedMetadata(output)).toBe(false);
    // Idempotence: what the pass produced is a fixpoint of it.
    expect(c.generator.generate(toAst(pullUpExtends(c, output))).trim()).toEqual(expected.trim());
  }

  /** Transforms a query parsed *without* quads, so that a GRAPH survives as an operation of its own. */
  function parseWithGraphOperation(query: string): Algebra.Operation {
    return toAlgebra(c.parser.parse(prefixes + query), { quads: false, blankToVariable: true });
  }

  describe('congruent operations', () => {
    it('rises past a FILTER whose condition does not mention the variable', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(:a AS ?x) FILTER(?o > 2) }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( ( ?o > "2"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });

    it('rises past a FILTER that reads it, writing the term into the condition', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(:a AS ?x) FILTER(?x = :a) }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( TRUE )
}`,
      );
    });

    it('folds bound(?x) to true for a certain bind', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(:a AS ?x) FILTER(BOUND(?x)) }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  FILTER ( TRUE )
}`,
      );
    });

    it('rises past a DISTINCT of a sub-SELECT', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT DISTINCT ?s ?x WHERE { ?s :p ?o BIND(:a AS ?x) } } ?s :q ?w }',
        `SELECT ?s ?w ( <ex://a> AS ?x ) WHERE {
  {
    SELECT DISTINCT ?s WHERE {
      ?s <ex://p> ?o .
    }
  }
  ?s <ex://q> ?w .
}`,
      );
    });

    it('rises past a SLICE, which the pushdown may not pass', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?s ?x WHERE { ?s :p ?o BIND(:a AS ?x) } LIMIT 5 } ?s :q ?w }',
        `SELECT ?s ?w ( <ex://a> AS ?x ) WHERE {
  {
    SELECT ?s WHERE {
      ?s <ex://p> ?o .
    }
    LIMIT 5
  }
  ?s <ex://q> ?w .
}`,
      );
    });

    it('rises past an ORDER BY that does not mention it', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?s ?x WHERE { ?s :p ?o BIND(:a AS ?x) } ORDER BY ?s } ?s :q ?w }',
        `SELECT ?s ?w ( <ex://a> AS ?x ) WHERE {
  {
    SELECT ?s WHERE {
      ?s <ex://p> ?o .
    }
    ORDER BY ASC ( ?s )
  }
  ?s <ex://q> ?w .
}`,
      );
    });

    it('rises past a FROM, whose place in a query no parser puts a hoist target above', ({ expect }) => {
      // Built by hand: `FROM` only occurs at the top of a query, where the modifier chain seals it.
      const { AF, DF } = c;
      const scan = AF.createBgp([ AF.createPattern(DF.variable('s'), DF.namedNode('ex://p'), DF.variable('o')) ]);
      const from = AF.createFrom(
        AF.createExtend(scan, DF.variable('x'), AF.createTermExpression(DF.namedNode('ex://a'))),
        [ DF.namedNode('ex://g') ],
        [],
      );
      const other = AF.createBgp([ AF.createPattern(DF.variable('a'), DF.namedNode('ex://q'), DF.variable('b')) ]);
      const result = pullUpExtends(c, AF.createJoin([ from, other ], false));
      expect(bindsAtTopOf(result)).toEqual([ 'x' ]);
      expect(scopeOf(result)).toEqual(scopeOf(AF.createJoin([ from, other ], false)));
    });
  });

  describe('a named graph', () => {
    // A GRAPH is the one operation whose rule the generated string cannot show: `toAst` writes an EXTEND
    // at the top of a graph pattern as a SELECT expression, exactly as it writes one that rose past it.
    it('rises out of a GRAPH when it does not read the graph variable', ({ expect }) => {
      const parsed = parseWithGraphOperation('SELECT * WHERE { GRAPH ?g { ?s :p ?o BIND(:a AS ?x) } }');
      const result = <Algebra.Project> pullUpExtends(c, parsed);
      expect(bindsAtTopOf(result.input)).toEqual([ 'x' ]);
      expect(scopeOf(result)).toEqual(scopeOf(parsed));
    });

    it('stays when it reads a graph variable the pattern does not certainly bind', ({ expect }) => {
      const parsed = parseWithGraphOperation(
        'SELECT * WHERE { GRAPH ?g { { ?s :p ?o } OPTIONAL { ?g :q ?w } BIND(?g AS ?x) } }',
      );
      const result = <Algebra.Project> pullUpExtends(c, parsed);
      expect(bindsAtTopOf(result.input)).toEqual([]);
      expect(scopeOf(result)).toEqual(scopeOf(parsed));
    });

    it('stays when it writes the graph variable itself', ({ expect }) => {
      const parsed = parseWithGraphOperation('SELECT * WHERE { GRAPH ?g { ?s :p ?o BIND(:a AS ?g) } }');
      const result = <Algebra.Project> pullUpExtends(c, parsed);
      expect(bindsAtTopOf(result.input)).toEqual([]);
    });
  });

  describe('the drop sites', () => {
    it('drops a bind a PROJECT does not project', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT ?y WHERE { ?y :p ?o . BIND(:a AS ?x) }',
        `SELECT ?y WHERE {
  ?y <ex://p> ?o .
}`,
      );
    });

    it('rises out of a sub-SELECT that projects it, striking the column', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?s ?x WHERE { ?s :p ?o BIND(:a AS ?x) } } ?s :q ?w }',
        `SELECT ?s ?w ( <ex://a> AS ?x ) WHERE {
  {
    SELECT ?s WHERE {
      ?s <ex://p> ?o .
    }
  }
  ?s <ex://q> ?w .
}`,
      );
    });

    it('stays in a sub-SELECT that does not project what the expression reads', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SELECT ?s ?x WHERE { ?s :p ?o BIND(?o AS ?x) } } ?s :q ?w }',
        `SELECT ?s ?w ?x WHERE {
  {
    SELECT ?s ( ?o AS ?x ) WHERE {
      ?s <ex://p> ?o .
    }
  }
  ?s <ex://q> ?w .
}`,
      );
    });

    it('drops a bind a GROUP sees in neither its keys nor its aggregates', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { SELECT (COUNT(?o) AS ?n) WHERE { ?s :p ?o BIND(:a AS ?x) } GROUP BY ?s }',
        `SELECT ?n WHERE {
  SELECT ( COUNT( ?o ) AS ?n ) WHERE {
    ?s <ex://p> ?o .
  }
  GROUP BY ?s
}`,
      );
    });

    it('keeps a bind an aggregate expression reads, which is neither a key nor a target', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { SELECT ?s (SUM(?x) AS ?n) WHERE { ?s :p ?o BIND(?o AS ?x) } GROUP BY ?s }',
        `SELECT ?n ?s WHERE {
  SELECT ?s ( SUM( ?x ) AS ?n ) WHERE {
    ?s <ex://p> ?o .
    BIND( ?o AS ?x )
  }
  GROUP BY ?s
}`,
      );
    });

    it('keeps a bind of a grouping key', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { SELECT ?x (COUNT(?o) AS ?n) WHERE { ?s :p ?o BIND(:a AS ?x) } GROUP BY ?x }',
        `SELECT ?n ?x WHERE {
  SELECT ?x ( COUNT( ?o ) AS ?n ) WHERE {
    ?s <ex://p> ?o .
    BIND( <ex://a> AS ?x )
  }
  GROUP BY ?x
}`,
      );
    });
  });

  describe('joins', () => {
    it('rises out of the one operand that binds the variable - the worked example', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s ?p ?o . BIND(<ex://a> AS ?x) } { ?a ?b ?c } }',
        `SELECT ?a ?b ?c ?o ?p ?s ( <ex://a> AS ?x ) WHERE {
  ?s ?p ?o .
  ?a ?b ?c .
}`,
      );
    });

    it('rises past a sibling that has the variable in scope but never binds it', ({ expect }) => {
      // (C1) is read on the ranges, so an all-UNDEF VALUES column is a legitimate hoist target.
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } { VALUES ?x { UNDEF } ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  VALUES ?x {
    UNDEF
  }
  ?a <ex://q> ?b .
}`,
      );
    });

    it('stays when a sibling can bind the variable (C1)', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } { ?a :q ?x } }',
        `SELECT ?a ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( <ex://a> AS ?x )
  }
  ?a <ex://q> ?x .
}`,
      );
    });

    it('stays when a non-term expression has a single carrier (the cost gate)', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(CONCAT(STR(?s), "z") AS ?x) } { ?a :q ?w } }',
        `SELECT ?a ?o ?s ?w ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( CONCAT( STR( ?s ) , "z" ) AS ?x )
  }
  ?a <ex://q> ?w .
}`,
      );
    });

    it('merges two carriers of one non-term bind into a single one above the join', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?s :p ?o BIND(CONCAT(STR(?s), "z") AS ?x) }
          { ?s :q ?w BIND(CONCAT(STR(?s), "z") AS ?x) }
        }`,
        `SELECT ?o ?s ?w ( CONCAT( STR( ?s ) , "z" ) AS ?x ) WHERE {
  ?s <ex://p> ?o .
  ?s <ex://q> ?w .
}`,
      );
    });

    it('merges two carriers of one ground bind', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } { ?s :q ?w BIND(:a AS ?x) } }',
        `SELECT ?o ?s ?w ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  ?s <ex://q> ?w .
}`,
      );
    });

    it('does not merge when a carrier does not certainly bind what the expression reads', ({ expect }) => {
      // `?o` is bound in the first operand and nowhere in the second, so the two copies of the bind are
      // not the same value and the compatibility test on `?x` is not a tautology.
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?s :p ?o BIND(CONCAT(STR(?o), "z") AS ?x) }
          { ?s :q ?w BIND(CONCAT(STR(?o), "z") AS ?x) }
        }`,
        `SELECT ?o ?s ?w ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( CONCAT( STR( ?o ) , "z" ) AS ?x )
  }
  {
    ?s <ex://q> ?w .
    BIND( CONCAT( STR( ?o ) , "z" ) AS ?x )
  }
}`,
      );
    });
  });

  describe('optionals, minus and unions', () => {
    it('rises out of the left of an OPTIONAL', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } OPTIONAL { ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    ?a <ex://q> ?b .
  }
}`,
      );
    });

    it('writes the term into the condition of the OPTIONAL it rises past', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } OPTIONAL { ?s :q ?w FILTER(?x = :a) } }',
        `SELECT ?o ?s ?w ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    ?s <ex://q> ?w .
    FILTER ( TRUE )
  }
}`,
      );
    });

    it('never rises out of the right of an OPTIONAL', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?a :q ?b BIND(:a AS ?x) } }',
        `SELECT ?a ?b ?o ?s ?x WHERE {
  ?s <ex://p> ?o .
  OPTIONAL {
    {
      ?a <ex://q> ?b .
      BIND( <ex://a> AS ?x )
    }
  }
}`,
      );
    });

    it('rises out of the left of a MINUS', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } MINUS { ?a :q ?b } }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  ?s <ex://p> ?o .
  MINUS {
    ?a <ex://q> ?b .
  }
}`,
      );
    });

    it('stays on the left of a MINUS whose right can bind the variable', ({ expect }) => {
      // `?x` is in both the compatibility and the domain-disjointness test, neither of which the hoisted
      // bind would be above.
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } MINUS { ?a :q ?x } }',
        `SELECT ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( <ex://a> AS ?x )
  }
  MINUS {
    ?a <ex://q> ?x .
  }
}`,
      );
    });

    it('never rises out of the right of a MINUS', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o MINUS { ?s :q ?w BIND(:a AS ?x) } }',
        `SELECT ?o ?s WHERE {
  ?s <ex://p> ?o .
  MINUS {
    {
      ?s <ex://q> ?w .
      BIND( <ex://a> AS ?x )
    }
  }
}`,
      );
    });

    it('hoists out of a UNION every branch of which carries the same bind', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } UNION { ?s :q ?o BIND(:a AS ?x) } }',
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  {
    ?s <ex://p> ?o .
  }
  UNION {
    ?s <ex://q> ?o .
  }
}`,
      );
    });

    it('hoists out of a three-branch UNION', ({ expect }) => {
      expectTransform(
        expect,
        `SELECT * WHERE {
          { ?s :p ?o BIND(:a AS ?x) } UNION { ?s :q ?o BIND(:a AS ?x) } UNION { ?s :r ?o BIND(:a AS ?x) }
        }`,
        `SELECT ?o ?s ( <ex://a> AS ?x ) WHERE {
  {
    ?s <ex://p> ?o .
  }
  UNION {
    ?s <ex://q> ?o .
  }
  UNION {
    ?s <ex://r> ?o .
  }
}`,
      );
    });

    it('leaves a UNION whose branches bind the variable to different terms', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } UNION { ?s :q ?o BIND(:b AS ?x) } }',
        `SELECT ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( <ex://a> AS ?x )
  }
  UNION {
    ?s <ex://q> ?o .
    BIND( <ex://b> AS ?x )
  }
}`,
      );
    });

    it('leaves a UNION one branch of which does not carry the bind', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) } UNION { ?s :q ?o } }',
        `SELECT ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( <ex://a> AS ?x )
  }
  UNION {
    ?s <ex://q> ?o .
  }
}`,
      );
    });
  });

  describe('barriers', () => {
    it('leaves an unstable expression where it is', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(RAND() AS ?x) } { ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( RAND( ) AS ?x )
  }
  ?a <ex://q> ?b .
}`,
      );
    });

    it('leaves a bind a FILTER reads through a non-term expression', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o BIND(CONCAT(STR(?o), "z") AS ?x) FILTER(?x = "q") }',
        `SELECT ?o ?s ?x WHERE {
  {
    ?s <ex://p> ?o .
    BIND( CONCAT( STR( ?o ) , "z" ) AS ?x )
  }
  FILTER ( ( ?x = "q" ) )
}`,
      );
    });

    it('rises past a FILTER whose EXISTS does not read the variable', ({ expect }) => {
      // The nested pattern is evaluated against a solution mapping that does not hold `?x` either way, so
      // nothing about the EXISTS changes. What stays forbidden is *writing* into one, below.
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) FILTER(EXISTS { ?s :q ?z }) } { ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ( <ex://a> AS ?x ) WHERE {
  {
    ?s <ex://p> ?o .
    FILTER ( EXISTS {
      ?s <ex://q> ?z .
    }
    )
  }
  ?a <ex://q> ?b .
}`,
      );
    });

    it('is a barrier at a FILTER whose EXISTS reads the variable', ({ expect }) => {
      // A term may not be written into a nested pattern: an unbound `?x` there is a variable matching
      // anything, where the term it would be replaced by matches one thing.
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) FILTER(EXISTS { ?s :q ?x }) } { ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ?x WHERE {
  {
    {
      ?s <ex://p> ?o .
      BIND( <ex://a> AS ?x )
    }
    FILTER ( EXISTS {
      ?s <ex://q> ?x .
    }
    )
  }
  ?a <ex://q> ?b .
}`,
      );
    });

    it('blocks a hoist past bound(?x) when the bind is not certain', ({ expect }) => {
      // `?z` is only bound where the OPTIONAL matched, so `?x` is uncertain and `bound(?x)` cannot fold:
      // writing the term in would emit the ungrammatical `bound(<ex://a>)`.
      expectTransform(
        expect,
        'SELECT * WHERE { ?s :p ?o OPTIONAL { ?s :q ?z } BIND(?z AS ?x) FILTER(BOUND(?x)) }',
        `SELECT ?o ?s ?x ?z WHERE {
  {
    ?s <ex://p> ?o .
    OPTIONAL {
      ?s <ex://q> ?z .
    }
    BIND( ?z AS ?x )
  }
  FILTER ( BOUND( ?x ) )
}`,
      );
    });

    it('is a barrier at a SERVICE', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { SERVICE <ex://e> { ?s :p ?o BIND(:a AS ?x) } } { ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ?x WHERE {
  SERVICE <ex://e> {
    {
      ?s <ex://p> ?o .
      BIND( <ex://a> AS ?x )
    }
  }
  ?a <ex://q> ?b .
}`,
      );
    });
  });

  describe('order within a chain', () => {
    it('writes a risen term into the bind that stays above it', ({ expect }) => {
      expectTransform(
        expect,
        'SELECT * WHERE { { ?s :p ?o BIND(:a AS ?x) BIND(CONCAT(STR(?x), STR(RAND())) AS ?y) } { ?a :q ?b } }',
        `SELECT ?a ?b ?o ?s ( <ex://a> AS ?x ) ?y WHERE {
  {
    ?s <ex://p> ?o .
    BIND( CONCAT( STR( <ex://a> ) , STR( RAND( ) ) ) AS ?y )
  }
  ?a <ex://q> ?b .
}`,
      );
    });

    it('pins a riser the bind above it reads but cannot take the value of', ({ expect }) => {
      // `?x` is not a term expression, so it cannot be written into `?y`; and `?y` is unstable, so it
      // cannot follow `?x` up. The only partition left is both staying.
      expectTransform(
        expect,
        `SELECT * WHERE {
          ?s :p ?o
          BIND(CONCAT(STR(?o), "z") AS ?x)
          BIND(CONCAT(STR(?x), STR(RAND())) AS ?y)
          FILTER(?o > 2)
        }`,
        `SELECT ?o ?s ?x ?y WHERE {
  {
    ?s <ex://p> ?o .
    BIND( CONCAT( STR( ?o ) , "z" ) AS ?x )
    BIND( CONCAT( STR( ?x ) , STR( RAND( ) ) ) AS ?y )
  }
  FILTER ( ( ?o > "2"^^<http://www.w3.org/2001/XMLSchema#integer> ) )
}`,
      );
    });
  });

  describe('discipline', () => {
    it('leaves the input tree untouched', ({ expect }) => {
      const algebra = parseQuery(c, `${prefixes}SELECT * WHERE {
        { ?s :p ?o BIND(:a AS ?x) } { ?a :q ?b } FILTER(?x = :a)
      }`);
      const before = JSON.stringify(algebraUtils.objectify(algebra));
      pullUpExtends(c, algebra);
      expect(JSON.stringify(algebraUtils.objectify(algebra))).toEqual(before);
    });

    it('does not oscillate against the assertion pushdown', ({ expect }) => {
      const query = `${prefixes}SELECT * WHERE {
        { ?s :p ?o } { ?s :q ?w } FILTER(sameTerm(?s, :a))
      }`;
      const once = pullUpExtends(c, pushDownAssertions(c, parseQuery(c, query)));
      const twice = pullUpExtends(c, pushDownAssertions(c, once));
      const thrice = pullUpExtends(c, pushDownAssertions(c, twice));
      const generated = (op: Algebra.Operation): string => c.generator.generate(toAst(op)).trim();
      expect(generated(twice)).toEqual(generated(once));
      expect(generated(thrice)).toEqual(generated(once));
    });
  });

  describe('isStableExpression', () => {
    const { AF, DF } = c;

    it('accepts NOW, which one query execution answers once', ({ expect }) => {
      expect(isStableExpression(c, AF.createOperatorExpression('now', []))).toBe(true);
    });

    it('accepts an expression over variables', ({ expect }) => {
      expect(isStableExpression(c, AF.createOperatorExpression('str', [
        AF.createTermExpression(DF.variable('s')),
      ]))).toBe(true);
    });

    for (const operator of [ 'rand', 'uuid', 'struuid', 'bnode' ]) {
      it(`rejects ${operator.toUpperCase()}`, ({ expect }) => {
        expect(isStableExpression(c, AF.createOperatorExpression('concat', [
          AF.createTermExpression(DF.literal('a')),
          AF.createOperatorExpression(operator, []),
        ]))).toBe(false);
      });
    }

    it('accepts the one allowlisted extension function', ({ expect }) => {
      expect(isStableExpression(c, AF.createNamedExpression(DF.namedNode(EXTENSION_FUNCTION_BNODE), [
        AF.createTermExpression(DF.variable('s')),
      ]))).toBe(true);
    });

    it('rejects an extension function nothing declares stable', ({ expect }) => {
      expect(isStableExpression(c, AF.createNamedExpression(DF.namedNode('ex://f'), []))).toBe(false);
    });

    it('rejects an EXISTS', ({ expect }) => {
      expect(isStableExpression(c, AF.createExistenceExpression(false, AF.createBgp([])))).toBe(false);
    });

    it('rejects an aggregate', ({ expect }) => {
      expect(isStableExpression(c, AF.createAggregateExpression(
        'sum',
        AF.createTermExpression(DF.variable('o')),
        false,
      ))).toBe(false);
    });
  });

  describe('expressionsEqual', () => {
    const { AF, DF } = c;

    it('is true of two spellings of one term expression', ({ expect }) => {
      expect(expressionsEqual(
        AF.createTermExpression(DF.namedNode('ex://a')),
        AF.createTermExpression(DF.namedNode('ex://a')),
      )).toBe(true);
    });

    it('is false of two different terms', ({ expect }) => {
      expect(expressionsEqual(
        AF.createTermExpression(DF.namedNode('ex://a')),
        AF.createTermExpression(DF.namedNode('ex://b')),
      )).toBe(false);
    });

    it('compares operator arguments pairwise and in order', ({ expect }) => {
      const arguments_ = [ DF.variable('s'), DF.literal('z') ].map(term => AF.createTermExpression(term));
      expect(expressionsEqual(
        AF.createOperatorExpression('concat', arguments_),
        AF.createOperatorExpression('concat', [ ...arguments_ ]),
      )).toBe(true);
      expect(expressionsEqual(
        AF.createOperatorExpression('concat', arguments_),
        AF.createOperatorExpression('concat', [ ...arguments_ ].reverse()),
      )).toBe(false);
    });

    it('is false across sub-types and across operators', ({ expect }) => {
      expect(expressionsEqual(
        AF.createOperatorExpression('str', [ AF.createTermExpression(DF.variable('s')) ]),
        AF.createTermExpression(DF.variable('s')),
      )).toBe(false);
      expect(expressionsEqual(
        AF.createOperatorExpression('str', [ AF.createTermExpression(DF.variable('s')) ]),
        AF.createOperatorExpression('ucase', [ AF.createTermExpression(DF.variable('s')) ]),
      )).toBe(false);
    });

    it('compares the name of an extension function', ({ expect }) => {
      expect(expressionsEqual(
        AF.createNamedExpression(DF.namedNode('ex://f'), []),
        AF.createNamedExpression(DF.namedNode('ex://f'), []),
      )).toBe(true);
      expect(expressionsEqual(
        AF.createNamedExpression(DF.namedNode('ex://f'), []),
        AF.createNamedExpression(DF.namedNode('ex://g'), []),
      )).toBe(false);
    });

    it('never walks into an EXISTS, so two of them are never equal', ({ expect }) => {
      const exists = (): Algebra.Expression => AF.createExistenceExpression(false, AF.createBgp([]));
      expect(expressionsEqual(exists(), exists())).toBe(false);
    });
  });

  it('transforms the query the design opens with', ({ expect }) => {
    expect(transform('SELECT * { { ?s ?p ?o . BIND(<ex://a> AS ?x) } { ?a ?b ?c } }')).toEqual(
      `SELECT ?a ?b ?c ?o ?p ?s ( <ex://a> AS ?x ) WHERE {
  ?s ?p ?o .
  ?a ?b ?c .
}`,
    );
  });
});
