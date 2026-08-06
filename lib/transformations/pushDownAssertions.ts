import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { PreOrderMappingReturn } from '@traqula/core';
import type { TransformContext } from '../transformContext.js';
import type {
  Assertion,
  AssertionConjunction,
  AssertionFilter,
  Assertions,
  StrongAssertion,
} from '../utils/assertions.js';
import {
  assertionsExpression,
  assertStrong,
  assertWeak,
  collectAssertions,
  impliesBound,
  isAssertableTerm,
  isAssertionFilter,
  mergeAssertion,
  strongTermsOf,
  substituteInPattern,
  substituteInTerm,
} from '../utils/assertions.js';
import type { CPMeta } from '../utils/certainlyBoundVars.js';
import { withCpVars, withoutCpVars } from '../utils/certainlyBoundVars.js';
import { sameTermExpression } from '../utils/expressionHelpers.js';
import { createFilterFalse } from '../utils/operationhelpers.js';
import { substituteInExpression } from '../utils/partialExpressionEvaluation.js';

/**
 * @fileoverview Assertion filter pushdown.
 *
 * An earlier rewriting stage produces queries carrying *assertion filters* of the form
 * `FILTER(sameTerm(?x, <ex://p>))` - each stating that one variable is fixed to one term. Left where
 * they are, they only discard rows at the end. Pushed down, they eliminate work: they substitute into
 * BGPs (fewer triple matches), prune VALUES rows, delete whole UNION branches, and can turn an OPTIONAL
 * into a plain join.
 *
 * Rule names in parentheses refer to Figure 2 of Schmidt et al., "Foundations of SPARQL Query
 * Optimization" (https://dl.acm.org/doi/pdf/10.1145/1804669.1804675). Writing A⟨?x ≡ c⟩ for
 * `σ_{sameTerm(?x, c)}`, two properties drive the design:
 *
 * - **The assertion implies `bnd(?x)`**, so (FBndII) - `?x ∉ pVars(A) ⟹ σ_{?x≡c}(A) ≡ ∅` - is the only
 *   emptiness rule needed, and `bound(?x)` folds to `true` during substitution.
 * - **It is `sameTerm`, not `=`**, which is what makes substituting the term into a pattern sound:
 *   `?x = "01"^^xsd:integer` holds of the term `"1"^^xsd:integer`, so `=` would drop solutions. An `=`
 *   against an IRI is the one exception - `=` only raises a type error when both arguments are literals,
 *   so against an IRI it *is* `sameTerm` - and it travels as an assertion.
 *
 * Assertions travel in four forms - strong, weak, unbound and bound, see {@link Assertion} - all in the
 * *same* conjunction ({@link AssertionConjunction}) and handled by the same swap, since their rules differ
 * per operation rather than per pass, and one variable's assertion may be strong while another's is not.
 * {@link normalise} converts between them at every step.
 *
 * The bound form, `FILTER(bound(?x))`, is the one that fixes no term. It moves for two reasons: it decides
 * the same emptiness and structural rules the strong form does - which is what turns an OPTIONAL binding
 * `?x` into a plain join - and it *completes* a weak assertion it meets on the way into a strong one.
 *
 * The pass is a pre-order traversal, so an assertion filter is handled *before* what is below it, and
 * each step only describes how the filter swaps places with the operation it sits on. The result of that
 * swap is traversed in turn, so a filter that sank into a union branch is met again there and keeps
 * sinking on its own. What travels is the whole conjunction that still holds - an {@link AssertionFilter}
 * - so a plan with several assertions is rewritten in one traversal, substituting into each BGP once. A
 * filter the conjunction passes is *absorbed* into it rather than swapped with, which is what keeps
 * re-running the pass from stacking a second copy of what it derived.
 *
 * Every rewrite here preserves `pVars` exactly, never shrinks `cVars`, and preserves the multiplicity of
 * every surviving mapping. That invariant is what lets the licences be read off the metadata of the
 * operations below without recomputing anything as they are rewritten.
 */

/** Metadata is a cache to carry along, never a tree to iterate into: its sets do not survive that. */
const keepMetadata = { shallowKeys: new Set([ 'metadata' ]) };

/**
 * Pushes every assertion filter (`FILTER(sameTerm(?x, c))`) in `op` as deep as possible, and into every
 * branch that permits it - for a join, that may be both sides at once.
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
 * Handles one filter met by the traversal. One carrying assertions is split first (SDecompI): the
 * assertions travel on their own, and what is left of the condition stays on top with the strong ones
 * substituted into it (FReord).
 */
function pushFilter(c: TransformContext, filter: Algebra.Filter): PreOrderMappingReturn {
  if (!isAssertionFilter(c, filter)) {
    return keep(filter);
  }
  const { assertions, residual, contradictory } = filter.metadata.assertions;
  if (contradictory) {
    // One variable cannot be two terms at once, so nothing below this can contribute anything.
    return empty(c, filter.input);
  }
  if (residual !== undefined) {
    // Leave behind the residual, we continue with remaining
    return keep(c.AF.createFilter(assertionFilter(c, filter.input, assertions), residual));
  }
  return pushAssertions(c, assertions, filter.input);
}

/** Swaps an assertion filter carrying θ with the operation `op` right below it, per Figure 2. */
function pushAssertions(
  c: TransformContext,
  assertions: AssertionConjunction,
  op: Algebra.Operation,
): PreOrderMappingReturn {
  const normalised = normalise(assertions, op);
  if (normalised === undefined) {
    return empty(c, op);
  }
  if (normalised.size === 0) {
    return keep(op);
  }
  return swapWith(c, normalised, op);
}

/**
 * Reads the conjunction in terms of what `op` binds - e.g. promoting a weak assertion over a cVar to a
 * strong one - or `undefined` when it makes `op` empty.
 *
 * Where `?x` is certainly bound, `!bound(?x)` is unsatisfiable, so W *is* A, B is `true` and U is empty;
 * where `?x` can never be bound, A and B are empty and W and U are simply `true`.
 */
function normalise(assertions: AssertionConjunction, op: Algebra.Operation): Map<string, Assertion> | undefined {
  const { cVars, pVars } = cpVars(op);
  const normalised = new Map<string, Assertion>();
  for (const [ name, assertion ] of assertions) {
    if (!pVars.has(name)) {
      // (FBndII), which both of the forms implying `bound(?x)` trigger.
      if (impliesBound(assertion)) {
        return undefined;
      }
      // Not in pvars and weak or undef -> nothing to assert
    } else if (cVars.has(name)) {
      if (assertion.subType === 'unbound') {
        return undefined;
      }
      // B⟨?x⟩ holds of every solution here.
      if (assertion.subType !== 'bound') {
        normalised.set(name, assertStrong(assertion.term));
      }
    } else {
      normalised.set(name, assertion);
    }
  }
  return normalised;
}

/**
 * The rule per operation, for a conjunction {@link normalise} has already read in terms of that operation.
 *
 * Wherever the weak form is licensed, an assertion that cannot travel strongly is *demoted* rather than
 * left behind - that is the difference between reaching a BGP and stopping at the join above it. Only
 * where no form may pass does it stay on top. The unbound and bound forms have nothing below them to
 * demote to, so they either pass as themselves or stay.
 */
function swapWith(
  c: TransformContext,
  assertions: AssertionConjunction,
  op: Algebra.Operation,
): PreOrderMappingReturn {
  const { AF } = c;
  switch (op.type) {
    // A BGP and a path bind all of their variables, so normalisation has made every assertion that reaches them strong.
    case Algebra.Types.BGP: {
      return keep(substituteIntoPatterns(c, op, strongTermsOf(assertions)));
    }
    case Algebra.Types.PATH: {
      return keep(substituteIntoPath(c, op, strongTermsOf(assertions)));
    }
    // The one leaf where all four forms do real work, since a VALUES column may be UNDEF.
    case Algebra.Types.VALUES: {
      return keep(pruneValues(c, op, assertions));
    }

    // (FUPush) holds unconditionally for every form - a solution of a union comes from exactly one
    // branch - so every branch gets the conjunction and keeps sinking on its own.
    case Algebra.Types.UNION: {
      return keep(AF.createUnion(op.input.map(branch => assertionFilter(c, branch, assertions)), false));
    }
    case Algebra.Types.FILTER: {
      // The conjunction we manage absorbs the assertions of the filter we pass (SDecompI),
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
    case Algebra.Types.EXTEND: {
      return pushIntoExtend(c, op, assertions);
    }
    case Algebra.Types.GRAPH: {
      return pushIntoGraph(c, op, assertions);
    }
    case Algebra.Types.JOIN: {
      return pushIntoJoin(c, c.AF.createJoin(op.input, true), assertions);
    }
    case Algebra.Types.LEFT_JOIN: {
      return pushIntoLeftJoin(c, op, assertions);
    }
    case Algebra.Types.MINUS: {
      // A mapping μ ∈ LHS is removed if:
      // ∃ μ' ∈ RHS . (μ and μ' are compatible) && (dom(μ) and dom(μ') are not disjoint)
      const [ left, right ] = op.input;
      return keep(AF.createMinus(
        // FMPush: the output is a subset of the LHS, so filtering it here is filtering the output.
        assertionFilter(c, left, assertions),
        // The RHS takes the *weak* form of what we know strongly, and nothing of what we know in any
        // other form. Since we know from the LHS that `sameTerm(?x, c)`, the RHS can only remove
        // mappings of the LHS if either ?x is not bound there, or it is bound to c - any other RHS
        // mapping is incompatible and so removes nothing anyway. That argument needs the LHS to *have*
        // ?x bound, which is exactly what the weak and unbound forms do not give us: under those, an
        // RHS mapping binding ?x to another term can still remove an LHS mapping that leaves it free.
        assertionFilter(c, right, allWeakened(strongOf(assertions))),
      ));
    }
    case Algebra.Types.GROUP: {
      // An assertion on a grouping key selects whole groups, which is the same as selecting the
      // solutions those groups are formed from - including, for the weak and unbound forms, the group
      // the solutions leaving the key unbound form, which is exactly the group the strong and bound
      // forms rule out. Anything else has to stay above: filtering before
      // the aggregation would change the aggregate. A key takes its `pVars` from the input, so an
      // unbound assertion pushed below still takes the variable out of scope, as it did on top.
      const groupsOn = new Set(op.variables.map(variable => variable.value));
      const groupsWeAssert = restrict(assertions, name => groupsOn.has(name));
      if (groupsWeAssert.size === 0) {
        return keep(assertionFilter(c, op, assertions));
      }
      return keep(assertionFilter(
        c,
        AF.createGroup(assertionFilter(c, op.input, groupsWeAssert), op.variables, op.aggregates),
        restrict(assertions, name => !groupsOn.has(name)),
      ));
    }
    // Congruence: these do not touch which variables a solution binds.
    // For the projection, dom(θ) ⊆ variables holds, since pVars of a projection is what it projects.
    case Algebra.Types.PROJECT: {
      // Can push since we know we are projected. (by pvars checks)
      return keep(AF.createProject(assertionFilter(c, op.input, assertions), op.variables));
    }
    case Algebra.Types.DISTINCT: {
      return keep(AF.createDistinct(assertionFilter(c, op.input, assertions)));
    }
    case Algebra.Types.REDUCED: {
      return keep(AF.createReduced(assertionFilter(c, op.input, assertions)));
    }
    case Algebra.Types.ORDER_BY: {
      return keep(AF.createOrderBy(assertionFilter(c, op.input, assertions), op.expressions));
    }
    case Algebra.Types.FROM: {
      return keep(AF.createFrom(assertionFilter(c, op.input, assertions), op.default, op.named));
    }
    default: {
      // A barrier. SLICE and a GROUP over a non-key are genuine ones - filtering before a slice changes
      // which rows fall in the window, filtering before an aggregation changes the aggregate - and
      // SERVICE is one by scoping decision: pushing into it is sound, but SILENT turns endpoint failure
      // into a single empty solution, so it has to be a replication rather than a move.
      return keep(assertionFilter(c, op, assertions));
    }
  }
}

/**
 * Substitutes the assertions into a BGP, re-binding the substituted variables.
 *
 * All variables of a BGP are certainly bound, so the only thing left to check is whether the terms can
 * occupy the positions they land in. BGPs are duplicate-free and substituting only restricts which
 * solutions exist, so multiplicities are preserved.
 */
function substituteIntoPatterns(
  c: TransformContext,
  op: Algebra.Bgp,
  assertions: Assertions,
): Algebra.Operation {
  const substituted: Algebra.Pattern[] = [];
  for (const pattern of op.patterns) {
    const replacement = substituteInPattern(c, pattern, assertions);
    if (replacement === undefined) {
      // Empty when e.g. pushing literal in subject position
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
 * graph position is checked. Paths are not duplicate-free, but substituting only restricts the set of
 * start nodes and leaves the witness count of every surviving pair untouched.
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
 * Prunes the rows of a VALUES that contradict the assertions, and drops the columns they decide.
 *
 * Row-level filtering keeps duplicate rows duplicated, so multiplicities are preserved.
 */
function pruneValues(c: TransformContext, values: Algebra.Values, assertions: AssertionConjunction): Algebra.Operation {
  const strongAssertions = strongTermsOf(assertions);
  // The forms that require the row to provide a value at all, counted so that a row leaving one of them
  // UNDEF - which a row expresses by not carrying the column - is pruned below.
  const requiredBound = [ ...assertions ].filter(([ , assertion ]) => impliesBound(assertion)).length;
  const newBindings: Algebra.Values['bindings'] = [];
  for (const binding of values.bindings) {
    const newRow: typeof newBindings[0] = {};
    let isPruned = false;
    let metRequiredBound = 0;
    for (const [ variable, value ] of Object.entries(binding)) {
      const assertion = assertions.get(variable);
      if (assertion === undefined) {
        // We do not assert on this var
        newRow[variable] = value;
      } else if (assertion.subType === 'unbound' && value !== undefined) {
        // The row binds a column that has to be unbound.
        isPruned = true;
        break;
      } else if (assertion.subType === 'bound') {
        // Any value satisfies B⟨?x⟩, and since the row keeps deciding which one, the column stays.
        metRequiredBound++;
        newRow[variable] = value;
      } else if (assertion.subType !== 'unbound' && !assertion.term.equals(value)) {
        // The row binds a column to a term not allowed.
        isPruned = true;
        break;
      } else if (assertion.subType === 'weak') {
        // Weak and term val is correct
        newRow[variable] = value;
      } else if (assertion.subType === 'strong') {
        metRequiredBound++;
      }
    }
    // Also prune rows that left a variable required to be bound UNDEF.
    if (!isPruned && metRequiredBound === requiredBound) {
      newBindings.push(newRow);
    }
  }
  // Zero rows means empty sequence which we write as the empty operation.
  if (newBindings.length === 0) {
    return emptyOperation(c, values);
  }
  // Zero columns is allowed: `VALUES () { () () () }` - it contributes one empty solution mapping per
  // row. With exactly one row that is the same as the empty BGP.
  const remainingVars = values.variables.filter((variable) => {
    const decided = assertions.get(variable.value)?.subType;
    return decided !== 'strong' && decided !== 'unbound';
  });
  const pruned = remainingVars.length === 0 && newBindings.length === 1 ?
    c.AF.createBgp([]) :
    c.AF.createValues(remainingVars, newBindings);
  return bindAssertedTerms(c, pruned, strongAssertions);
}

/**
 * Pushes the assertions through an EXTEND (BIND).
 *
 * Asserting the variable the BIND targets is the interesting case:
 * `σ_{?x≡c}(Extend(A,?x,e)) ≡ Extend(σ_{sameTerm(e,c)}(A), ?x, c)`. Both sides keep exactly the solutions
 * of `A` for which `e` evaluates to `c` - an error in `e` makes `sameTerm(e,c)` error, which a filter
 * treats as false, matching the dropped unbound case.
 *
 * This is deliberately not shortcut to constant folding, because the important case is *renaming*: for
 * `BIND(?z AS ?x)`, `sameTerm(?z, c)` is itself an assertion, so the conjunction continues on `?z` and
 * may reach a BGP. Assertions propagate through renamings.
 *
 * Only the strong form does any of that. W⟨?x ≡ c⟩ on the BIND target is also satisfied by the solutions
 * where `e` errored and left `?x` unbound, so it says nothing about `e` and stays above the EXTEND.
 */
function pushIntoExtend(
  c: TransformContext,
  extend: Algebra.Extend,
  assertions: AssertionConjunction,
): PreOrderMappingReturn {
  const { AF } = c;
  const target = extend.variable.value;
  const assertionOfTarget = assertions.get(target);
  // SPARQL spec keeps BINDing an in-scope variable explicitly undefined. We assume it errors,
  // so in `bind(e AS ?x)` ?x is not bound below the EXTEND.It has to leave θ before descending,
  // or the (FBndII) check at the top of the swap wrongly yields empty.
  const remainingAssertions = restrict(assertions, name => name !== target);

  if (assertionOfTarget?.subType !== 'strong') {
    // A weak or unbound assertion: keep target filter here, push remainder
    return keep(assertionFilter(
      c,
      AF.createExtend(
        assertionFilter(c, extend.input, remainingAssertions),
        extend.variable,
        substituteInExpression(c, extend.expression, strongTermsOf(remainingAssertions)),
      ),
      restrict(assertions, name => name === target),
    ));
  }

  // We know we have a strong target assertion

  // Check whether we can link the assertion on our var to the vars used in the expression
  // TODO(next time): here is where restrictions on triple terms could be transferred.
  const expression = extend.expression;
  if (expression.subType === Algebra.ExpressionTypes.TERM) {
    const term = expression.term;
    if (term.termType === 'Variable') {
      // Binding to a var means the var has the same term restriction
      const merged = mergeAssertion(remainingAssertions.get(term.value), assertStrong(assertionOfTarget.term));
      if (merged === undefined) {
        return empty(c, extend);
      }
      remainingAssertions.set(term.value, merged);
      // ?z ≡ c holds below, so binding ?x straight to c is the same as binding it to ?z.
      return keep(AF.createExtend(
        assertionFilter(c, extend.input, remainingAssertions),
        extend.variable,
        AF.createTermExpression(assertionOfTarget.term),
      ));
    }
    // A constant BIND decides the assertion statically.
    if (isAssertableTerm(term)) {
      return term.equals(assertionOfTarget.term) ?
        keep(AF.createExtend(
          assertionFilter(c, extend.input, remainingAssertions),
          extend.variable,
          AF.createTermExpression(assertionOfTarget.term),
        )) :
        empty(c, extend);
    }
  }

  // For a compound expression, `sameTerm(e, c)` is a multi-variable condition: it needs the full
  // (FJPush) side condition quantified over vars(e), not the single variable licence this pass uses,
  // so it is left here for a generic filter pushdown.
  return keep(AF.createExtend(
    AF.createFilter(
      assertionFilter(c, extend.input, remainingAssertions),
      sameTermExpression(
        c,
        substituteInExpression(c, expression, strongTermsOf(remainingAssertions)),
        assertionOfTarget.term,
      ),
    ),
    extend.variable,
    AF.createTermExpression(assertionOfTarget.term),
  ));
}

/**
 * Pushes the assertions through a GRAPH, which is transparent rather than a barrier.
 *
 * SPARQL evaluates it as a union over the named graphs, each joined with the binding of the graph
 * variable (§18.5): `Graph(?g,P) ≡ ⋃_{(uᵢ,Gᵢ) ∈ named} ( ⟦P⟧_{Gᵢ} ⋈ {?g↦uᵢ} )`, and every rule below is
 * read off that.
 *
 * An assertion on a variable other than `?g` distributes over the union by (FUPush) and then into the
 * left argument of each join by (FJPush), licensed by the *second* disjunct since
 * `?x ∉ pVars({?g↦uᵢ}) = {?g}`. That leaves no precondition, and holds for all four forms alike - so a
 * conjunction saying nothing about `?g`, which is the common case, travels into `P` whole and leaves the
 * GRAPH itself alone.
 *
 * An assertion on `?g` itself selects the single named graph `c` - every other `uᵢ` only contributes
 * solutions binding `?g` to `uᵢ ≠ c` - leaving `⟦P⟧_c ⋈ {?g↦c}`. Both halves need care:
 *
 * - `?g` may occur *inside* `P`, where it was the join that dropped the solutions binding it to another
 *   term. So `P` gets the assertion too, in the **weak** form: it need not bind `?g`, and where it binds
 *   it certainly, normalisation promotes it back on arrival.
 * - `{?g↦c}` has to be put back, since `Graph(c,P)` over an IRI binds nothing and `?g` would otherwise
 *   leave `pVars`/`cVars`. Which construct expresses that join depends on what `P` binds, and getting it
 *   wrong is an error rather than a wrong answer: `Extend` raises on an already bound variable, so it may
 *   only be used where `P` cannot bind `?g` at all.
 *
 * If `c` is not an IRI nothing matches, since graph names are IRIs.
 */
function pushIntoGraph(
  c: TransformContext,
  graph: Algebra.Graph,
  assertions: AssertionConjunction,
): PreOrderMappingReturn {
  const { AF } = c;
  const graphName = graph.name;
  const graphVar = graphName.termType === 'Variable' ? graphName.value : undefined;

  // The name is already a single graph, so every assertion simply travels into the pattern.
  if (graphVar === undefined) {
    return keep(AF.createGraph(assertionFilter(c, graph.input, assertions), graphName));
  }
  // If something is asserted about the var, we know it is a Strong assertion. Other cases would already be handled.
  if (assertions.get(graphVar) === undefined) {
    return keep(assertionFilter(
      c,
      AF.createGraph(
        assertionFilter(c, graph.input, restrict(assertions, name => name !== graphVar)),
        graphName,
      ),
      restrict(assertions, name => name === graphVar),
    ));
  }
  const assertedGraphName = <StrongAssertion> assertions.get(graphVar);
  if (assertedGraphName.term.termType !== 'NamedNode') {
    return empty(c, graph);
  }

  // Read before the rewrite, which preserves `pVars` exactly and never shrinks `cVars`.
  const { cVars, pVars } = cpVars(graph.input);
  // `?g` travels on into the pattern, in the *weak* form: `P` need not bind it at all, and the join
  // with `{?g ↦ c}` is what would have dropped the solutions binding it to anything else.
  const inside = new Map(assertions);
  inside.set(graphVar, assertWeak(assertedGraphName.term));
  const selected = AF.createGraph(assertionFilter(c, graph.input, inside), assertedGraphName.term);

  if (cVars.has(graphVar)) {
    // Every solution of `P` binds `?g` - and the weak assertion, promoted to the strong one down there,
    // has already fixed it to `c` - so joining `{?g ↦ c}` back on would change nothing.
    return keep(selected);
  }
  if (pVars.has(graphVar)) {
    // `P` binds `?g` in some solutions and not others, so the join has to stay one: an EXTEND raises an
    // error on a variable that is already bound. A single row binding `?g` to `c` *is* `{?g ↦ c}`.
    return keep(AF.createJoin([ selected, AF.createExtend(
      AF.createBgp([]),
      c.DF.variable(graphVar),
      AF.createTermExpression(assertedGraphName.term),
    ) ], false));
  }
  // `P` never binds `?g`, so the join only ever adds the binding, which is what an EXTEND does.

  return keep(bindAssertedTerms(c, selected, new Map([[ graphVar, assertedGraphName.term ]])));
}

/**
 * Pushes the assertions into the operands of a JOIN their licence holds for (FJPush).
 *
 * Specialised to a single variable, that licence is `L(?x, A₁, A₂) ≔ ?x ∈ cVars(A₁) ∨ ?x ∉ pVars(A₂)`;
 * the second disjunct is easy to forget but does real work.
 *
 * An assertion goes into *every* operand it is licensed for - the join already enforces that all operands
 * agree on the variable, so an assertion certain on one side is free on the others and shrinks both
 * inputs. That is sideways information passing rather than a push.
 *
 * What no operand is licensed for is **demoted** rather than left behind: `σ_W(A₁ ⋈ A₂) ≡ σ_W(A₁) ⋈ σ_W(A₂)`
 * holds unconditionally, since a merged mapping binds `?x` exactly when one of its halves does. So the
 * weak form enters every operand regardless, and only a strong assertion no operand is licensed for stays
 * on top. That is what gets an assertion below a join over two optional-bound variables, where it can
 * still collapse back to the strong form deeper down. The unbound form rides along on the same identity.
 *
 * B⟨?x⟩ takes the same licence as the strong form and for the same reason - under it, `?x` is bound in
 * the merged mapping exactly when it is bound in the one operand that can bind it - but it has no weaker
 * form to fall back on. The very identity that carries W and U through is what it fails: a merged mapping
 * binds `?x` when *either* half does, so an operand leaving it unbound may still be part of a solution
 * that binds it. Unlicensed, it stays on top.
 */
function pushIntoJoin(
  c: TransformContext,
  join: Algebra.Join,
  assertions: AssertionConjunction,
): PreOrderMappingReturn {
  // Read before any rewriting: every rewrite preserves pVars and never shrinks cVars, so these licences
  // stay valid while the operands are rewritten.
  const operands = join.input.map(operand => cpVars(operand));

  const operandAssertions = join.input.map(() => new Map<string, Assertion>());
  const kept = new Map<string, Assertion>();
  // For every assertion, find out where it can go.
  for (const [ name, assertion ] of assertions) {
    let placedStrongly = false;
    for (const [ index ] of join.input.entries()) {
      // L(?x, operand, rest): certain in this operand, or impossible in every other one.
      const licensed = impliesBound(assertion) && (
        operands[index].cVars.has(name) ||
        operands.every((other, otherIndex) => otherIndex === index || !other.pVars.has(name)));
      if (licensed) {
        operandAssertions[index].set(name, assertion);
        placedStrongly = true;
      } else if (operands[index].pVars.has(name)) {
        const demoted = weakened(assertion);
        // Bound assertion knows no weak form and cannot be pushed
        if (demoted !== undefined) {
          operandAssertions[index].set(name, demoted);
        }
      }
    }
    // The weak and unbound forms are always consumed by the join; the two that imply `bound(?x)` only
    // when some operand took them in.
    if (impliesBound(assertion) && !placedStrongly) {
      kept.set(name, assertion);
    }
  }

  return keep(assertionFilter(
    c,
    c.AF.createJoin(join.input.map((operand, index) => assertionFilter(c, operand, operandAssertions[index])), false),
    kept,
  ));
}

/**
 * Pushes the assertions into a LEFT JOIN (OPTIONAL).
 *
 * The structural win comes first: `?x ∉ pVars(A₁) ⟹ σ_{?x≡c}(A₁ ⟕ A₂) ≡ A₁ ⋈ σ_{?x≡c}(A₂)`.
 * Only the two forms implying `bound(?x)` trigger it - what they rule out is precisely the solutions
 * leaving `?x` unbound, which with `?x ∉ pVars(A₁)` is every solution the anti-join half of the left join
 * produces. The weak and unbound forms are satisfied by exactly those, so they keep the OPTIONAL.
 *
 * Otherwise (FLPush) sends the licensed assertions into `A₁`, and `?x ∈ cVars(A₁) ∩ cVars(A₂)`
 * additionally licenses replicating into `A₂`: any `μ₂` compatible with a surviving `μ₁` binds `?x`
 * (certain) to `c`, so the pruned rows of `A₂` never removed anything.
 *
 * The LHS always takes at least the weak form: `σ_W(A₁ ⟕ A₂) ≡ σ_W(σ_W(A₁) ⟕ A₂)`, because a `μ₁`
 * violating W produces output violating W in both halves. The RHS does not - if `A₁` leaves `?x` unbound
 * and `A₂` binds it to another term, the merged solution is the one W discards, and pruning `A₂` would
 * instead let the unmatched `μ₁` through the anti-join half.
 *
 * B⟨?x⟩ has no weak form to fall back on either, so an unlicensed one simply stays on top: `A₂` may be
 * what binds `?x`, so a `μ₁` leaving it unbound cannot be dropped from `A₁`.
 */
function pushIntoLeftJoin(
  c: TransformContext,
  leftJoin: Algebra.LeftJoin,
  assertions: AssertionConjunction,
): PreOrderMappingReturn {
  const { AF } = c;
  const [ left, right ] = leftJoin.input;
  const leftVars = cpVars(left);

  if ([ ...assertions ].some(([ name, assertion ]) =>
    impliesBound(assertion) && !leftVars.pVars.has(name))) {
    // Our filter asserts that one of variables ONLY appearing on RHS is bound, thus, the LeftJoin becomes Join.
    const joined = AF.createJoin([ left, right ], true);
    const rebuilt = leftJoin.expression === undefined ? joined : AF.createFilter(joined, leftJoin.expression);
    return { ...keepMetadata, newValue: assertionFilter(c, rebuilt, assertions), reTransform: true };
  }

  const rightVars = cpVars(right);
  const intoLeft = new Map<string, Assertion>();
  const intoRight = new Map<string, Assertion>();
  const kept = new Map<string, Assertion>();
  for (const [ name, assertion ] of assertions) {
    const licensed = impliesBound(assertion) && (leftVars.cVars.has(name) || !rightVars.pVars.has(name));
    if (licensed) {
      intoLeft.set(name, assertion);
      if (leftVars.cVars.has(name) && rightVars.cVars.has(name)) {
        intoRight.set(name, assertion);
      }
    } else {
      // Not licensed as itself, but the weaker forms always are on the left - except B⟨?x⟩, which has none.
      // It stays here as well, since the right hand side can still introduce a binding that violates it.
      const demoted = leftVars.pVars.has(name) ? weakened(assertion) : undefined;
      if (demoted !== undefined) {
        intoLeft.set(name, demoted);
      }
      kept.set(name, assertion);
    }
  }

  // Every candidate μ₁ binds the variables strongly asserted in intoLeft to their term once those are
  // pushed into A₁, so substituting them into the left join condition is sound.
  const expression = leftJoin.expression === undefined ?
    undefined :
    substituteInExpression(c, leftJoin.expression, strongTermsOf(intoLeft));
  // TODO: the substitution in the filter might reveal more information that we could use!
  return keep(assertionFilter(
    c,
    AF.createLeftJoin(assertionFilter(c, left, intoLeft), assertionFilter(c, right, intoRight), expression),
    kept,
  ));
}

/** The certainly and possibly bound variables of an operation, computed once and cached on it. */
function cpVars(op: Algebra.Operation): CPMeta {
  return withCpVars(op).metadata;
}

/** The assertions of `assertions` whose variable satisfies `predicate`. */
function restrict(
  assertions: AssertionConjunction,
  predicate: (name: string) => boolean,
): Map<string, Assertion> {
  return new Map([ ...assertions ].filter(([ name ]) => predicate(name)));
}

/** The strong assertions of `assertions`, as a conjunction. */
function strongOf(assertions: AssertionConjunction): Map<string, Assertion> {
  return new Map([ ...assertions ].filter(([ , assertion ]) => assertion.subType === 'strong'));
}

/**
 * The same assertion, in the strongest form that survives a move somewhere the variable may be unbound:
 * A⟨?x ≡ c⟩ becomes W⟨?x ≡ c⟩, and W and U are already that weak.
 *
 * B⟨?x⟩ has no such form - weakening it means allowing the unbound case, and `¬b ∨ b` is `true` - so it
 * is `undefined`: it does not travel at all, and has to stay where it is.
 */
function weakened(assertion: Assertion): Assertion | undefined {
  if (assertion.subType === 'bound') {
    return undefined;
  }
  return assertion.subType === 'strong' ? assertWeak(assertion.term) : assertion;
}

/** The same conjunction, with every assertion in it {@link weakened}, and the ones that have no weak form dropped. */
function allWeakened(assertions: AssertionConjunction): Map<string, Assertion> {
  const result = new Map<string, Assertion>();
  for (const [ name, assertion ] of assertions) {
    const weak = weakened(assertion);
    if (weak !== undefined) {
      result.set(name, weak);
    }
  }
  return result;
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
 * operation as its input is what makes the node carry its `pVars`, as the invariant requires:
 * `pVars(Empty_S) := S`, never `∅`, or `SELECT *` scoping changes silently.
 * {@link transformFilterFalse} does the structural normalisation afterwards (`Empty ∪ A ≡ A`, ...).
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
 * The assertion filter over `op`, carrying the conjunction it stands for as its metadata so that the
 * traversal does not have to read it back out of the condition it builds.
 */
function assertionFilter(
  c: TransformContext,
  op: Algebra.Operation,
  assertions: AssertionConjunction,
): Algebra.Operation {
  if (assertions.size === 0) {
    return op;
  }
  const filter = <AssertionFilter> c.AF.createFilter(op, assertionsExpression(c, assertions));
  filter.metadata = { assertions: { assertions, residual: undefined, contradictory: false }};
  return filter;
}
