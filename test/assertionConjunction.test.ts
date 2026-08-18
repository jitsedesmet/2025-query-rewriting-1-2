import { toAst } from '@traqula/algebra-sparql-1-2';
import { describe, it } from 'vitest';
import { emptyRange, graphRange, RangeSet, subjectRange } from '../lib/RangeSet.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext } from '../lib/transformContext.js';
import { AssertionConjunction, collectAssertions } from '../lib/utils/assertionConjunction.js';
import type { Access, Assertion, AssertionValue } from '../lib/utils/assertions.js';
import {
  accessId,
  assertBound,
  assertStrong,
  assertUnbound,
  assertWeak,
  rootAccess,
  tripleValue,
} from '../lib/utils/assertions.js';
import type { CPMeta } from '../lib/utils/certainlyBoundVars.js';
import { VRanges } from '../lib/utils/certainlyBoundVars.js';
import { DF } from '../lib/utils/rdfDatatypes.js';

const c = <TransformContext> createPartialContext();
const termC = DF.namedNode('ex://c');
const termD = DF.namedNode('ex://d');
/** T⟨?x⟩: a triple term, nothing known about its parts. */
const tripleShape = tripleValue;

/** The access `subject(?x)`. */
function subject(name: string): Access {
  return { name, positions: [ 'subject' ]};
}
/** The access `object(?x)`. */
function object(name: string): Access {
  return { name, positions: [ 'object' ]};
}

/** The metadata of an operation binding `inScope`, of which `certain` is certainly bound. */
function metaOf(certain: string[], inScope: string[]): CPMeta {
  const vRanges = new VRanges();
  vRanges.addAtTop(inScope);
  return { cVars: new Set(certain), vRanges };
}

/** {@link metaOf} with `name` narrowed to `range`, the operation binding nothing else. */
function rangedMeta(certain: string[], name: string, range: RangeSet): CPMeta {
  const vRanges = new VRanges();
  vRanges.narrow(name, range);
  return { cVars: new Set(certain), vRanges };
}

/** The conjunction of the given conjuncts, or `undefined` when they contradict each other. */
function conjunctionOf(...conjuncts: [ string | Access, Assertion ][]): AssertionConjunction | undefined {
  const result = new AssertionConjunction();
  for (const [ access, assertion ] of conjuncts) {
    if (!result.assert(typeof access === 'string' ? rootAccess(access) : access, assertion)) {
      return undefined;
    }
  }
  return result;
}

/** How an assertion value reads, for the state of a variable. */
function valueString(value: AssertionValue): string {
  switch (value.kind) {
    case 'triple': {
      return 'triple';
    }
    case 'access': {
      return accessId(value.access);
    }
    case 'term': {
      return value.term.termType === 'Quad' ?
          `<<(${[ value.term.subject, value.term.predicate, value.term.object ]
            .map(part => part.value).join(' ')})>>` :
        value.term.value;
    }
  }
}

/** The state of a variable, as the single letter of the form it is in. */
function stateOf(assertions: AssertionConjunction | undefined, name: string): string {
  const assertion = assertions?.get(name);
  if (assertion === undefined) {
    return 'none';
  }
  return assertion.subType === 'strong' || assertion.subType === 'weak' ?
      `${assertion.subType}(${valueString(assertion.value)})` :
    assertion.subType;
}

/** The conjunction, serialised through the generator - which is also how the pass writes it into a plan. */
function conditionOf(assertions: AssertionConjunction): string {
  const query = c.generator.generate(toAst(c.AF.createProject(
    c.AF.createFilter(c.AF.createBgp([]), assertions.toExpression(c)),
    [],
  ))).trim();
  return query.split('\n').map(line => line.trim()).filter(line => line.startsWith('FILTER')).join(' ');
}

describe('assertionConjunction', () => {
  describe('assertions about a term', () => {
    it('reads a strong assertion back', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'x', assertStrong(termC) ]), 'x')).toBe('strong(ex://c)');
    });

    it('absorbs the weak form of what it knows strongly (`A ∧ W ≡ A`)', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertWeak(termC) ]), 'x'))
        .toBe('strong(ex://c)');
    });

    it('promotes what it knows weakly when it meets the strong form', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'x', assertWeak(termC) ], [ 'x', assertStrong(termC) ]), 'x'))
        .toBe('strong(ex://c)');
    });

    it('contradicts on two distinct terms, one of them strong', ({ expect }) => {
      expect(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertStrong(termD) ])).toBeUndefined();
      expect(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertWeak(termD) ])).toBeUndefined();
      expect(conjunctionOf([ 'x', assertWeak(termC) ], [ 'x', assertStrong(termD) ])).toBeUndefined();
    });

    it('comes to `!bound` on two distinct terms, both weak', ({ expect }) => {
      // `(¬b ∨ ?x ≡ c) ∧ (¬b ∨ ?x ≡ d)` distributes to `¬b ∨ (?x ≡ c ∧ ?x ≡ d)`, which for `c ≠ d` is `¬b`.
      expect(stateOf(conjunctionOf([ 'x', assertWeak(termC) ], [ 'x', assertWeak(termD) ]), 'x')).toBe('unbound');
    });
  });

  describe('the U interactions of a group', () => {
    it('contradicts a strong member of a pinned group', ({ expect }) => {
      expect(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertUnbound() ])).toBeUndefined();
      expect(conjunctionOf([ 'x', assertUnbound() ], [ 'x', assertStrong(termC) ])).toBeUndefined();
    });

    it('absorbs a weak member and takes it out of the group', ({ expect }) => {
      // `¬b ∧ (¬b ∨ φ) ≡ ¬b`, so nothing of the term survives on `?x` - and nothing of it reaches `?y`,
      // which keeps saying exactly what it said.
      const assertions = conjunctionOf(
        [ 'x', assertWeak(termC) ],
        [ 'y', assertStrong(termC) ],
        [ 'x', assertUnbound() ],
      );
      expect(stateOf(assertions, 'x')).toBe('unbound');
      expect(stateOf(assertions, 'y')).toBe('strong(ex://c)');
      // Disjointness: `?x` is in no group any more, so nothing about it can be substituted.
      expect([ ...(<AssertionConjunction> assertions).expressionSubstitution().keys() ]).toEqual([ 'y' ]);
    });

    it('contradicts a member of a clique, which is always strong', ({ expect }) => {
      expect(conjunctionOf([ 'x', assertStrong(DF.variable('y')) ], [ 'x', assertUnbound() ])).toBeUndefined();
      // The representative just as much: the clique implies it is bound too.
      expect(conjunctionOf([ 'y', assertStrong(DF.variable('x')) ], [ 'x', assertUnbound() ])).toBeUndefined();
    });

    it('contradicts `bound`', ({ expect }) => {
      expect(conjunctionOf([ 'x', assertBound() ], [ 'x', assertUnbound() ])).toBeUndefined();
      expect(conjunctionOf([ 'x', assertUnbound() ], [ 'x', assertBound() ])).toBeUndefined();
    });
  });

  describe('the B interactions of a group', () => {
    it('is absorbed by a strong member', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'x', assertStrong(termC) ], [ 'x', assertBound() ]), 'x'))
        .toBe('strong(ex://c)');
    });

    it('promotes a weak member to a strong one', ({ expect }) => {
      // `b ∧ (¬b ∨ ?x ≡ c) ≡ ?x ≡ c`, in both orders.
      expect(stateOf(conjunctionOf([ 'x', assertWeak(termC) ], [ 'x', assertBound() ]), 'x'))
        .toBe('strong(ex://c)');
      expect(stateOf(conjunctionOf([ 'x', assertBound() ], [ 'x', assertWeak(termC) ]), 'x'))
        .toBe('strong(ex://c)');
    });

    it('is absorbed by clique membership, which implies it', ({ expect }) => {
      const assertions = conjunctionOf([ 'x', assertStrong(DF.variable('y')) ], [ 'x', assertBound() ]);
      // `?x` is the representative of the clique `{?x, ?y}`, and B⟨?x⟩ is all that is left to say of it.
      expect(stateOf(assertions, 'x')).toBe('bound');
      expect(stateOf(assertions, 'y')).toBe('strong(x)');
      expect(conditionOf(<AssertionConjunction> assertions)).toBe('FILTER ( SAMETERM( ?y , ?x ) )');
    });

    it('is absorbed by itself', ({ expect }) => {
      expect(stateOf(conjunctionOf([ 'x', assertBound() ], [ 'x', assertBound() ]), 'x')).toBe('bound');
    });
  });

  describe('unification', () => {
    it('makes a clique whose representative is its lexicographically first member', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 's', assertStrong(DF.variable('o')) ]);
      expect(assertions.cliques()).toEqual([[ 'o', 's' ]]);
      expect(stateOf(assertions, 's')).toBe('strong(o)');
      // The representative has nothing left to be equal to, and reads as what the clique entails of it.
      expect(stateOf(assertions, 'o')).toBe('bound');
      expect([ ...assertions.expressionSubstitution() ]).toEqual([[ 's', DF.variable('o') ]]);
      expect(conditionOf(assertions)).toBe('FILTER ( SAMETERM( ?s , ?o ) )');
    });

    it('re-picks the representative when a merge brings in an earlier variable', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 's', assertStrong(DF.variable('o')) ],
        [ 'o', assertStrong(DF.variable('a')) ],
      );
      expect(assertions.cliques()).toEqual([[ 'a', 'o', 's' ]]);
      expect([ ...assertions.expressionSubstitution() ])
        .toEqual([[ 's', DF.variable('a') ], [ 'o', DF.variable('a') ]]);
    });

    it('is only `bound` between a variable and itself', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertStrong(DF.variable('x')) ]);
      expect(stateOf(assertions, 'x')).toBe('bound');
      expect(assertions.cliques()).toEqual([]);
    });

    it('drags a term met later onto every member of the clique', ({ expect }) => {
      const assertions = conjunctionOf(
        [ 's', assertStrong(DF.variable('o')) ],
        [ 'o', assertStrong(termC) ],
      );
      expect(stateOf(assertions, 's')).toBe('strong(ex://c)');
      expect(stateOf(assertions, 'o')).toBe('strong(ex://c)');
      expect((<AssertionConjunction> assertions).cliques()).toEqual([]);
    });

    it('promotes a weak member it meets, membership implying bound', ({ expect }) => {
      const assertions = conjunctionOf(
        [ 's', assertWeak(termC) ],
        [ 's', assertStrong(DF.variable('o')) ],
      );
      expect(stateOf(assertions, 's')).toBe('strong(ex://c)');
      expect(stateOf(assertions, 'o')).toBe('strong(ex://c)');
    });

    it('contradicts when the two cliques carry different terms', ({ expect }) => {
      expect(conjunctionOf(
        [ 'x', assertStrong(termC) ],
        [ 'y', assertStrong(termD) ],
        [ 'x', assertStrong(DF.variable('y')) ],
      )).toBeUndefined();
    });

    it('has no weak form to read back: `!bound(?x) || sameTerm(?x, ?y)` is left alone', ({ expect }) => {
      const collected = collectAssertions(
        c,
        c.AF.createOperatorExpression('||', [
          c.AF.createOperatorExpression('!', [
            c.AF.createOperatorExpression('bound', [ c.AF.createTermExpression(DF.variable('x')) ]),
          ]),
          c.AF.createOperatorExpression('sameterm', [
            c.AF.createTermExpression(DF.variable('x')),
            c.AF.createTermExpression(DF.variable('y')),
          ]),
        ]),
      );
      expect(collected?.assertions.size).toBe(0);
      expect(collected?.residual).toBeDefined();
    });
  });

  describe('splitting', () => {
    it('splits a clique into edges, never into variables', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'b', assertStrong(DF.variable('a')) ],
        [ 'c', assertStrong(DF.variable('b')) ],
      );
      const { inside, outside } = assertions.split(name => name !== 'c');
      // The edge `?c ≡ ?a` mentions a variable the predicate rejects, so the whole edge is on the outside.
      expect(conditionOf(inside)).toBe('FILTER ( SAMETERM( ?b , ?a ) )');
      expect(conditionOf(outside)).toBe('FILTER ( SAMETERM( ?c , ?a ) )');
    });

    it('keeps the two halves equivalent to the whole', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'b', assertStrong(DF.variable('a')) ],
        [ 'c', assertStrong(DF.variable('b')) ],
      );
      const { inside, outside } = assertions.split(name => name !== 'c');
      const rejoined = inside.clone();
      expect(rejoined.absorb(outside)).toBe(true);
      expect(rejoined.cliques()).toEqual([[ 'a', 'b', 'c' ]]);
    });
  });

  describe('triple terms', () => {
    it('reads a position back as the accessor it was read from', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ subject('o'), assertStrong(termC) ]);
      // Never `sameTerm(?o, <<( :c ?p ?q )>>)`: the variables naming the other positions are unbound
      // wherever the filter sits, so that condition would error and drop every row.
      expect(conditionOf(assertions)).toBe('FILTER ( SAMETERM( SUBJECT( ?o ) , <ex://c> ) )');
      expect(stateOf(assertions, 'o')).toBe('strong(triple)');
    });

    it('is degenerate for `isTRIPLE`, and absorbed by anything that says more', ({ expect }) => {
      expect(conditionOf(<AssertionConjunction> conjunctionOf([ 'o', assertStrong(tripleShape) ])))
        .toBe('FILTER ( ISTRIPLE( ?o ) )');
      // T⟨?o⟩ says only what a position of the shape already entails, in either order.
      for (const order of [[ tripleShape, undefined ], [ undefined, tripleShape ]]) {
        const assertions = new AssertionConjunction();
        for (const [ index, shape ] of order.entries()) {
          expect(shape === undefined ?
            assertions.assert(subject('o'), assertStrong(termC)) :
            assertions.assert(rootAccess('o'), assertStrong(shape))).toBe(true);
          expect(index).toBeLessThan(2);
        }
        expect(conditionOf(assertions)).toBe('FILTER ( SAMETERM( SUBJECT( ?o ) , <ex://c> ) )');
      }
    });

    it('decomposes a triple term against the shape, however often it is met', ({ expect }) => {
      const shape = DF.quad(DF.variable('a'), DF.variable('b'), DF.variable('c'));
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'o', assertStrong(shape) ],
        [ 'o', assertStrong(shape) ],
      );
      expect(conditionOf(assertions)).toBe([
        'FILTER ( ( ( SAMETERM( SUBJECT( ?o ) , ?a ) && SAMETERM( PREDICATE( ?o ) , ?b ) )',
        '&& SAMETERM( OBJECT( ?o ) , ?c ) ) )',
      ].join(' '));
      // Every component of a triple term is bound whenever the term is.
      expect([ ...assertions.boundImpliedBy() ].sort()).toEqual([ 'a', 'b', 'c', 'o' ]);
    });

    it('meets a ground triple term with a shape rather than contradicting it', ({ expect }) => {
      const ground = DF.quad(termC, DF.namedNode('ex://p'), termD);
      const assertions = <AssertionConjunction> conjunctionOf(
        [ subject('o'), assertStrong(termC) ],
        [ 'o', assertStrong(ground) ],
      );
      // Every position is decided, so the shape *is* a term again.
      expect(stateOf(assertions, 'o')).toBe('strong(<<(ex://c ex://p ex://d)>>)');
      expect(conjunctionOf([ subject('o'), assertStrong(termD) ], [ 'o', assertStrong(ground) ]))
        .toBeUndefined();
    });

    it('makes what is known of one member of a clique known of all of them', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ subject('o'), assertStrong(termC) ],
        [ 'o', assertStrong(DF.variable('x')) ],
      );
      // The shape sits on the *group*, so unifying `?o` with `?x` says it of `subject(?x)` as well - and
      // `?x` reads as the edge to the anchor of that group, which is what carries the shape.
      expect(stateOf(assertions, 'x')).toBe('strong(o)');
      expect(stateOf(assertions, 'o')).toBe('strong(triple)');
      expect(conditionOf(assertions))
        .toBe('FILTER ( ( SAMETERM( SUBJECT( ?o ) , <ex://c> ) && SAMETERM( ?x , ?o ) ) )');
      // And a term met on the position of the *other* one meets the same group.
      expect(conjunctionOf(
        [ subject('o'), assertStrong(termC) ],
        [ 'o', assertStrong(DF.variable('x')) ],
        [ subject('x'), assertStrong(termD) ],
      )).toBeUndefined();
    });

    it('contradicts a shape that holds the variable it is about', ({ expect }) => {
      // `?o ≡ <<( ?o :b :c )>>` asks for a term that holds itself.
      expect(conjunctionOf([ 'o', assertStrong(
        DF.quad(DF.variable('o'), DF.namedNode('ex://b'), termC),
      ) ])).toBeUndefined();
      expect(conjunctionOf([ object('o'), assertStrong(DF.variable('o')) ])).toBeUndefined();
    });

    it('contradicts a shape where no triple term can be', ({ expect }) => {
      // Nesting only runs down the object chain: nothing is the triple term of a subject.
      expect(conjunctionOf([{ name: 'o', positions: [ 'subject', 'object' ]}, assertStrong(termC) ]))
        .toBeUndefined();
      // And a shape is not a term of any other kind.
      expect(conjunctionOf([ 'o', assertStrong(termC) ], [ 'o', assertStrong(tripleShape) ]))
        .toBeUndefined();
      expect(conjunctionOf([ 'o', assertStrong(tripleShape) ], [ 'o', assertUnbound() ]))
        .toBeUndefined();
    });

    it('reads a whole clique of positions back through one anchor', ({ expect }) => {
      // `subject(?o)` and `object(?o)` turn out to be the same thing, which is written between them.
      const assertions = <AssertionConjunction> conjunctionOf(
        [ subject('o'), assertStrong(DF.variable('s')) ],
        [ object('o'), assertStrong(DF.variable('s')) ],
      );
      expect(conditionOf(assertions))
        .toBe('FILTER ( ( SAMETERM( SUBJECT( ?o ) , ?s ) && SAMETERM( OBJECT( ?o ) , ?s ) ) )');
    });

    it('weakens a position against a term, but never against another variable', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ subject('o'), assertStrong(termC) ],
        [ object('x'), assertStrong(DF.variable('s')) ],
        [ 'y', assertStrong(tripleShape) ],
      );
      const weakened = assertions.weakened();
      expect(conditionOf(weakened)).toBe(
        'FILTER ( ( ( ! BOUND( ?o ) || SAMETERM( SUBJECT( ?o ) , <ex://c> ) ) && ( ! BOUND( ?y ) || ISTRIPLE( ?y ) ) ) )',
      );
      // `sameTerm(object(?x), ?s)` mentions two variables: it is an edge, and edges have no weak form.
      expect(stateOf(weakened, 'x')).toBe('none');
      expect(stateOf(weakened, 's')).toBe('none');
    });

    it('empties a plan where a position can never be bound', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ subject('o'), assertStrong(DF.variable('s')) ]);
      // (FBndII) over the variable naming the position: nothing below binds `?s`.
      expect(assertions.normalisedFor(metaOf([ 'o' ], [ 'o' ]))).toBeUndefined();
      expect(assertions.normalisedFor(metaOf([ 'o', 's' ], [ 'o', 's' ]))).toBeDefined();
    });

    it('empties a plan where the operation cannot bind the variable to what its group holds', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'o', assertStrong(tripleShape) ]);
      // `?o` is a triple term, and here it can only be an IRI.
      expect(assertions.normalisedFor(rangedMeta([ 'o' ], 'o', new RangeSet([ 'NamedNode' ]))))
        .toBeUndefined();
      // The same rule reaches the plain forms: `?s ?p ?o FILTER(sameTerm(?s, "lit"))` is empty.
      const literal = <AssertionConjunction> conjunctionOf([ 's', assertStrong(DF.literal('lit')) ]);
      expect(literal.normalisedFor(rangedMeta([ 's' ], 's', subjectRange))).toBeUndefined();
    });
  });

  describe('weakening', () => {
    it('drops a clique rather than inventing a weak form of it', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'x', assertStrong(DF.variable('y')) ],
        [ 'z', assertStrong(termC) ],
        [ 'w', assertBound() ],
        [ 'v', assertUnbound() ],
      );
      const weakened = assertions.weakened();
      expect(stateOf(weakened, 'x')).toBe('none');
      expect(stateOf(weakened, 'y')).toBe('none');
      // B⟨?x⟩ weakened is `¬b ∨ b`, which is `true`, so it is dropped too.
      expect(stateOf(weakened, 'w')).toBe('none');
      expect(stateOf(weakened, 'z')).toBe('weak(ex://c)');
      expect(stateOf(weakened, 'v')).toBe('unbound');
    });
  });

  describe('what a clique entails', () => {
    it('offers `bound` of every member, the representative included', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'x', assertStrong(DF.variable('y')) ],
        [ 'z', assertWeak(termC) ],
        [ 'w', assertUnbound() ],
      );
      expect([ ...assertions.boundImpliedBy() ].sort()).toEqual([ 'x', 'y' ]);
    });
  });

  describe('normalising against an operation', () => {
    it('empties the plan on a clique member that can never be bound', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertStrong(DF.variable('y')) ]);
      expect(assertions.normalisedFor(metaOf([ 'x' ], [ 'x' ]))).toBeUndefined();
    });

    it('drops a weak member that can never be bound, leaving its group alone', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'x', assertWeak(termC) ],
        [ 'y', assertStrong(termC) ],
      );
      const normalised = assertions.normalisedFor(metaOf([ 'y' ], [ 'y' ]));
      expect(stateOf(normalised, 'x')).toBe('none');
      expect(stateOf(normalised, 'y')).toBe('strong(ex://c)');
    });

    it('empties the plan on a term outside the range the variable can take', ({ expect }) => {
      // `GRAPH ?g` narrows `?g` to a graph name, and no solution binds one to a literal.
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertStrong(DF.literal('1')) ]);
      expect(assertions.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange))).toBeUndefined();
    });

    it('keeps a term the range still admits', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertStrong(termC) ]);
      const normalised = assertions.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange));
      expect(stateOf(normalised, 'g')).toBe('strong(ex://c)');
    });

    it('keeps a BlankNode a graph may be named by, which is not the emptiness a literal is', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertStrong(DF.blankNode('b')) ]);
      const normalised = assertions.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange));
      expect(stateOf(normalised, 'g')).toBe('strong(b)');
    });

    it('collapses a weak member out of range to `!bound`, its other disjunct being false', ({ expect }) => {
      // `¬bnd(?g) ∨ ?g ≡ "1"` where `?g` can only be a graph name: the right disjunct never holds, so
      // what is left is the unbound assertion - a real constraint, where the weak one said almost nothing.
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertWeak(DF.literal('1')) ]);
      const normalised = assertions.normalisedFor(rangedMeta([], 'g', graphRange));
      expect(stateOf(normalised, 'g')).toBe('unbound');
    });

    it('leaves a weak member the range still admits weak', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertWeak(termC) ]);
      const normalised = assertions.normalisedFor(rangedMeta([], 'g', graphRange));
      expect(stateOf(normalised, 'g')).toBe('weak(ex://c)');
    });

    it('empties rather than collapses where the variable is certainly bound', ({ expect }) => {
      // `?g ∈ cVars` promotes the weak member to strong first, and a strong one out of range is empty.
      const assertions = <AssertionConjunction> conjunctionOf([ 'g', assertWeak(DF.literal('1')) ]);
      expect(assertions.normalisedFor(rangedMeta([ 'g' ], 'g', graphRange))).toBeUndefined();
    });

    it('empties the plan on a bound assertion the variable can never satisfy', ({ expect }) => {
      // In scope - an all-UNDEF VALUES column declares it - and yet never bound, so `bound(?x)` is false.
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertBound() ]);
      expect(assertions.normalisedFor(rangedMeta([], 'x', emptyRange))).toBeUndefined();
    });

    it('prunes an unbound assertion the variable can never fail', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertUnbound() ]);
      expect(stateOf(assertions.normalisedFor(rangedMeta([], 'x', emptyRange)), 'x')).toBe('none');
    });

    it('prunes a weak member the `!bound` disjunct already carries', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertWeak(termC) ]);
      expect(stateOf(assertions.normalisedFor(rangedMeta([], 'x', emptyRange)), 'x')).toBe('none');
    });

    it('promotes a weak member of a pinned group where it is certainly bound', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'x', assertWeak(termC) ],
        [ 'y', assertWeak(termC) ],
      );
      const normalised = assertions.normalisedFor(metaOf([ 'x' ], [ 'x', 'y' ]));
      expect(stateOf(normalised, 'x')).toBe('strong(ex://c)');
      expect(stateOf(normalised, 'y')).toBe('weak(ex://c)');
    });
  });

  describe('transferring a variable', () => {
    it('moves a clique membership onto the variable that carries its value', ({ expect }) => {
      // `BIND(?z AS ?t)` under A⟨?t ≡ ?y⟩: below the EXTEND `?z` is what `?t` was.
      const assertions = <AssertionConjunction> conjunctionOf([ 'y', assertStrong(DF.variable('t')) ]);
      const transferred = <AssertionConjunction> assertions.transferred('t', DF.variable('z'));
      expect(transferred.cliques()).toEqual([[ 'y', 'z' ]]);
      expect(stateOf(transferred, 't')).toBe('none');
    });

    it('moves a term onto the variable that carries its value', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf([ 't', assertStrong(termC) ]);
      expect(stateOf(assertions.transferred('t', DF.variable('z')), 'z')).toBe('strong(ex://c)');
      const conflicting = <AssertionConjunction> conjunctionOf(
        [ 't', assertStrong(termC) ],
        [ 'z', assertStrong(termD) ],
      );
      expect(conflicting.transferred('t', DF.variable('z'))).toBeUndefined();
    });

    it('pins a clique to the term that takes the place of one of its members', ({ expect }) => {
      // `BIND(:c AS ?t)` under A⟨?t ≡ ?y⟩: `?t` is `:c` above, so `?y` has to be `:c` below.
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 'y', assertStrong(DF.variable('t')) ],
        [ 'w', assertStrong(DF.variable('t')) ],
      );
      const transferred = <AssertionConjunction> assertions.transferred('t', termC);
      expect(stateOf(transferred, 'y')).toBe('strong(ex://c)');
      expect(stateOf(transferred, 'w')).toBe('strong(ex://c)');
      expect(stateOf(transferred, 't')).toBe('none');
      expect(transferred.cliques()).toEqual([]);
    });

    it('decides a term against the term the group was already pinned to', ({ expect }) => {
      const assertions = <AssertionConjunction> conjunctionOf(
        [ 't', assertStrong(termC) ],
        [ 'y', assertStrong(DF.variable('t')) ],
      );
      // `?t ≡ :c` with `?t` bound to `:c` holds, and `?y` keeps the term the group carries.
      expect(stateOf(assertions.transferred('t', termC), 'y')).toBe('strong(ex://c)');
      // `?t ≡ :c` with `?t` bound to `:d` does not.
      expect(assertions.transferred('t', termD)).toBeUndefined();
    });
  });

  it('leaves the conjunction it was cloned from untouched', ({ expect }) => {
    const assertions = <AssertionConjunction> conjunctionOf([ 'x', assertStrong(DF.variable('y')) ]);
    const copy = assertions.clone();
    expect(copy.assert(rootAccess('z'), assertStrong(DF.variable('y')))).toBe(true);
    expect(copy.cliques()).toEqual([[ 'x', 'y', 'z' ]]);
    expect(assertions.cliques()).toEqual([[ 'x', 'y' ]]);
  });
});
