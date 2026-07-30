import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import type { Assertions } from '../utils/assertions.js';
import {
  assertionsExpression,
  collectAssertions,
  sameTermExpression,
  substituteInExpression,
  substituteInPattern,
  substituteInTerm,
  weakAssertionsExpression,
} from '../utils/assertions.js';
import type { BoundVariablesOptions } from '../utils/certainlyBoundVars.js';
import { certainlyBoundVariables, possiblyBoundVariables } from '../utils/certainlyBoundVars.js';
import { createFilterFalse } from '../utils/operationhelpers.js';

/**
 * @fileoverview Assertion filter pushdown.
 *
 * An earlier rewriting stage produces queries carrying *assertion filters* of the form
 * `FILTER(sameTerm(?x, <ex://p>))` - each stating that one variable is fixed to one term. Left where
 * they are, they only discard rows at the end. Pushed down, they eliminate work: they substitute into
 * BGPs (fewer triple matches), prune VALUES rows, delete whole UNION branches, and can turn an
 * OPTIONAL into a plain join.
 *
 * We use: https://arxiv.org/pdf/0812.3788 (Schmidt et al., "Foundations of SPARQL Query Optimization").
 * Rule names in parentheses refer to Figure 2 of that paper. Writing A⟨?x ≡ c⟩ for `σ_{sameTerm(?x,c)}`,
 * two properties drive the whole design:
 *
 * 1. **The assertion implies `bnd(?x)`**, so (FBndII) applies directly:
 *    `?x ∉ pVars(A) ⟹ σ_{?x≡c}(A) ≡ ∅`. Every empty-result outcome below falls out of that single
 *    rule; no per-operator emptiness rules are needed. It is also why `bound(?x)` folds to `true`
 *    during substitution.
 * 2. **`sameTerm`, not `=`.** Under `sameTerm`, `μ ↦ μ|_{V∖{?x}}` is a multiplicity-preserving
 *    bijection between `{μ ∈ ⟦BGP⟧ | μ(?x) = c}` and `⟦BGP[?x↦c]⟧`, which is what makes substituting a
 *    term into a pattern sound. Under `=` it is not: `?x = "01"^^xsd:integer` holds of the term
 *    `"1"^^xsd:integer`. Never generalise this pass to `=`.
 *
 * The licence to push into an operand, (FJPush)/(FLPush) specialised to a single variable condition, is
 * `L(?x, A₁, A₂) ≔ ?x ∈ cVars(A₁) ∨ ?x ∉ pVars(A₂)` - see {@link certainlyBoundVariables} and
 * {@link possiblyBoundVariables}. The second disjunct is easy to forget and does a lot of work: it is
 * what gets an assertion on a UNION-bound variable below an enclosing join, and what makes GRAPH
 * transparent.
 *
 * Per-operator rules:
 *
 * | Node | Rule | Needs |
 * |---|---|---|
 * | any `A` | `?x ∉ pVars(A)` ⟹ empty | pVars (FBndII) |
 * | `A₁ ∪ A₂` | `σ(A₁) ∪ σ(A₂)` - always, both branches, no precondition | - (FUPush) |
 * | `A₁ ⋈ A₂` | into every operand `L` holds for - possibly **both** at once | cVars+pVars (FJPush) |
 * | `A₁ ⟕ A₂` | to a join, or into `A₁` and maybe `A₂` - {@link pushIntoLeftJoin} | cVars+pVars (FLPush) |
 * | `A₁ ∖ A₂` | `σ(A₁) ∖ σ_W(A₂)` - both sides, unconditional | - (FMPush) |
 * | `σ_R(A)` | `σ_{simplify(R[?x↦c])}(σ_{?x≡c}(A))` | - (FReord) |
 * | `π_S(A)` | `?x ∉ S` ⟹ empty; else `π_S(σ(A))` | - |
 * | `Extend(A,?y,e)` | `Extend(σ(A), ?y, simplify(e[?x↦c]))` - see {@link pushIntoExtend} for `?y = ?x` | - |
 * | `Graph(g,P)` | `Graph(g, σ(P))` unconditionally; asserting on the graph variable selects one graph | - |
 * | `Distinct` / `Reduced` / `OrderBy` / `From` | push through (congruence) | - |
 * | `Group`, `?x` a grouping key | push below the grouping | - |
 * | `Slice`, `Group` (non-key), `Service` | **stop** - keep the filter above | - |
 *
 * `Slice` and non-key `Group` are genuine barriers: filtering before a slice changes which rows fall in
 * the window, filtering before aggregation changes the aggregate. `Service` is a barrier by choice
 * rather than for soundness: pushing into a `SERVICE` body is the highest-value push available (it cuts
 * network transfer, not just CPU), but it has to be a *replication* rather than a move, because
 * `SILENT` turns endpoint failure into a single empty solution that a moved filter would fail to
 * discard. Tracked separately.
 *
 * Every rewrite here preserves `pVars` exactly, never shrinks `cVars`, and preserves the multiplicity
 * of every surviving mapping - all rules used carry from set to bag algebra by Theorem 7 of the paper,
 * and the rules that do not, (UIdem) and (FDecompII), are not used. Consequently a licence computed at
 * one node stays valid while its descendants are rewritten, which is what allows a single traversal.
 */

/** How this pass approximates `cVars`; see {@link BoundVariablesOptions}. */
const CVARS_OPTIONS: BoundVariablesOptions = { extendBinds: true, filterImpliesBound: true };

/**
 * Pushes every assertion filter (`FILTER(sameTerm(?x, c))`) in `op` as deep as possible, and into every
 * branch that permits it - for a join, that may be both sides at once.
 *
 * Assertions are threaded as a substitution θ rather than one filter at a time: multiple assertions
 * arrive together, so joint threading means one traversal and one substitution pass per BGP.
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
  // Pre-order: an assertion has to travel deeper into the tree, and the outermost assertions are the
  // ones that may collapse the branches the deeper ones live in.
  return algebraUtils.mapOperationPreOrder<'unsafe', typeof op>(op, {
    [Algebra.Types.FILTER]: {
      transform: filter => pushFilter(c, filter),
    },
  });
}

/**
 * Handles one FILTER met by the traversal: the assertions it carries are pushed into its input, and
 * whatever is left of its condition stays on top with the assertions substituted into it (FReord).
 *
 * A filter carrying no assertion at all is returned untouched, which keeps the traversal descending
 * into it in search of the ones deeper down.
 */
function pushFilter(c: TransformContext, filter: Algebra.Filter): Algebra.Operation {
  const collected = collectAssertions(c, filter.expression);
  if (collected === undefined) {
    return empty(c, filter.input);
  }
  if (collected.assertions.size === 0) {
    return filter;
  }
  return withResidual(c, push(c, filter.input, collected.assertions), collected.residual);
}

/**
 * Returns an operation equivalent to `σ_θ(op)`, with the assertions pushed as deep as they go.
 *
 * @param c - The transformation context
 * @param op - The operation the assertions apply to
 * @param assertions - The assertions to push (θ)
 * @returns The rewritten operation
 */
function push(c: TransformContext, op: Algebra.Operation, assertions: Assertions): Algebra.Operation {
  const { AF } = c;
  if (assertions.size === 0) {
    return op;
  }
  // (FBndII): an assertion implies its variable is bound, so an operation that can never bind it
  // produces nothing at all. This one check replaces a per-operator emptiness rule.
  const possible = possiblyBoundVariables(op);
  for (const name of assertions.keys()) {
    if (!possible.has(name)) {
      return empty(c, op);
    }
  }

  switch (op.type) {
    case Algebra.Types.BGP:
      return pushIntoPatterns(c, op, op.patterns, assertions);
    case Algebra.Types.PATTERN:
      return pushIntoPatterns(c, op, [ op ], assertions);
    case Algebra.Types.PATH:
      return pushIntoPath(c, op, assertions);
    case Algebra.Types.VALUES:
      return pushIntoValues(c, op, assertions);

    // (FUPush) holds unconditionally, so every branch gets the assertions and keeps sinking on its own.
    case Algebra.Types.UNION:
      return AF.createUnion(op.input.map(branch => push(c, branch, assertions)), false);

    case Algebra.Types.FILTER: {
      const collected = collectAssertions(c, op.expression, assertions);
      if (collected === undefined) {
        return empty(c, op);
      }
      return withResidual(c, push(c, op.input, collected.assertions), collected.residual);
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
      return AF.createMinus(push(c, op.input[0], assertions), pushWeak(c, op.input[1], assertions));
    case Algebra.Types.GROUP:
      return pushIntoGroup(c, op, assertions);

    // Congruence: these do not touch which variables a solution binds.
    case Algebra.Types.PROJECT:
      // Dom(θ) ⊆ variables here, since pVars of a projection is exactly what it projects.
      return AF.createProject(push(c, op.input, assertions), op.variables);
    case Algebra.Types.DISTINCT:
      return AF.createDistinct(push(c, op.input, assertions));
    case Algebra.Types.REDUCED:
      return AF.createReduced(push(c, op.input, assertions));
    case Algebra.Types.ORDER_BY:
      return AF.createOrderBy(push(c, op.input, assertions), op.expressions);
    case Algebra.Types.FROM:
      return AF.createFrom(push(c, op.input, assertions), op.default, op.named);

    // SLICE and SERVICE are barriers, and so is anything this pass does not know about.
    default:
      return withAssertions(c, op, assertions);
  }
}

/**
 * Substitutes the assertions into a BGP (or a bare pattern), re-binding the substituted variables.
 *
 * All variables of a BGP are certainly bound, so there is nothing to check beyond whether the terms can
 * occupy the positions they land in: no triple has a literal or a triple term as subject, predicate or
 * graph, so such a substitution makes the whole BGP match nothing.
 */
function pushIntoPatterns(
  c: TransformContext,
  op: Algebra.Operation,
  patterns: Algebra.Pattern[],
  assertions: Assertions,
): Algebra.Operation {
  const substituted: Algebra.Pattern[] = [];
  for (const pattern of patterns) {
    const replacement = substituteInPattern(c, pattern, assertions);
    if (replacement === undefined) {
      return empty(c, op);
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
function pushIntoPath(c: TransformContext, path: Algebra.Path, assertions: Assertions): Algebra.Operation {
  const subject = substituteInTerm(path.subject, assertions, 'object');
  const object = substituteInTerm(path.object, assertions, 'object');
  const graph = substituteInTerm(path.graph, assertions, 'graph');
  if (subject === undefined || object === undefined || graph === undefined) {
    return empty(c, path);
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
function pushIntoValues(c: TransformContext, values: Algebra.Values, assertions: Assertions): Algebra.Operation {
  const bindings = values.bindings.filter(binding => [ ...assertions ].every(([ name, term ]) => {
    const bound = binding[name];
    return bound !== undefined && term.equals(bound);
  }));
  if (bindings.length === 0) {
    return empty(c, values);
  }
  const variables = values.variables.filter(variable => !assertions.has(variable.value));
  // A VALUES of zero columns is kept rather than replaced by an empty pattern: it still contributes one
  // solution per remaining row, and collapsing it would change those multiplicities.
  return bindAssertedTerms(c, c.AF.createValues(
    variables,
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
 * `BIND(?z AS ?x)`, `sameTerm(?z, c)` is itself an assertion, so the recursion restarts on `?z` and may
 * reach a BGP and fire the substitution there. Assertions propagate through renamings.
 */
function pushIntoExtend(c: TransformContext, extend: Algebra.Extend, assertions: Assertions): Algebra.Operation {
  const { AF } = c;
  const asserted = assertions.get(extend.variable.value);
  if (asserted === undefined) {
    return AF.createExtend(
      push(c, extend.input, assertions),
      extend.variable,
      substituteInExpression(c, extend.expression, assertions),
    );
  }

  // SPARQL forbids BINDing an in-scope variable, so ?x is not bound below the EXTEND. It has to leave θ
  // before descending, or the (FBndII) check at the top of the recursion wrongly yields empty.
  const below = new Map([ ...assertions ].filter(([ name ]) => name !== extend.variable.value));
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
      return AF.createExtend(push(c, extend.input, below), extend.variable, c.AF.createTermExpression(asserted));
    }
    // A constant BIND decides the assertion statically.
    return term.equals(asserted) ?
      AF.createExtend(push(c, extend.input, below), extend.variable, expression) :
      empty(c, extend);
  }
  // For a compound expression, `sameTerm(e, c)` is a multi-variable condition: it needs the full
  // (FJPush) side condition quantified over vars(e), so it is left for the generic filter pushdown
  // ({@link pushDownRestrictors}) instead of being sunk by this pass.
  return AF.createExtend(
    AF.createFilter(
      push(c, extend.input, below),
      sameTermExpression(c, substituteInExpression(c, expression, below), asserted),
    ),
    extend.variable,
    AF.createTermExpression(asserted),
  );
}

/**
 * Pushes the assertions through a GRAPH, which is transparent rather than a barrier.
 *
 * With `Graph(?g,P) ≡ ⋃_{(uᵢ,Gᵢ) ∈ named} ( ⟦P⟧_{Gᵢ} ⋈ {?g↦uᵢ} )`, an assertion on a variable other
 * than `?g` distributes over that union by (FUPush) and then into the left argument of each join by
 * (FJPush) - licensed by the *second* disjunct of `L`, since `?x ∉ pVars({?g↦uᵢ}) = {?g}`. No
 * precondition survives, so that push is unconditional.
 *
 * An assertion on `?g` itself selects the single named graph `c`. If `c` is not an IRI nothing matches,
 * since graph names are IRIs. Otherwise the EXTEND is mandatory for the same reason as in the BGP case:
 * without it `?g` would leave `pVars`/`cVars` and break the invariant.
 */
function pushIntoGraph(c: TransformContext, graph: Algebra.Graph, assertions: Assertions): Algebra.Operation {
  const { AF } = c;
  const asserted = graph.name.termType === 'Variable' ? assertions.get(graph.name.value) : undefined;
  if (asserted === undefined) {
    return AF.createGraph(push(c, graph.input, assertions), graph.name);
  }
  if (asserted.termType !== 'NamedNode') {
    return empty(c, graph);
  }
  const below = new Map([ ...assertions ].filter(([ name ]) => name !== (<RDF.Variable> graph.name).value));
  return bindAssertedTerms(
    c,
    AF.createGraph(push(c, graph.input, below), asserted),
    new Map([[ (<RDF.Variable> graph.name).value, asserted ]]),
  );
}

/**
 * Pushes the assertions into the operands of a JOIN it is licensed for (FJPush).
 *
 * An assertion goes into *every* operand whose licence `L` holds - the join already enforces that all
 * operands agree on the variable, so an assertion certain on one side is free on the others and shrinks
 * both inputs. That is sideways information passing rather than a push. What no operand is licensed for
 * stays in a filter on top of the join.
 */
function pushIntoJoin(c: TransformContext, join: Algebra.Join, assertions: Assertions): Algebra.Operation {
  // Computed before any rewriting: every rewrite preserves pVars and never shrinks cVars, so the
  // licences stay valid while the operands are rewritten.
  const possible = join.input.map(operand => possiblyBoundVariables(operand));
  const certain = join.input.map(operand => certainVariables(operand));

  const perOperand = join.input.map(() => new Map<string, RDF.Term>());
  const kept = new Map(assertions);
  for (const [ name, term ] of assertions) {
    for (const [ index ] of join.input.entries()) {
      // L(?x, operand, rest): certain in this operand, or impossible in every other one.
      if (certain[index].has(name) ||
        possible.every((operandPossible, other) => other === index || !operandPossible.has(name))) {
        perOperand[index].set(name, term);
        kept.delete(name);
      }
    }
  }

  return withAssertions(
    c,
    c.AF.createJoin(join.input.map((operand, index) => push(c, operand, perOperand[index])), false),
    kept,
  );
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
): Algebra.Operation {
  const { AF } = c;
  const [ left, right ] = leftJoin.input;
  const leftPossible = possiblyBoundVariables(left);

  if ([ ...assertions.keys() ].some(name => !leftPossible.has(name))) {
    // With a left join condition R: `LeftJoin(A₁,A₂,R) ≡ σ_R(A₁ ⋈ A₂) ∪ (A₁ ∖_R A₂)`, so the same
    // argument leaves `σ_θ(σ_R(A₁ ⋈ A₂))`, into which the pass recurses.
    const joined = AF.createJoin([ left, right ], false);
    const expression = leftJoin.expression;
    return push(c, expression === undefined ? joined : AF.createFilter(joined, expression), assertions);
  }

  const rightPossible = possiblyBoundVariables(right);
  const leftCertain = certainVariables(left);
  const rightCertain = certainVariables(right);
  const intoLeft = new Map<string, RDF.Term>();
  const intoRight = new Map<string, RDF.Term>();
  const kept = new Map<string, RDF.Term>();
  for (const [ name, term ] of assertions) {
    if (leftCertain.has(name) || !rightPossible.has(name)) {
      intoLeft.set(name, term);
      if (leftCertain.has(name) && rightCertain.has(name)) {
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
  return withAssertions(
    c,
    AF.createLeftJoin(push(c, left, intoLeft), push(c, right, intoRight), expression),
    kept,
  );
}

/**
 * Pushes the assertions on grouping keys below a GROUP BY; the others stay above it.
 *
 * An assertion on a key selects whole groups, which is the same as selecting the solutions those groups
 * are formed from. An assertion on anything else has to stay above: filtering before aggregation would
 * change the aggregate.
 */
function pushIntoGroup(c: TransformContext, group: Algebra.Group, assertions: Assertions): Algebra.Operation {
  const keys = new Set(group.variables.map(variable => variable.value));
  const below = new Map([ ...assertions ].filter(([ name ]) => keys.has(name)));
  if (below.size === 0) {
    return withAssertions(c, group, assertions);
  }
  const kept = new Map([ ...assertions ].filter(([ name ]) => !keys.has(name)));
  return withAssertions(
    c,
    c.AF.createGroup(push(c, group.input, below), group.variables, group.aggregates),
    kept,
  );
}

/**
 * Returns an operation equivalent to `σ_W(op)`, the *weak* assertion
 * W⟨?x ≡ c⟩ ≔ `!bound(?x) || sameTerm(?x, c)`, pushed as deep as it goes.
 *
 * Required for the right hand side of a MINUS: `σ_{?x≡c}(A₁ ∖ A₂) ≡ σ_{?x≡c}(A₁) ∖ σ_W(A₂)`. This is
 * not a filter push - `∖` is anti-monotone in its right argument, so shrinking `A₂` can only *grow* the
 * result. It is sound because a row `μ₂` the pruning removes either binds `?x` to something other than
 * `c`, making it incompatible with every survivor of `σ_{?x≡c}(A₁)` and so excluding nothing, or it
 * leaves `?x` unbound - which is exactly the case the `!bound` disjunct keeps. Implementations must not
 * "simplify" `σ_W` to `σ` here: with `A₁ = BGP(?x :p ?y)`, `A₂ = BGP(?z :q ?y)` and an assertion on
 * `?x`, the strong form makes `A₂` empty by (FBndII) and deletes the MINUS, returning everything where
 * the correct answer is empty.
 *
 * The weak assertion collapses on arrival: where `?x ∈ cVars` it becomes the strong assertion (so the
 * BGP and VALUES rewrites fire), and where `?x ∉ pVars` it becomes `true` and is **dropped** - not
 * turned into the empty result, which would silently delete results.
 *
 * @param c - The transformation context
 * @param op - The operation the weak assertions apply to
 * @param assertions - The assertions to push weakly (θ)
 * @returns The rewritten operation
 */
function pushWeak(c: TransformContext, op: Algebra.Operation, assertions: Assertions): Algebra.Operation {
  const { AF } = c;
  if (assertions.size === 0) {
    return op;
  }
  const possible = possiblyBoundVariables(op);
  const relevant = new Map([ ...assertions ].filter(([ name ]) => possible.has(name)));
  if (relevant.size === 0) {
    return op;
  }
  const certain = certainVariables(op);
  const weak = new Map([ ...relevant ].filter(([ name ]) => !certain.has(name)));
  if (weak.size === 0) {
    // Every remaining variable is certainly bound here, so `!bound(?x)` is unsatisfiable and the weak
    // assertion *is* the strong one.
    return push(c, op, relevant);
  }

  switch (op.type) {
    // `σ_W(A₁ ⋈ A₂) ≡ σ_W(A₁) ⋈ σ_W(A₂)` and the same for a union: a compatible pair satisfies W
    // exactly when both of its halves do. Every operand re-classifies what is weak and what is strong.
    case Algebra.Types.UNION:
      return AF.createUnion(op.input.map(branch => pushWeak(c, branch, relevant)), false);
    case Algebra.Types.JOIN:
      return AF.createJoin(op.input.map(operand => pushWeak(c, operand, relevant)), false);
    // A row of the left argument violating W can only produce output violating W, in both the join and
    // the anti-join half of a left join. The outer filter has to stay though: the right argument can
    // still introduce a binding violating W, which a moved filter would no longer discard.
    case Algebra.Types.LEFT_JOIN:
      return withWeakAssertions(
        c,
        AF.createLeftJoin(pushWeak(c, op.input[0], relevant), op.input[1], op.expression),
        weak,
      );
    case Algebra.Types.MINUS:
      return AF.createMinus(pushWeak(c, op.input[0], relevant), op.input[1]);
    // Two selections commute; the condition is *not* substituted into, since W does not guarantee the
    // variable is bound to the term - it may not be bound at all.
    case Algebra.Types.FILTER:
      return AF.createFilter(pushWeak(c, op.input, relevant), op.expression);
    case Algebra.Types.PROJECT:
      return AF.createProject(pushWeak(c, op.input, relevant), op.variables);
    case Algebra.Types.DISTINCT:
      return AF.createDistinct(pushWeak(c, op.input, relevant));
    case Algebra.Types.REDUCED:
      return AF.createReduced(pushWeak(c, op.input, relevant));
    case Algebra.Types.ORDER_BY:
      return AF.createOrderBy(pushWeak(c, op.input, relevant), op.expressions);
    case Algebra.Types.FROM:
      return AF.createFrom(pushWeak(c, op.input, relevant), op.default, op.named);
    case Algebra.Types.EXTEND: {
      // The target variable does not exist below the EXTEND, so its weak assertion stays here.
      const below = new Map([ ...relevant ].filter(([ name ]) => name !== op.variable.value));
      const here = new Map([ ...relevant ].filter(([ name ]) => name === op.variable.value));
      return withWeakAssertions(
        c,
        AF.createExtend(pushWeak(c, op.input, below), op.variable, op.expression),
        here,
      );
    }
    case Algebra.Types.GRAPH: {
      const graphName = op.name.termType === 'Variable' ? op.name.value : undefined;
      const below = new Map([ ...relevant ].filter(([ name ]) => name !== graphName));
      const here = new Map([ ...relevant ].filter(([ name ]) => name === graphName));
      return withWeakAssertions(c, AF.createGraph(pushWeak(c, op.input, below), op.name), here);
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
      const strong = new Map([ ...relevant ].filter(([ name ]) => certain.has(name)));
      return push(c, AF.createValues(op.variables, bindings), strong);
    }
    default: {
      // A barrier: what collapsed to the strong assertion is still pushed, the rest stays on top.
      const strong = new Map([ ...relevant ].filter(([ name ]) => certain.has(name)));
      return withWeakAssertions(c, push(c, op, strong), weak);
    }
  }
}

/**
 * Builds the empty solution multiset that replaces an operation the assertions rule out.
 *
 * `FILTER(FALSE)` is this codebase's empty operation ({@link createFilterFalse}). Keeping the replaced
 * operation as its input is what makes the node carry the `pVars` of what it replaced, as the scheme's
 * invariant requires: `pVars(Empty_S) := S`, never `∅`, or `SELECT *` scoping and the in-scope variable
 * set change silently. {@link transformFilterFalse} does the structural normalisation afterwards
 * (`Empty ∪ A ≡ A`, `Empty ⋈ A ≡ Empty`, ...).
 */
function empty(c: TransformContext, replaced: Algebra.Operation): Algebra.Operation {
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

/** Wraps `op` in the strong assertion filter for `assertions`, if there are any left to enforce. */
function withAssertions(c: TransformContext, op: Algebra.Operation, assertions: Assertions): Algebra.Operation {
  return assertions.size === 0 ? op : c.AF.createFilter(op, assertionsExpression(c, assertions));
}

/** Wraps `op` in the weak assertion filter for `assertions`, if there are any left to enforce. */
function withWeakAssertions(
  c: TransformContext,
  op: Algebra.Operation,
  assertions: Assertions,
): Algebra.Operation {
  return assertions.size === 0 ? op : c.AF.createFilter(op, weakAssertionsExpression(c, assertions));
}

/** Wraps `op` in what was left of a filter condition after the assertions were taken out of it. */
function withResidual(
  c: TransformContext,
  op: Algebra.Operation,
  residual: Algebra.Expression | undefined,
): Algebra.Operation {
  return residual === undefined ? op : c.AF.createFilter(op, residual);
}

/** The `cVars` of an operation, as approximated for this pass. */
function certainVariables(op: Algebra.Operation): Set<string> {
  return certainlyBoundVariables(op, CVARS_OPTIONS);
}
