import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { PreOrderMappingReturn } from '@traqula/core';
import type { TransformContext } from '../transformContext.js';
import type { Assertions, SameTermFilter, WeakSameTermFilter } from '../utils/assertions.js';
import {
  assertionsExpression,
  collectAssertions,
  isSameTermFilter,
  isWeakSameTermFilter,
  sameTermExpression,
  substituteInExpression,
  substituteInPattern,
  substituteInTerm,
  weakAssertionsExpression,
} from '../utils/assertions.js';
import type { CPMeta } from '../utils/certainlyBoundVars.js';
import { withCpVars, withoutCpVars } from '../utils/certainlyBoundVars.js';
import { createFilterFalse } from '../utils/operationhelpers.js';

/**
 * @fileoverview Assertion filter pushdown.
 *
 * An earlier rewriting stage produces queries carrying *assertion filters* of the form
 * `FILTER(sameTerm(?x, <ex://p>))` - each stating that one variable is fixed to one term. Left where
 * they are, they only discard rows at the end. Pushed down, they eliminate work: they substitute into
 * BGPs (fewer triple matches), prune VALUES rows, delete whole UNION branches, and can turn an OPTIONAL
 * into a plain join.
 *
 * We use: https://dl.acm.org/doi/pdf/10.1145/1804669.1804675
 * (Schmidt et al., "Foundations of SPARQL Query Optimization"). Rule names in parentheses refer to
 * Figure 2 of that paper. Writing A⟨?x ≡ c⟩ for `σ_{sameTerm(?x, c)}`, two properties drive the design:
 *
 * - **The assertion implies `bnd(?x)`**, so (FBndII) - `?x ∉ pVars(A) ⟹ σ_{?x≡c}(A) ≡ ∅` - is the only
 *   emptiness rule needed, and `bound(?x)` folds to `true` during substitution.
 * - **It is `sameTerm`, not `=`**, which is what makes substituting the term into a pattern sound:
 *   `?x = "01"^^xsd:integer` holds of the term `"1"^^xsd:integer`, so `=` would drop solutions.
 *
 * The pass is a pre-order traversal, so an assertion filter is handled *before* what is below it, and
 * each step only describes how the filter swaps places with the operation it sits on. The result of
 * that swap is traversed in turn, so a filter that sank into a union branch is met again there, and
 * keeps sinking on its own. What travels is the whole conjunction of assertions that still holds - a
 * {@link SameTermFilter} - so a plan with several assertions is rewritten in one traversal, and each
 * BGP is substituted into once.
 *
 * Every rewrite here preserves `pVars` exactly, never shrinks `cVars`, and preserves the multiplicity
 * of every surviving mapping. That invariant is what lets the licences be read off the metadata of the
 * operations below without recomputing anything as they are rewritten.
 */

/** Metadata is a cache to carry along, never a tree to iterate into: its sets do not survive that. */
const keepMetadata = { shallowKeys: new Set([ 'metadata' ]) };

/**
 * Pushes every assertion filter (`FILTER(sameTerm(?x, c))`) in `op` as deep as possible, and into every
 * branch that permits it - for a join, that may be both sides at once.
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The operation with all assertions pushed down
 *
 * @example
 * // Before:
 * // SELECT * WHERE { { ?s <ex://p> ?o } UNION { ?x <ex://q> ?y } FILTER(sameTerm(?s, <ex://a>)) }
 * // After (the right branch can never bind ?s, so it becomes empty):
 * // SELECT * WHERE {
 * //   { <ex://a> <ex://p> ?o BIND(<ex://a> AS ?s) } UNION { ?x <ex://q> ?y FILTER(false) }
 * // }
 */
export function pushDownAssertions<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  const callbacks: Record<string, (copy: any) => PreOrderMappingReturn> = Object.fromEntries(
    Object.values(Algebra.Types).map(type => [ type, (copy: Algebra.Operation) => keep(copy) ]),
  );
  callbacks[Algebra.Types.FILTER] = (filter: Algebra.Filter) => pushFilter(c, filter);
  // Starting from a copy without metadata gives us both a tree of our own to rewrite and the guarantee
  // that what `withCpVars` hands us describes the plan as it is now.
  return algebraUtils.mapOperationPreOrder<'unsafe', T>(withoutCpVars(op), <any> callbacks);
}

/**
 * Handles one filter met by the traversal.
 *
 * A filter carrying no assertion is left where it is, which keeps the traversal descending into it in
 * search of the ones deeper down. One that does carry assertions is split first (SDecompI): the
 * assertions travel on their own, and what is left of the condition stays on top with the assertions
 * substituted into it (FReord).
 */
function pushFilter(c: TransformContext, filter: Algebra.Filter): PreOrderMappingReturn {
  if (isSameTermFilter(c, filter)) {
    const { assertions, residual, contradictory } = filter.metadata.sameTerms;
    if (contradictory) {
      // One variable cannot be two terms at once, so nothing below this can contribute anything.
      return empty(c, filter.input);
    }
    if (residual !== undefined) {
      return keep(c.AF.createFilter(assertionFilter(c, filter.input, assertions), residual));
    }
    return pushAssertions(c, assertions, filter.input);
  }
  if (isWeakSameTermFilter(c, filter)) {
    const { assertions, residual } = filter.metadata.weakSameTerms;
    if (residual !== undefined) {
      return keep(c.AF.createFilter(weakAssertionFilter(c, filter.input, assertions), residual));
    }
    return pushWeakAssertions(c, assertions, filter.input);
  }
  return keep(filter);
}

/**
 * Swaps an assertion filter with the operation `op` right below it, per the rules of Figure 2.
 *
 * @param c - The transformation context
 * @param assertions - The assertions the filter carries (θ)
 * @param op - The operation the filter sits on
 * @returns What takes the place of the filter, and how to traverse into it
 */
function pushAssertions(c: TransformContext, assertions: Assertions, op: Algebra.Operation): PreOrderMappingReturn {
  const { AF } = c;
  const { pVars } = cpVars(op);
  // (FBndII): an assertion implies its variable is bound, so an operation that can never bind it
  // produces nothing at all. This one check replaces a per-operator emptiness rule.
  for (const name of assertions.keys()) {
    if (!pVars.has(name)) {
      return empty(c, op);
    }
  }

  switch (op.type) {
    case Algebra.Types.BGP:
      return keep(substituteIntoPatterns(c, op, op.patterns, assertions));
    case Algebra.Types.PATTERN:
      return keep(substituteIntoPatterns(c, op, [ op ], assertions));
    case Algebra.Types.PATH:
      return keep(substituteIntoPath(c, op, assertions));
    case Algebra.Types.VALUES:
      return keep(pruneValues(c, op, assertions));

    // (FUPush) holds unconditionally, so every branch gets the assertions and keeps sinking on its own.
    case Algebra.Types.UNION:
      return keep(AF.createUnion(op.input.map(branch => assertionFilter(c, branch, assertions)), false));

    case Algebra.Types.FILTER: {
      // The conjunction we manage absorbs the assertions of the filter we pass (SDecompI), and what is
      // left of its condition has ours substituted into it (FReord).
      const collected = collectAssertions(c, op.expression, assertions);
      if (collected === undefined) {
        return empty(c, op);
      }
      const below = assertionFilter(c, op.input, collected.assertions);
      return collected.residual === undefined ?
      // Nothing stays here, so the (bigger) conjunction has to be handed back to keep sinking.
          { ...keepMetadata, newValue: below, reTransform: true } :
        keep(AF.createFilter(below, collected.residual));
    }

    case Algebra.Types.EXTEND:
      return pushIntoExtend(c, op, assertions);
    case Algebra.Types.GRAPH:
      return pushIntoGraph(c, op, assertions);
    case Algebra.Types.JOIN:
      return pushIntoJoin(c, op, assertions);
    case Algebra.Types.LEFT_JOIN:
      return pushIntoLeftJoin(c, op, assertions);

    case Algebra.Types.MINUS:
      // The right hand side takes the *weak* assertion, never the strong one: `∖` is anti-monotone in
      // that argument, so dropping too much from it can only add rows to the result.
      return keep(AF.createMinus(
        assertionFilter(c, op.input[0], assertions),
        weakAssertionFilter(c, op.input[1], assertions),
      ));

    case Algebra.Types.GROUP: {
      // An assertion on a grouping key selects whole groups, which is the same as selecting the
      // solutions those groups are formed from. Anything else has to stay above: filtering before the
      // aggregation would change the aggregate.
      const keys = new Set(op.variables.map(variable => variable.value));
      const below = restrict(assertions, name => keys.has(name));
      if (below.size === 0) {
        return keep(assertionFilter(c, op, assertions));
      }
      return keep(assertionFilter(
        c,
        AF.createGroup(assertionFilter(c, op.input, below), op.variables, op.aggregates),
        restrict(assertions, name => !keys.has(name)),
      ));
    }

    // Congruence: these do not touch which variables a solution binds.
    // For the projection, dom(θ) ⊆ variables holds, since pVars of a projection is what it projects.
    case Algebra.Types.PROJECT:
      return keep(AF.createProject(assertionFilter(c, op.input, assertions), op.variables));
    case Algebra.Types.DISTINCT:
      return keep(AF.createDistinct(assertionFilter(c, op.input, assertions)));
    case Algebra.Types.REDUCED:
      return keep(AF.createReduced(assertionFilter(c, op.input, assertions)));
    case Algebra.Types.ORDER_BY:
      return keep(AF.createOrderBy(assertionFilter(c, op.input, assertions), op.expressions));
    case Algebra.Types.FROM:
      return keep(AF.createFrom(assertionFilter(c, op.input, assertions), op.default, op.named));

    default:
      // A barrier. SLICE and a GROUP over a non-key are genuine ones - filtering before a slice changes
      // which rows fall in the window, filtering before an aggregation changes the aggregate - and
      // SERVICE is one by scoping decision: pushing into it is sound, but SILENT turns endpoint failure
      // into a single empty solution, so it has to be a replication rather than a move.
      return keep(assertionFilter(c, op, assertions));
  }
}

/**
 * Substitutes the assertions into a BGP (or a bare pattern), re-binding the substituted variables.
 *
 * All variables of a BGP are certainly bound, so there is nothing to check beyond whether the terms can
 * occupy the positions they land in: no triple has a literal or a triple term as subject, predicate or
 * graph, so such a substitution makes the whole BGP match nothing.
 *
 * BGPs are duplicate-free (each triple pattern has multiplicity one, and the decomposition of a
 * solution over a join of patterns is unique), and substituting only restricts which solutions exist,
 * so multiplicities are preserved.
 */
function substituteIntoPatterns(
  c: TransformContext,
  op: Algebra.Operation,
  patterns: Algebra.Pattern[],
  assertions: Assertions,
): Algebra.Operation {
  const substituted: Algebra.Pattern[] = [];
  for (const pattern of patterns) {
    const replacement = substituteInPattern(c, pattern, assertions);
    if (replacement === undefined) {
      return emptyOperation(c, op);
    }
    substituted.push(replacement);
  }
  return bindAssertedTerms(c, c.AF.createBgp(substituted), assertions);
}

/**
 * Substitutes the assertions into a property path, re-binding the substituted variables.
 *
 * Unlike a BGP, a path may legitimately have a literal in its subject slot (`?lit ^:p ?s`), so only the
 * graph position is checked. Paths are not duplicate-free - `?x :p/:q ?y` yields one solution per
 * intermediate witness - but substituting only restricts the set of start nodes and leaves the witness
 * count of every surviving pair untouched, so multiplicities are preserved.
 */
function substituteIntoPath(c: TransformContext, path: Algebra.Path, assertions: Assertions): Algebra.Operation {
  const subject = substituteInTerm(path.subject, assertions, 'object');
  const object = substituteInTerm(path.object, assertions, 'object');
  const graph = substituteInTerm(path.graph, assertions, 'graph');
  if (subject === undefined || object === undefined || graph === undefined) {
    return emptyOperation(c, path);
  }
  return bindAssertedTerms(c, c.AF.createPath(subject, path.predicate, object, graph), assertions);
}

/**
 * Prunes the rows of a VALUES that contradict the assertions, and drops the columns they fix.
 *
 * Rows leaving an asserted column UNDEF are dropped too, because the assertion implies the variable is
 * bound - the same reason a VALUES variable is in `pVars` but only in `cVars` when every row binds it.
 * Row-level filtering keeps duplicate rows duplicated, so multiplicities are preserved.
 */
function pruneValues(c: TransformContext, values: Algebra.Values, assertions: Assertions): Algebra.Operation {
  const bindings = values.bindings.filter(binding => [ ...assertions ].every(([ name, term ]) => {
    const bound = binding[name];
    return bound !== undefined && term.equals(bound);
  }));
  if (bindings.length === 0) {
    return emptyOperation(c, values);
  }
  // A VALUES of zero columns is kept rather than replaced by an empty pattern: it still contributes one
  // solution per remaining row, and collapsing it would change those multiplicities.
  return bindAssertedTerms(c, c.AF.createValues(
    values.variables.filter(variable => !assertions.has(variable.value)),
    bindings.map(binding => Object.fromEntries(
      Object.entries(binding).filter(([ name ]) => !assertions.has(name)),
    )),
  ), assertions);
}

/**
 * Pushes the assertions through an EXTEND (BIND).
 *
 * Asserting the variable the BIND targets is the interesting case:
 * `σ_{?x≡c}(Extend(A,?x,e)) ≡ Extend(σ_{sameTerm(e,c)}(A), ?x, c)`. Both sides keep exactly the
 * solutions of `A` for which `e` evaluates to the term `c` - an error in `e` makes `sameTerm(e,c)`
 * error, which a filter treats as false, matching the dropped unbound case.
 *
 * This is deliberately not shortcut to constant folding, because the important case is *renaming*: for
 * `BIND(?z AS ?x)`, `sameTerm(?z, c)` is itself an assertion, so the conjunction continues on `?z` and
 * may reach a BGP and fire the substitution there. Assertions propagate through renamings.
 */
function pushIntoExtend(
  c: TransformContext,
  extend: Algebra.Extend,
  assertions: Assertions,
): PreOrderMappingReturn {
  const { AF } = c;
  const asserted = assertions.get(extend.variable.value);
  if (asserted === undefined) {
    return keep(AF.createExtend(
      assertionFilter(c, extend.input, assertions),
      extend.variable,
      substituteInExpression(c, extend.expression, assertions),
    ));
  }

  // SPARQL forbids BINDing an in-scope variable, so ?x is not bound below the EXTEND. It has to leave θ
  // before descending, or the (FBndII) check at the top of the swap wrongly yields empty.
  const below = new Map(restrict(assertions, name => name !== extend.variable.value));
  const expression = extend.expression;
  if (expression.subType === Algebra.ExpressionTypes.TERM) {
    const term = expression.term;
    if (term.termType === 'Variable') {
      const previous = below.get(term.value);
      if (previous !== undefined && !previous.equals(asserted)) {
        return empty(c, extend);
      }
      below.set(term.value, asserted);
      // ?z ≡ c holds below, so binding ?x straight to c is the same as binding it to ?z.
      return keep(AF.createExtend(
        assertionFilter(c, extend.input, below),
        extend.variable,
        AF.createTermExpression(asserted),
      ));
    }
    // A constant BIND decides the assertion statically.
    return term.equals(asserted) ?
      keep(AF.createExtend(assertionFilter(c, extend.input, below), extend.variable, expression)) :
      empty(c, extend);
  }
  // For a compound expression, `sameTerm(e, c)` is a multi-variable condition: it needs the full
  // (FJPush) side condition quantified over vars(e), not the single variable licence this pass uses,
  // so it is left here for a generic filter pushdown.
  return keep(AF.createExtend(
    AF.createFilter(
      assertionFilter(c, extend.input, below),
      sameTermExpression(c, substituteInExpression(c, expression, below), asserted),
    ),
    extend.variable,
    AF.createTermExpression(asserted),
  ));
}

/**
 * Pushes the assertions through a GRAPH, which is transparent rather than a barrier.
 *
 * With `Graph(?g,P) ≡ ⋃_{(uᵢ,Gᵢ) ∈ named} ( ⟦P⟧_{Gᵢ} ⋈ {?g↦uᵢ} )`, an assertion on a variable other
 * than `?g` distributes over that union by (FUPush) and then into the left argument of each join by
 * (FJPush) - licensed by the *second* disjunct of the licence, since `?x ∉ pVars({?g↦uᵢ}) = {?g}`. No
 * precondition survives, so that push is unconditional.
 *
 * An assertion on `?g` itself selects the single named graph `c`. If `c` is not an IRI nothing matches,
 * since graph names are IRIs. Otherwise the EXTEND is mandatory for the same reason as in the BGP case:
 * without it `?g` would leave `pVars`/`cVars` and break the invariant.
 */
function pushIntoGraph(c: TransformContext, graph: Algebra.Graph, assertions: Assertions): PreOrderMappingReturn {
  const { AF } = c;
  const name = graph.name;
  const asserted = name.termType === 'Variable' ? assertions.get(name.value) : undefined;
  if (asserted === undefined) {
    return keep(AF.createGraph(assertionFilter(c, graph.input, assertions), name));
  }
  if (asserted.termType !== 'NamedNode') {
    return empty(c, graph);
  }
  const below = restrict(assertions, other => other !== name.value);
  return keep(bindAssertedTerms(
    c,
    AF.createGraph(assertionFilter(c, graph.input, below), asserted),
    new Map([[ name.value, asserted ]]),
  ));
}

/**
 * Pushes the assertions into the operands of a JOIN their licence holds for (FJPush).
 *
 * Specialised to a single variable, that licence is `L(?x, A₁, A₂) ≔ ?x ∈ cVars(A₁) ∨ ?x ∉ pVars(A₂)`.
 * The second disjunct is easy to forget and does a lot of work: it is what gets an assertion on a
 * union variable below the join, after which (FUPush) reaches the branches and (FBndII) prunes them.
 *
 * An assertion goes into *every* operand it is licensed for - the join already enforces that all
 * operands agree on the variable, so an assertion certain on one side is free on the others and shrinks
 * both inputs. That is sideways information passing rather than a push. What no operand is licensed for
 * stays in a filter on top of the join.
 */
function pushIntoJoin(c: TransformContext, join: Algebra.Join, assertions: Assertions): PreOrderMappingReturn {
  // Read before any rewriting: every rewrite preserves pVars and never shrinks cVars, so these licences
  // stay valid while the operands are rewritten.
  const operands = join.input.map(operand => cpVars(operand));

  const perOperand = join.input.map(() => new Map<string, RDF.Term>());
  const kept = new Map(assertions);
  for (const [ name, term ] of assertions) {
    for (const [ index ] of join.input.entries()) {
      // L(?x, operand, rest): certain in this operand, or impossible in every other one.
      if (operands[index].cVars.has(name) ||
        operands.every((other, otherIndex) => otherIndex === index || !other.pVars.has(name))) {
        perOperand[index].set(name, term);
        kept.delete(name);
      }
    }
  }

  return keep(assertionFilter(
    c,
    c.AF.createJoin(join.input.map((operand, index) => assertionFilter(c, operand, perOperand[index])), false),
    kept,
  ));
}

/**
 * Pushes the assertions into a LEFT JOIN (OPTIONAL).
 *
 * The structural win comes first: `?x ∉ pVars(A₁) ⟹ σ_{?x≡c}(A₁ ⟕ A₂) ≡ A₁ ⋈ σ_{?x≡c}(A₂)`. Since
 * `A₁ ⟕ A₂ ≡ (A₁ ⋈ A₂) ∪ (A₁ ∖ A₂)` and `pVars(A₁ ∖ A₂) = pVars(A₁) ∌ ?x`, the anti-join branch dies
 * by (FBndII), and the surviving join is licensed on the right because `?x ∉ pVars(A₁)` satisfies
 * `L(?x, A₂, A₁)`. So **asserting on an optional-only variable turns OPTIONAL into a join**, which
 * additionally unlocks reordering and the substitution underneath. This generalises the paper's
 * (FLBndII) from `bnd(?x)` to `?x ≡ c`.
 *
 * Otherwise (FLPush) sends the licensed assertions into `A₁`, and `?x ∈ cVars(A₁) ∩ cVars(A₂)`
 * additionally licenses replicating into `A₂`: any `μ₂` compatible with a surviving `μ₁` binds `?x`
 * (certain) to `c`, so the pruned rows of `A₂` never removed anything.
 */
function pushIntoLeftJoin(
  c: TransformContext,
  leftJoin: Algebra.LeftJoin,
  assertions: Assertions,
): PreOrderMappingReturn {
  const { AF } = c;
  const [ left, right ] = leftJoin.input;
  const leftVars = cpVars(left);

  if ([ ...assertions.keys() ].some(name => !leftVars.pVars.has(name))) {
    // With a left join condition R: `LeftJoin(A₁,A₂,R) ≡ σ_R(A₁ ⋈ A₂) ∪ (A₁ ∖_R A₂)`, so the same
    // argument leaves `σ_θ(σ_R(A₁ ⋈ A₂))`, which the conjunction is handed back to sink into.
    const joined = AF.createJoin([ left, right ], false);
    const rebuilt = leftJoin.expression === undefined ? joined : AF.createFilter(joined, leftJoin.expression);
    return { ...keepMetadata, newValue: assertionFilter(c, rebuilt, assertions), reTransform: true };
  }

  const rightVars = cpVars(right);
  const intoLeft = new Map<string, RDF.Term>();
  const intoRight = new Map<string, RDF.Term>();
  const kept = new Map<string, RDF.Term>();
  for (const [ name, term ] of assertions) {
    if (leftVars.cVars.has(name) || !rightVars.pVars.has(name)) {
      intoLeft.set(name, term);
      if (leftVars.cVars.has(name) && rightVars.cVars.has(name)) {
        intoRight.set(name, term);
      }
    } else {
      kept.set(name, term);
    }
  }

  // Every candidate μ₁ binds the variables of intoLeft to their term once those are pushed into A₁, so
  // substituting them into the left join condition is sound.
  const expression = leftJoin.expression === undefined ?
    undefined :
    substituteInExpression(c, leftJoin.expression, intoLeft);
  return keep(assertionFilter(
    c,
    AF.createLeftJoin(assertionFilter(c, left, intoLeft), assertionFilter(c, right, intoRight), expression),
    kept,
  ));
}

/**
 * Swaps a *weak* assertion filter - W⟨?x ≡ c⟩ ≔ `!bound(?x) || sameTerm(?x, c)` - with the operation
 * below it.
 *
 * The weak form is what the right hand side of a MINUS takes:
 * `σ_{?x≡c}(A₁ ∖ A₂) ≡ σ_{?x≡c}(A₁) ∖ σ_W(A₂)`. This is not a filter push - `∖` is anti-monotone in
 * its right argument, so shrinking `A₂` can only *grow* the result. It is sound because a row `μ₂` the
 * pruning removes either binds `?x` to something other than `c`, making it incompatible with every
 * survivor of `σ_{?x≡c}(A₁)` and so excluding nothing, or it leaves `?x` unbound - which is exactly the
 * case the `!bound` disjunct keeps.
 *
 * W collapses on arrival: where `?x ∈ cVars` it *is* the strong assertion (so the BGP and VALUES
 * rewrites fire), and where `?x ∉ pVars` it is `true` and is **dropped** - not turned into the empty
 * result, which would silently delete results.
 */
function pushWeakAssertions(
  c: TransformContext,
  assertions: Assertions,
  op: Algebra.Operation,
): PreOrderMappingReturn {
  const { AF } = c;
  const { cVars, pVars } = cpVars(op);
  // Trap: a variable that cannot be bound here makes W `true`, never empty.
  const relevant = restrict(assertions, name => pVars.has(name));
  if (relevant.size === 0) {
    return keep(op);
  }
  const weak = restrict(relevant, name => !cVars.has(name));
  if (weak.size === 0) {
    // Every remaining variable is certainly bound here, so `!bound(?x)` is unsatisfiable and the weak
    // assertion *is* the strong one. Hand it back as such.
    return { ...keepMetadata, newValue: assertionFilter(c, op, relevant), reTransform: true };
  }
  const strong = restrict(relevant, name => cVars.has(name));

  switch (op.type) {
    // `σ_W(A₁ ⋈ A₂) ≡ σ_W(A₁) ⋈ σ_W(A₂)` and the same for a union: a compatible pair satisfies W
    // exactly when both of its halves do. Every operand re-classifies what is weak and what is strong.
    case Algebra.Types.UNION:
      return keep(AF.createUnion(op.input.map(branch => weakAssertionFilter(c, branch, relevant)), false));
    case Algebra.Types.JOIN:
      return keep(AF.createJoin(op.input.map(operand => weakAssertionFilter(c, operand, relevant)), false));

    // A row of the left argument violating W can only produce output violating W, in both the join and
    // the anti-join half of a left join. The outer filter has to stay though: the right argument can
    // still introduce a binding violating W, which a moved filter would no longer discard.
    case Algebra.Types.LEFT_JOIN:
      return keep(weakAssertionFilter(c, AF.createLeftJoin(
        weakAssertionFilter(c, op.input[0], relevant),
        op.input[1],
        op.expression,
      ), weak));
    case Algebra.Types.MINUS:
      return keep(AF.createMinus(weakAssertionFilter(c, op.input[0], relevant), op.input[1]));

    // Two selections commute; the condition is *not* substituted into, since W does not guarantee the
    // variable is bound to the term - it may not be bound at all.
    case Algebra.Types.FILTER:
      return {
        ...keepMetadata,
        newValue: AF.createFilter(weakAssertionFilter(c, op.input, relevant), op.expression),
        // Hand the filter we passed back so its own assertions are pushed in turn. Not when it is a
        // weak one itself: two weak filters would swap places forever.
        reTransform: !isWeakSameTermFilter(c, op),
      };
    case Algebra.Types.PROJECT:
      return keep(AF.createProject(weakAssertionFilter(c, op.input, relevant), op.variables));
    case Algebra.Types.DISTINCT:
      return keep(AF.createDistinct(weakAssertionFilter(c, op.input, relevant)));
    case Algebra.Types.REDUCED:
      return keep(AF.createReduced(weakAssertionFilter(c, op.input, relevant)));
    case Algebra.Types.ORDER_BY:
      return keep(AF.createOrderBy(weakAssertionFilter(c, op.input, relevant), op.expressions));
    case Algebra.Types.FROM:
      return keep(AF.createFrom(weakAssertionFilter(c, op.input, relevant), op.default, op.named));

    case Algebra.Types.EXTEND: {
      // The target variable does not exist below the EXTEND, so its weak assertion stays here.
      const target = op.variable.value;
      return keep(weakAssertionFilter(c, AF.createExtend(
        weakAssertionFilter(c, op.input, restrict(relevant, name => name !== target)),
        op.variable,
        op.expression,
      ), restrict(relevant, name => name === target)));
    }
    case Algebra.Types.GRAPH: {
      const graphVar = op.name.termType === 'Variable' ? op.name.value : undefined;
      return keep(weakAssertionFilter(c, AF.createGraph(
        weakAssertionFilter(c, op.input, restrict(relevant, name => name !== graphVar)),
        op.name,
      ), restrict(relevant, name => name === graphVar)));
    }
    case Algebra.Types.VALUES: {
      // Row-level W: a row keeps a column that is UNDEF, and drops one holding another term.
      const bindings = op.bindings.filter(binding => [ ...weak ].every(([ name, term ]) => {
        const bound = binding[name];
        return bound === undefined || term.equals(bound);
      }));
      if (bindings.length === 0) {
        return empty(c, op);
      }
      const pruned = AF.createValues(op.variables, bindings);
      return strong.size === 0 ?
        keep(pruned) :
          { ...keepMetadata, newValue: assertionFilter(c, pruned, strong), reTransform: true };
    }
    default:
      // A barrier: what collapsed to the strong assertion is still pushed, the rest stays on top.
      return keep(weakAssertionFilter(c, assertionFilter(c, op, strong), weak));
  }
}

/** The certainly and possibly bound variables of an operation, computed once and cached on it. */
function cpVars(op: Algebra.Operation): CPMeta {
  return withCpVars(op).metadata;
}

/** The assertions of `assertions` whose variable satisfies `predicate`. */
function restrict(assertions: Assertions, predicate: (name: string) => boolean): Map<string, RDF.Term> {
  return new Map([ ...assertions ].filter(([ name ]) => predicate(name)));
}

/** Hands a value to the traversal, keeping the metadata of everything in it intact. */
function keep(newValue: Algebra.Operation): PreOrderMappingReturn {
  return { ...keepMetadata, newValue };
}

/**
 * Replaces an operation the assertions rule out by the empty solution multiset, and stops the
 * traversal from descending into what it replaced - nothing under it can contribute anything.
 */
function empty(c: TransformContext, replaced: Algebra.Operation): PreOrderMappingReturn {
  return { ...keepMetadata, newValue: emptyOperation(c, replaced), continue: false };
}

/**
 * Builds the empty solution multiset that replaces an operation the assertions rule out.
 *
 * `FILTER(FALSE)` is this codebase's empty operation ({@link createFilterFalse}). Keeping the replaced
 * operation as its input is what makes the node carry the `pVars` of what it replaced, as the invariant
 * requires: `pVars(Empty_S) := S`, never `∅`, or `SELECT *` scoping and the in-scope variable set
 * change silently. {@link transformFilterFalse} does the structural normalisation afterwards
 * (`Empty ∪ A ≡ A`, `Empty ⋈ A ≡ Empty`, ...).
 */
function emptyOperation(c: TransformContext, replaced: Algebra.Operation): Algebra.Operation {
  return createFilterFalse(c, replaced);
}

/**
 * Re-binds the variables the assertions substituted away, so that the rewrite preserves `pVars` and
 * `cVars` exactly. This EXTEND is mandatory: dropping it breaks the invariant, and breaks `SELECT *`.
 */
function bindAssertedTerms(
  c: TransformContext,
  op: Algebra.Operation,
  assertions: Assertions,
): Algebra.Operation {
  let result = op;
  for (const [ name, term ] of assertions) {
    result = c.AF.createExtend(result, c.DF.variable(name), c.AF.createTermExpression(term));
  }
  return result;
}

/**
 * The assertion filter A⟨θ⟩ over `op`, carrying the conjunction it stands for as its metadata so that
 * the traversal does not have to read it back out of the condition it builds.
 */
function assertionFilter(c: TransformContext, op: Algebra.Operation, assertions: Assertions): Algebra.Operation {
  if (assertions.size === 0) {
    return op;
  }
  const filter = <SameTermFilter> c.AF.createFilter(op, assertionsExpression(c, assertions));
  filter.metadata = { sameTerms: { assertions, residual: undefined, contradictory: false }};
  return filter;
}

/** The weak assertion filter W⟨θ⟩ over `op`, carrying the conjunction it stands for as its metadata. */
function weakAssertionFilter(
  c: TransformContext,
  op: Algebra.Operation,
  assertions: Assertions,
): Algebra.Operation {
  if (assertions.size === 0) {
    return op;
  }
  const filter = <WeakSameTermFilter> c.AF.createFilter(op, weakAssertionsExpression(c, assertions));
  filter.metadata = { weakSameTerms: { assertions, residual: undefined }};
  return filter;
}
