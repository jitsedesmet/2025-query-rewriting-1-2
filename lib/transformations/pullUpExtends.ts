import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import type { CPMeta } from '../utils/certainlyBoundVars.js';
import { cpMetaOf, withoutCpVars } from '../utils/certainlyBoundVars.js';
import {
  asksBoundOfVariable,
  containsExistenceExpression,
  expressionsEqual,
  isStableExpression,
} from '../utils/expressionHelpers.js';
import type { ChainBind, PeeledChain } from '../utils/extendChain.js';
import { peelExtends, replantExtends } from '../utils/extendChain.js';
import { substituteInExpression } from '../utils/partialExpressionEvaluation.js';
import type { SSet } from '../utils/setUtils.js';
import { differenceSets } from '../utils/setUtils.js';
import { collectVariableNames } from '../utils.js';

/**
 * @fileoverview Assignment pull-up.
 *
 * {@link pushDownAssertions} leaves an `EXTEND` behind at *every* leaf it substitutes into, because that is
 * the only way it can preserve `pVars`/`cVars` exactly without knowing what stands above it. This pass is
 * the other half: once the whole plan is visible, most of those re-bindings are not needed where they
 * stand, and each one that rises turns a per-solution assignment on a scan into one assignment on a
 * smaller intermediate result - or disappears.
 *
 * ```sparql
 * SELECT * { { ?s ?p ?o . BIND(<ex://a> AS ?x) } { ?a ?b ?c } }
 * -- becomes
 * SELECT * { ?s ?p ?o . ?a ?b ?c . BIND(<ex://a> AS ?x) }
 * ```
 *
 * ## The invariant, and the three side conditions
 *
 * **The invariant is local, and there is no global target.** Every rewrite is one swap,
 * `Op1(Op2(…))` ⟶ `Op2(Op1(…))`, preserving the solution multiset, `pVars` and `cVars` **at the node the
 * swap is anchored at**. Below that node nothing is preserved and nothing needs to be: the operation
 * without the bind has a smaller `pVars`, which is the point. Reaching the outer `PROJECT` is an outcome,
 * not a goal.
 *
 * For a bind `?x := e` on input `A` of `op`, with `V = vars(e)` and the other inputs `B`:
 *
 * - **(C1) no capture** - every other `B` satisfies `B.vRanges.neverBinds(?x)`, unless it carries an
 *   identical bind (merge), and `op` does not introduce `?x` itself (`GRAPH ?x`). Read the **ranges**,
 *   never the key set: `?x` merely being in scope in `B` is fine, what the spec leaves undefined is
 *   extending a μ that already *binds* `?x`.
 * - **(C2) same inputs** - every `?y ∈ V` satisfies `A.cVars.has(?y)` or every other `B` never binds `?y`.
 *   Vacuous for a ground `e`, and vacuous for `UNION`/`MINUS`, which merge nothing.
 * - **(C3) readers** - what the node reads must not see `?x`, or must have `e` substituted into it.
 *
 * All three are read off the `CPMeta` of the inputs as `mapOperation` hands them back, chain included and
 * *before* any rewriting. On a single-input operation (C1) and (C2) hold vacuously and only the readers
 * decide.
 *
 * ## Dropping
 *
 * A drop deletes the bind instead of moving it, so `?x` does not come back: the anchor moves up to the
 * operation that discards it, and it is there that `pVars` and the multiset must be unchanged. It is sound
 * because `Extend` is total when `A` never binds `?x` - one solution in, one out - so the multiset is
 * unchanged modulo `?x`. Phase 1 drops at the two operations that discard a variable syntactically, a
 * `PROJECT` and a `GROUP`.
 *
 * ## Order within a chain
 *
 * A chain is peeled into an ordered list and decided as a unit. What leaves ends up above the node and
 * what stays ends up below it, so anything that leaves swaps with every stayer that stood *above* it, and
 * two binds may only swap when neither reads the other's variable: a stayer reading a riser's `?x`
 * substitutes it in where `e` is a term expression and pins the riser otherwise; a riser reading a
 * stayer's `?y` pins outright, since above the node it would read `?y` bound where below it read it
 * unbound. Pinning can create new violations, so the partition is iterated until it is stable; it
 * terminates because pinning only ever moves binds from *leaving* to *staying*.
 *
 * ## The traversal
 *
 * One post-order {@link algebraUtils.mapOperation}: it works back up from the descendants, so by the time
 * a callback sees a node, each of its inputs already carries at the top of itself everything it could
 * float. That is the whole recursion - no custom traversal and no fixpoint loop over the tree. Enter and
 * leave through `withoutCpVars`, as the pushdown does: entering gives a tree of our own to rewrite and the
 * guarantee that what `withCpVars` reports describes the plan as it stands, and leaving clears what the
 * rewrites invalidated.
 *
 * ## The query's own solution modifiers
 *
 * A bind may not rise into the chain of `PROJECT`/`SLICE`/`ORDER_BY`/… at the top of what this pass is
 * handed, because SPARQL has nowhere to write it there - `BIND` is a graph pattern, and there is no room
 * for one between a `SELECT` and its `LIMIT`. A hoist past the query's own projection is pointless anyway,
 * there being nothing above it to rise to, so what this rules out is a tree no generator could print in
 * exchange for nothing at all. The chain is short and usually empty: `queryTransform` strips the outer
 * projection before running any transformation.
 *
 * ## What does not move yet
 *
 * A bind holding an `EXISTS` never moves, and neither does one whose reader would have to take a term
 * *inside* an `EXISTS` - see {@link readerAdmitsSubstitution}, which is also where the two exceptions to
 * substitution live.
 *
 * A `SERVICE` is a barrier, as it is in the pushdown: `SILENT` turns endpoint failure into one empty
 * solution, where a hoisted bind would still bind `?x`.
 * TODO(future): a non-`SILENT` service could release a bind, which is sound and reduces what is shipped to
 * the endpoint.
 */

/** What a bind does with the operation it stands under. */
type Disposition =
  /** Stays where it is, re-planted below the operation. */
  'stay' |
  /** Rises above the operation and is written out there. */
  'rise' |
  /** Rises as part of a group of identical binds, another member of which is the one written out. */
  'absorb' |
  /** Deleted outright: the operation discards its variable, so nothing above can read it. */
  'drop';

/** One bind of one input of one operation, with everything the licences read about it. */
interface FloatingBind {
  /** The bind itself, as {@link peelExtends} handed it over. */
  bind: ChainBind;
  /** The index of the input whose chain it came out of. */
  inputIndex: number;
  /** Its position in that chain, in evaluation order. */
  chainPosition: number;
  /** The gate every rule is behind: whether `e` gives the same answer wherever in the plan it is asked. */
  expressionIsStable: boolean;
  /** Whether `?x ∈ cVars(Extend(A, ?x, e))`, which is what decides the `bound(?x)` fold. */
  bindsCertainly: boolean;
  /** What holds *where the bind is evaluated*, so below every bind standing above it in its chain. */
  scopeBelowBind: CPMeta;
  /** What has been decided for it, `stay` until a licence says otherwise. */
  disposition: Disposition;
  /** The binds that have to leave together, this one included; a list of one for an ordinary hoist. */
  mustLeaveWith: FloatingBind[];
}

/** The peeled inputs of one operation and the binds peeled at the top of them. */
interface PeeledInputs {
  /** The inputs, each split into a core and a chain. */
  chains: PeeledChain[];
  /** The peeled binds of each input, in evaluation order, indexed as the inputs are. */
  bindsPerInput: FloatingBind[][];
  /** Every peeled bind, ordered by input index and then by chain order - the order risers are written in. */
  allBinds: FloatingBind[];
}

/**
 * The operations that make up a query's solution-modifier chain: what stands between the root of what this
 * pass is handed and the pattern the query is about.
 */
const solutionModifierTypes = new Set<string>([
  Algebra.Types.ASK,
  Algebra.Types.CONSTRUCT,
  Algebra.Types.DESCRIBE,
  Algebra.Types.PROJECT,
  Algebra.Types.DISTINCT,
  Algebra.Types.REDUCED,
  Algebra.Types.SLICE,
  Algebra.Types.ORDER_BY,
  Algebra.Types.FROM,
]);

/**
 * The nodes of the solution-modifier chain at the top of `root` ({@link solutionModifierTypes}).
 * @param root - The root of the tree the traversal is about to run over
 * @returns those nodes, by identity, so that a callback can recognise its own original
 */
function solutionModifierChainOf(root: Algebra.Operation): Set<Algebra.Operation> {
  const sealed = new Set<Algebra.Operation>();
  let current = root;
  while (solutionModifierTypes.has(current.type)) {
    sealed.add(current);
    current = (<Algebra.Single> current).input;
  }
  return sealed;
}

/**
 * Floats every `BIND` in `op` as high as the plan allows and deletes the ones nothing above reads.
 *
 * Works on a subtree as happily as on a whole query, the invariant being anchored per swap.
 * @param c - The transformation context
 * @param op - The operation to rewrite
 * @returns the rewritten operation
 * @example
 * // Before: SELECT * WHERE { { ?s ?p ?o . BIND(<ex://a> AS ?x) } { ?a ?b ?c } }
 * // After:  SELECT * WHERE { ?s ?p ?o . ?a ?b ?c . BIND(<ex://a> AS ?x) }
 * @example
 * // Before: SELECT ?y WHERE { ?y <ex://p> ?o . BIND(<ex://a> AS ?x) }
 * // After (nothing projects ?x, so the bind is deleted):
 * // SELECT ?y WHERE { ?y <ex://p> ?o }
 */
export function pullUpExtends<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  // Starting from a copy without metadata gives both a tree of our own to rewrite and the guarantee that
  // what `withCpVars` hands us describes the plan as it is now - and it is cleared again on the way out
  // for the same reason, the rewrites having since invalidated what the licences cached.
  const entered = withoutCpVars(op);
  const sealed = solutionModifierChainOf(entered);
  return withoutCpVars(algebraUtils.mapOperation<'unsafe', T>(entered, {
    [Algebra.Types.FILTER]: { transform: (filter: Algebra.Filter) => floatThroughFilter(c, filter) },
    [Algebra.Types.PROJECT]: { transform: (project: Algebra.Project, original) =>
      floatThroughProject(c, project, sealed.has(original)) },
    [Algebra.Types.GROUP]: { transform: (group: Algebra.Group) => floatThroughGroup(c, group) },
    [Algebra.Types.DISTINCT]: { transform: (distinct: Algebra.Distinct, original) =>
      floatThroughCongruentOperation(c, distinct, sealed.has(original), input => c.AF.createDistinct(input)) },
    [Algebra.Types.REDUCED]: { transform: (reduced: Algebra.Reduced, original) =>
      floatThroughCongruentOperation(c, reduced, sealed.has(original), input => c.AF.createReduced(input)) },
    [Algebra.Types.SLICE]: { transform: (slice: Algebra.Slice, original) =>
      floatThroughCongruentOperation(c, slice, sealed.has(original), input =>
        c.AF.createSlice(input, slice.start, slice.length)) },
    [Algebra.Types.FROM]: { transform: (from: Algebra.From, original) =>
      floatThroughCongruentOperation(c, from, sealed.has(original), input =>
        c.AF.createFrom(input, from.default, from.named)) },
    [Algebra.Types.ORDER_BY]: { transform: (orderBy: Algebra.OrderBy, original) =>
      floatThroughOrderBy(c, orderBy, sealed.has(original)) },
    [Algebra.Types.GRAPH]: { transform: (graph: Algebra.Graph) => floatThroughGraph(c, graph) },
    [Algebra.Types.JOIN]: { transform: (join: Algebra.Join) => floatThroughJoin(c, join) },
    [Algebra.Types.LEFT_JOIN]: { transform: (leftJoin: Algebra.LeftJoin) => floatThroughLeftJoin(c, leftJoin) },
    [Algebra.Types.MINUS]: { transform: (minus: Algebra.Minus) => floatThroughMinus(c, minus) },
    [Algebra.Types.UNION]: { transform: (union: Algebra.Union) => floatThroughUnion(c, union) },
    // An EXTEND needs no callback of its own: a chain is one unit, decided by whatever it stands under.
    // Everything else is a leaf or a barrier, and a type without a callback is exactly a barrier.
  }));
}

/**
 * Pins everything that wanted to rise, for an operation of the solution-modifier chain. A drop survives it.
 * @param peeled - The floating binds to pin
 */
function pinEveryRise(peeled: PeeledInputs): void {
  // A drop is left alone: deleting a bind leaves the operation exactly where it was, so it says nothing
  // about what could be written above it - and a projection that discards a variable is this phase's main
  // drop site whether it is the query's own or a sub-`SELECT`'s.
  for (const floatingBind of peeled.allBinds) {
    if (floatingBind.disposition !== 'drop') {
      floatingBind.disposition = 'stay';
    }
  }
}

/**
 * Peels the inputs of an operation and reads, per bind, everything the licences will ask about it.
 * @param c - The transformation context
 * @param inputs - The inputs as `mapOperation` handed them back, before any rewriting
 * @returns the peeled chains and their floating binds
 */
function peelInputs(c: TransformContext, inputs: readonly Algebra.Operation[]): PeeledInputs {
  const chains = inputs.map(input => peelExtends(c, input));
  const bindsPerInput = chains.map((chain, inputIndex) => chain.binds.map((bind, chainPosition) => {
    const floatingBind: FloatingBind = {
      bind,
      inputIndex,
      chainPosition,
      expressionIsStable: isStableExpression(c, bind.expression),
      bindsCertainly: cpMetaOf(bind.extendNode).cVars.has(bind.variable.value),
      scopeBelowBind: cpMetaOf(bind.extendNode.input),
      disposition: 'stay',
      mustLeaveWith: [],
    };
    floatingBind.mustLeaveWith = [ floatingBind ];
    return floatingBind;
  }));
  return { chains, bindsPerInput, allBinds: bindsPerInput.flat() };
}

/**
 * Iterates the partition until it is stable, pinning whatever the order within a chain forbids.
 * @param c - The transformation context
 * @param peeled - The floating binds, with a first opinion already written into their dispositions
 * @param stillLicensed - Re-checks what the operation itself asks of one bind
 */
function settlePartition(
  c: TransformContext,
  peeled: PeeledInputs,
  stillLicensed: (floatingBind: FloatingBind) => boolean,
): void {
  // Terminating because it only ever moves a bind from leaving to staying, and a bind that stays is never
  // looked at again.
  let changed = true;
  while (changed) {
    changed = false;
    for (const floatingBind of peeled.allBinds) {
      if (floatingBind.disposition === 'stay') {
        continue;
      }
      if (!stillLicensed(floatingBind) || !chainOrderAllows(c, peeled, floatingBind)) {
        // A group leaves as a whole or not at all, so one member the order forbids pins every copy of it -
        // which is what makes the `UNION` rule "the order check has to pass in every branch".
        for (const member of floatingBind.mustLeaveWith) {
          member.disposition = 'stay';
        }
        changed = true;
      }
    }
  }
}

/**
 * Whether the binds standing above `floatingBind` in its own chain let it leave.
 * @param c - The transformation context
 * @param peeled - Every floating bind of the operation
 * @param floatingBind - The bind that wants to leave
 * @returns whether every stayer above it either does not read it, or admits `e` written in its place
 */
function chainOrderAllows(c: TransformContext, peeled: PeeledInputs, floatingBind: FloatingBind): boolean {
  for (const bindAbove of peeled.bindsPerInput[floatingBind.inputIndex]) {
    if (bindAbove.chainPosition <= floatingBind.chainPosition || bindAbove.disposition !== 'stay') {
      continue;
    }
    // Above the operation the riser would read `?y` bound where below it read it unbound.
    if (floatingBind.bind.reads.has(bindAbove.bind.variable.value)) {
      return false;
    }
    if (!readerAdmitsSubstitution(c, peeled, bindAbove.bind.expression, floatingBind)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether `e` may be written into a reader in place of `?x`, which is what lets a bind pass something that
 * reads it. Four things decide it, each commented at its own check below.
 * @param c - The transformation context
 * @param peeled - Every floating bind of the operation, to see what else is leaving
 * @param reader - The expression that may read `?x`
 * @param floatingBind - The bind that wants to pass it
 * @returns whether the reader lets it pass
 */
function readerAdmitsSubstitution(
  c: TransformContext,
  peeled: PeeledInputs,
  reader: Algebra.Expression,
  floatingBind: FloatingBind,
): boolean {
  // Sound almost everywhere: if `e` errors, the original leaves `?x` unbound and the reader evaluates an
  // unbound variable - a type error - where the substituted version raises the same type error from `e`
  // itself, and SPARQL does not distinguish the two.
  const variableName = floatingBind.bind.variable.value;
  // Nothing to write, so nothing to object to. `collectVariableNames` sees into a nested pattern, so an
  // EXISTS that does not mention `?x` answers no here and the hoist past it is allowed.
  if (!collectVariableNames(c.astTransformer, reader).has(variableName)) {
    return true;
  }
  // Only a term expression is written in at all: with `k` occurrences of `?x`, one evaluation of `e` per
  // row becomes `k+1`, which is free exactly when `e` is a term. And nothing is written into an EXISTS -
  // `μ` is substituted into the nested *pattern*, where an expression cannot go and an unbound `?x` is a
  // variable matching anything rather than one term. `substituteInExpression` leaves EXISTENCE untouched
  // for that reason, and the pushdown carries the same TODO.
  // TODO(phase 4): work out what a substitution into a nested pattern would mean.
  if (floatingBind.bind.expression.subType !== Algebra.ExpressionTypes.TERM || containsExistenceExpression(reader)) {
    return false;
  }
  // `bound(?x)` reads unboundness instead of propagating it, and takes a bare `Var`, so it folds to `true`
  // only for a certain bind and blocks otherwise.
  if (!floatingBind.bindsCertainly && asksBoundOfVariable(reader, variableName)) {
    return false;
  }
  // `e` has to mean down there what it meant up here, so a bind *below* this one that is also leaving may
  // not write a variable `e` reads - the reader would evaluate `e` against an unbound one.
  return peeled.bindsPerInput[floatingBind.inputIndex].every(bindBelow =>
    bindBelow.chainPosition >= floatingBind.chainPosition ||
    bindBelow.disposition === 'stay' ||
    !floatingBind.bind.reads.has(bindBelow.bind.variable.value));
}

/**
 * Whether every reader of an operation lets a bind pass, {@link readerAdmitsSubstitution} deciding each.
 * @param c - The transformation context
 * @param peeled - Every floating bind of the operation
 * @param readers - The expressions the operation owns
 * @param floatingBind - The bind that wants to pass them
 * @returns whether all of them let it pass
 */
function allReadersAdmitSubstitution(
  c: TransformContext,
  peeled: PeeledInputs,
  readers: readonly Algebra.Expression[],
  floatingBind: FloatingBind,
): boolean {
  return readers.every(reader => readerAdmitsSubstitution(c, peeled, reader, floatingBind));
}

/**
 * Writes the term of every bind that left into an expression that reads it, which is what lets a hoist pass
 * a reader at all.
 * @param c - The transformation context
 * @param expression - The reader to rewrite
 * @param departedBinds - The binds that left from below it
 * @param cVars - What is certainly bound where the reader is evaluated, which decides `sameTerm(?x, ?x)`
 * @returns the rewritten reader
 */
function substituteDepartedBinds(
  c: TransformContext,
  expression: Algebra.Expression,
  departedBinds: readonly FloatingBind[],
  cVars: SSet,
): Algebra.Expression {
  let result = expression;
  for (const departed of departedBinds) {
    const variableName = departed.bind.variable.value;
    // Skipped rather than substituted into: the call is not free, and {@link readerAdmitsSubstitution} has
    // already established that the ones which do hold the variable may be written.
    if (!collectVariableNames(c.astTransformer, result).has(variableName)) {
      continue;
    }
    const term = (<Algebra.TermExpression> departed.bind.expression).term;
    result = substituteInExpression(c, result, {
      resolve: access => access.positions.length === 0 && access.name === variableName ? term : undefined,
      bound: departed.bindsCertainly ? new Set([ variableName ]) : new Set<string>(),
    }, cVars);
  }
  return result;
}

/**
 * The bind a stayer becomes once the binds below it have left: whatever it read of them is written into its
 * expression, since down there those variables are no longer bound.
 * @param c - The transformation context
 * @param chain - Every floating bind of the stayer's own chain
 * @param stayer - The bind that is staying
 * @returns its bind, rewritten where it has to be and handed back unchanged where it does not
 */
function rebindStayerAfterDepartures(
  c: TransformContext,
  chain: readonly FloatingBind[],
  stayer: FloatingBind,
): ChainBind {
  // Only what left from *below* it is written in. A bind that stood above the stayer wrote a variable the
  // stayer read as unbound anyway, and reads it as unbound still now that it is gone.
  const departedBelow = chain.filter(floatingBind =>
    floatingBind.chainPosition < stayer.chainPosition && floatingBind.disposition !== 'stay');
  if (departedBelow.length === 0) {
    return stayer.bind;
  }
  const cVars = differenceSets(
    stayer.scopeBelowBind.cVars,
    new Set(departedBelow.map(departed => departed.bind.variable.value)),
  );
  const expression = substituteDepartedBinds(c, stayer.bind.expression, departedBelow, cVars);
  return { ...stayer.bind, expression, reads: collectVariableNames(c.astTransformer, expression) };
}

/**
 * Rebuilds the operation from what the partition decided: the stayers back around their cores, the node
 * itself around those, and the risers above it.
 * @param c - The transformation context
 * @param peeled - The peeled inputs and their settled floating binds
 * @param rebuildNode - Builds the operation back around its new inputs, and edits whatever it reads
 * @returns the rewritten operation
 */
function assembleRewrittenNode(
  c: TransformContext,
  peeled: PeeledInputs,
  rebuildNode: (inputs: Algebra.Operation[], risers: FloatingBind[]) => Algebra.Operation,
): Algebra.Operation {
  // Every node here is freshly built, so none of them carries the `CPMeta` a licence cached on the plan
  // the rewrite has just invalidated. The cores keep theirs, which is correct: nothing below one changed.
  const inputs = peeled.chains.map((chain, index) => replantExtends(
    c,
    chain.core,
    peeled.bindsPerInput[index]
      .filter(floatingBind => floatingBind.disposition === 'stay')
      .map(stayer => rebindStayerAfterDepartures(c, peeled.bindsPerInput[index], stayer)),
  ));
  // Ordered by input index and then by chain order, so the relative order of two binds that rose from one
  // chain is the one they had - and a merged bind, which is written out by its representative alone,
  // appears exactly once.
  const risers = peeled.allBinds.filter(floatingBind => floatingBind.disposition === 'rise');
  return replantExtends(c, rebuildNode(inputs, risers), risers.map(floatingBind => floatingBind.bind));
}

/**
 * Whether nothing at all was decided, in which case the operation is handed back untouched.
 * @param peeled - The settled floating binds of the operation
 * @returns whether every one of them stays
 */
function noBindLeaves(peeled: PeeledInputs): boolean {
  return peeled.allBinds.every(floatingBind => floatingBind.disposition === 'stay');
}

/**
 * Floats binds through an operation that changes neither which variables a solution binds nor how many
 * solutions there are: a `DISTINCT`, a `REDUCED`, a `SLICE` or a `FROM`.
 * @param c - The transformation context
 * @param op - The operation to float through
 * @param sealed - Whether it is part of the query's solution-modifier chain, which nothing rises into
 * @param rebuildOperation - Builds it back around its new input
 * @returns the rewritten operation
 */
function floatThroughCongruentOperation(
  c: TransformContext,
  op: Algebra.Distinct | Algebra.Reduced | Algebra.Slice | Algebra.From,
  sealed: boolean,
  rebuildOperation: (input: Algebra.Operation) => Algebra.Operation,
): Algebra.Operation {
  const peeled = peelInputs(c, [ op.input ]);
  // Unconditional, and it is worth saying why for each: `e` is a deterministic function of the row, so the
  // extra column never refines the equivalence classes a DISTINCT or a REDUCED deduplicates over; and an
  // EXTEND is a bijection on rows that preserves their order, so it commutes with a SLICE. That last one
  // is one of the few places the pull-up goes where the pushdown may not.
  for (const floatingBind of peeled.allBinds) {
    floatingBind.disposition = floatingBind.expressionIsStable ? 'rise' : 'stay';
  }
  if (sealed) {
    pinEveryRise(peeled);
  }
  settlePartition(c, peeled, () => true);
  return noBindLeaves(peeled) ?
    op :
    assembleRewrittenNode(c, peeled, inputs => rebuildOperation(inputs[0]));
}

/**
 * Floats binds through a `FILTER`, whose condition is its one reader.
 * @param c - The transformation context
 * @param filter - The filter to float through
 * @returns the rewritten operation
 */
function floatThroughFilter(c: TransformContext, filter: Algebra.Filter): Algebra.Operation {
  const peeled = peelInputs(c, [ filter.input ]);
  for (const floatingBind of peeled.allBinds) {
    floatingBind.disposition = floatingBind.expressionIsStable ? 'rise' : 'stay';
  }
  settlePartition(c, peeled, floatingBind =>
    allReadersAdmitSubstitution(c, peeled, [ filter.expression ], floatingBind));
  return noBindLeaves(peeled) ?
    filter :
    assembleRewrittenNode(c, peeled, (inputs, risers) => c.AF.createFilter(
      inputs[0],
      substituteDepartedBinds(c, filter.expression, risers, cpMetaOf(inputs[0]).cVars),
    ));
}

/**
 * Floats binds through an `ORDER_BY`, whose ordering expressions are its readers.
 * @param c - The transformation context
 * @param orderBy - The ordering to float through
 * @param sealed - Whether it is part of the query's solution-modifier chain, which nothing rises into
 * @returns the rewritten operation
 */
function floatThroughOrderBy(c: TransformContext, orderBy: Algebra.OrderBy, sealed: boolean): Algebra.Operation {
  const peeled = peelInputs(c, [ orderBy.input ]);
  // An EXTEND maps element-wise and preserves the sequence, so the order the comparators produce is the
  // same whether the bind is applied below or above them.
  for (const floatingBind of peeled.allBinds) {
    floatingBind.disposition = floatingBind.expressionIsStable ? 'rise' : 'stay';
  }
  if (sealed) {
    pinEveryRise(peeled);
  }
  settlePartition(c, peeled, floatingBind =>
    allReadersAdmitSubstitution(c, peeled, orderBy.expressions, floatingBind));
  return noBindLeaves(peeled) ?
    orderBy :
    assembleRewrittenNode(c, peeled, (inputs, risers) => {
      const cVars = cpMetaOf(inputs[0]).cVars;
      return c.AF.createOrderBy(
        inputs[0],
        orderBy.expressions.map(expression => substituteDepartedBinds(c, expression, risers, cVars)),
      );
    });
}

/**
 * Floats binds through a `PROJECT`, the main drop site: a bind of a variable it does not list is deleted,
 * and one it does list may rise instead, struck from the list as it goes.
 * @param c - The transformation context
 * @param project - The projection to float through
 * @param sealed - Whether it is the query's own projection, above which a `BIND` cannot be written
 * @returns the rewritten operation
 */
function floatThroughProject(c: TransformContext, project: Algebra.Project, sealed: boolean): Algebra.Operation {
  const peeled = peelInputs(c, [ project.input ]);
  const projected = new Set(project.variables.map(variable => variable.value));
  // Dropping is sound because nothing above the projection can read the variable and `Extend` is total, so
  // the multiset above is unchanged. Rising needs `V ⊆ variables` so that `e` can still be evaluated up
  // there, and strikes `?x` from the list - not for (C1), which a projection satisfies either way, but so
  // that the sub-SELECT does not carry an always-unbound column. `pVars` at the swap is unchanged:
  // `(variables \ {?x}) ∪ {?x}`.
  for (const floatingBind of peeled.allBinds) {
    if (!floatingBind.expressionIsStable) {
      continue;
    }
    // A drop would in fact be sound for an *unstable* `e` too - `Extend` is one row in, one row out
    // whatever it computes - but the gate is uniform in this phase, and phase 2 revisits dropping whole.
    if (!projected.has(floatingBind.bind.variable.value)) {
      floatingBind.disposition = 'drop';
    } else if ([ ...floatingBind.bind.reads ].every(readVariable => projected.has(readVariable))) {
      floatingBind.disposition = 'rise';
    }
  }
  if (sealed) {
    pinEveryRise(peeled);
  }
  settlePartition(c, peeled, () => true);
  return noBindLeaves(peeled) ?
    project :
    assembleRewrittenNode(c, peeled, (inputs, risers) => {
      const struckVariables = new Set(risers.map(riser => riser.bind.variable.value));
      return c.AF.createProject(
        inputs[0],
        project.variables.filter(variable => !struckVariables.has(variable.value)),
      );
    });
}

/**
 * Floats binds through a `GROUP`, which is the second drop site and a barrier otherwise: a bind may be
 * deleted when the grouping cannot see its variable at all.
 * @param c - The transformation context
 * @param group - The grouping to float through
 * @returns the rewritten operation
 */
function floatThroughGroup(c: TransformContext, group: Algebra.Group): Algebra.Operation {
  const peeled = peelInputs(c, [ group.input ]);
  // A grouping sees three things, and the third is the easy one to forget: its keys, the variables each
  // aggregate *writes*, and the variables each aggregate *reads* - an `aggregates` entry is a
  // `BoundAggregate`, an expression over the input beside the variable it writes, so
  // `GROUP BY ?k (SUM(?x) AS ?s)` reads an `?x` that is neither key nor target. Anything it sees stays:
  // hoisting past the aggregation would change the aggregate.
  const visibleToGrouping = new Set(group.variables.map(variable => variable.value));
  for (const aggregate of group.aggregates) {
    visibleToGrouping.add(aggregate.variable.value);
    for (const readVariable of collectVariableNames(c.astTransformer, aggregate.expression)) {
      visibleToGrouping.add(readVariable);
    }
  }
  for (const floatingBind of peeled.allBinds) {
    if (floatingBind.expressionIsStable && !visibleToGrouping.has(floatingBind.bind.variable.value)) {
      floatingBind.disposition = 'drop';
    }
  }
  settlePartition(c, peeled, () => true);
  return noBindLeaves(peeled) ?
    group :
    assembleRewrittenNode(c, peeled, inputs => c.AF.createGroup(inputs[0], group.variables, group.aggregates));
}

/**
 * Floats binds through a `GRAPH`, which binds its graph variable *outside* the pattern below it.
 * @param c - The transformation context
 * @param graph - The graph operation to float through
 * @returns the rewritten operation
 */
function floatThroughGraph(c: TransformContext, graph: Algebra.Graph): Algebra.Operation {
  const peeled = peelInputs(c, [ graph.input ]);
  const graphVariableName = graph.name.termType === 'Variable' ? graph.name.value : undefined;
  // SPARQL evaluates a GRAPH as a union over the named graphs, each joined with the binding of the graph
  // variable *outside* the pattern, so `?g` is bound above where the pattern below may leave it unbound. A
  // bind reading `?g` may therefore only rise when the pattern binds it certainly anyway, and a bind
  // *writing* `?g` may never rise - that is (C1) with the operation itself as the other binder.
  for (const floatingBind of peeled.allBinds) {
    const mayRise = graphVariableName === undefined || (
      floatingBind.bind.variable.value !== graphVariableName &&
      (!floatingBind.bind.reads.has(graphVariableName) || floatingBind.scopeBelowBind.cVars.has(graphVariableName))
    );
    floatingBind.disposition = floatingBind.expressionIsStable && mayRise ? 'rise' : 'stay';
  }
  settlePartition(c, peeled, () => true);
  return noBindLeaves(peeled) ?
    graph :
    assembleRewrittenNode(c, peeled, inputs => c.AF.createGraph(inputs[0], graph.name));
}

/**
 * Floats binds through a `JOIN`, the operation the whole pass exists for: one operand's bind rises under
 * (C1) and (C2), and a bind several operands carry rises under the merge rule instead.
 * @param c - The transformation context
 * @param join - The join to float through
 * @returns the rewritten operation
 */
function floatThroughJoin(c: TransformContext, join: Algebra.Join): Algebra.Operation {
  const peeled = peelInputs(c, join.input);
  // Read before any rewriting: the licences are about the operands as they stand.
  const operands = join.input.map(input => cpMetaOf(input));
  groupIdenticalBinds(c, peeled);
  for (const floatingBind of peeled.allBinds) {
    if (!floatingBind.expressionIsStable || floatingBind.disposition !== 'stay') {
      continue;
    }
    const carriers = floatingBind.mustLeaveWith;
    if (carriers.length > 1) {
      // The merge: `Join(Extend(A, ?x, e), Extend(B, ?x, e)) ≡ Extend(Join(A, B), ?x, e)` whenever every
      // carrier has all of `V` certainly bound, since join compatibility then forces every `?y ∈ V` to one
      // value across the merge and `e` is stable, so every carrier computed the same `?x`: that component
      // of the compatibility test is a tautology and the copies collapse into one. Multiplicity is
      // untouched, no pair of rows having been rejected on `?x` - and a carrier short of `V` keeps its own
      // copy, the values `e` is asked about not being the ones the merged row holds.
      const mergeable = carriers.every(carrier => [ ...carrier.bind.reads ]
        .every(readVariable => carrier.scopeBelowBind.cVars.has(readVariable))) &&
        nothingElseBindsTheVariable(floatingBind, carriers, operands);
      if (mergeable) {
        letGroupLeave(carriers);
      }
      continue;
    }
    // A single carrier: (C1) over the siblings, (C2) per variable of `e`, and the cost gate. The gate: a
    // term expression is free to re-evaluate, so its pull-up is a pure win, but a join may *increase*
    // cardinality, so anything else can end up evaluated more often than the original. Past a join a
    // non-term expression therefore rises only under the merge above, which deletes an evaluation
    // outright. It is a trade rather than a truth - a single-carrier rise wins whenever the join is
    // selective and loses whenever it fans out, and nothing in the algebra says which - so it is worth
    // revisiting if cardinality estimates ever reach this pass.
    const readsSameValuesAbove = [ ...floatingBind.bind.reads ].every(readVariable =>
      floatingBind.scopeBelowBind.cVars.has(readVariable) ||
      noOtherOperandBinds(readVariable, floatingBind.inputIndex, operands));
    if (floatingBind.bind.expression.subType === Algebra.ExpressionTypes.TERM &&
      nothingElseBindsTheVariable(floatingBind, carriers, operands) && readsSameValuesAbove) {
      floatingBind.disposition = 'rise';
    }
  }
  settlePartition(c, peeled, () => true);
  return noBindLeaves(peeled) ?
    join :
    assembleRewrittenNode(c, peeled, inputs => c.AF.createJoin(inputs, false));
}

/**
 * Floats binds through a `LEFT_JOIN`, from its left-hand side only.
 * @param c - The transformation context
 * @param leftJoin - The optional to float through
 * @returns the rewritten operation
 */
function floatThroughLeftJoin(c: TransformContext, leftJoin: Algebra.LeftJoin): Algebra.Operation {
  const peeled = peelInputs(c, leftJoin.input);
  const operands = leftJoin.input.map(input => cpMetaOf(input));
  // Hoisting out of the right-hand side would bind `?x` on the unmatched left rows, where it has to stay
  // unbound; dropping one there needs to know that nothing above reads it, which is the analysis phase 2
  // brings. Out of the left, the anti-join half computes `e` on `μ_L` either way and the matched half is
  // the JOIN argument, so what is needed is (C1) against the right operand, (C2) per variable of `e`, and
  // a condition that either does not read `?x` or takes `e` written into it - exactly a FILTER.
  // TODO(phase 2): a right-hand side carrying the identical bind merges with the left, under
  // `V ⊆ cVars(L) ∩ cVars(R)`.
  for (const floatingBind of peeled.allBinds) {
    const readsSameValuesAbove = [ ...floatingBind.bind.reads ].every(readVariable =>
      floatingBind.scopeBelowBind.cVars.has(readVariable) ||
      noOtherOperandBinds(readVariable, floatingBind.inputIndex, operands));
    floatingBind.disposition = floatingBind.expressionIsStable &&
      floatingBind.inputIndex === 0 &&
      floatingBind.bind.expression.subType === Algebra.ExpressionTypes.TERM &&
      nothingElseBindsTheVariable(floatingBind, floatingBind.mustLeaveWith, operands) &&
      readsSameValuesAbove ?
      'rise' :
      'stay';
  }
  const readers = leftJoin.expression === undefined ? [] : [ leftJoin.expression ];
  settlePartition(c, peeled, floatingBind => allReadersAdmitSubstitution(c, peeled, readers, floatingBind));
  return noBindLeaves(peeled) ?
    leftJoin :
    assembleRewrittenNode(c, peeled, (inputs, risers) => c.AF.createLeftJoin(
      inputs[0],
      inputs[1],
      leftJoin.expression === undefined ?
        undefined :
        substituteDepartedBinds(c, leftJoin.expression, risers, cpMetaOf(inputs[0]).cVars),
    ));
}

/**
 * Floats binds through a `MINUS`, from its left-hand side only.
 * @param c - The transformation context
 * @param minus - The minus to float through
 * @returns the rewritten operation
 */
function floatThroughMinus(c: TransformContext, minus: Algebra.Minus): Algebra.Operation {
  const peeled = peelInputs(c, minus.input);
  const operands = minus.input.map(input => cpMetaOf(input));
  // `pVars(Minus) = pVars(L)`, so the output mapping *is* `μ_L` and (C2) is vacuous, as it is for a UNION.
  // What the licence has to rule out is the right-hand side binding `?x`: it would change both the
  // compatibility test and the domain-disjointness test, neither of which the hoisted bind is above.
  // Hoisting out of the right is meaningless - its bindings are out of scope above it - and dropping one
  // there waits for phase 2, licensed by `L.vRanges.neverBinds(?x)` rather than by the `needed` analysis.
  for (const floatingBind of peeled.allBinds) {
    floatingBind.disposition = floatingBind.expressionIsStable &&
      floatingBind.inputIndex === 0 &&
      nothingElseBindsTheVariable(floatingBind, floatingBind.mustLeaveWith, operands) ?
      'rise' :
      'stay';
  }
  settlePartition(c, peeled, () => true);
  return noBindLeaves(peeled) ?
    minus :
    assembleRewrittenNode(c, peeled, (inputs) => {
      const rebuiltMinus = c.AF.createMinus(inputs[0], inputs[1]);
      // The graph-scope marker is not a licence of ours to drop: it tells an engine that the disjointness
      // test has to ignore a `?g` bound outside the MINUS, which is as true after the rewrite as before.
      if (minus.graphScopeVar !== undefined) {
        rebuiltMinus.graphScopeVar = minus.graphScopeVar;
      }
      return rebuiltMinus;
    });
}

/**
 * Floats binds through a `UNION`, which only ever hoists a bind **every** branch carries.
 * @param c - The transformation context
 * @param union - The union to float through
 * @returns the rewritten operation
 */
function floatThroughUnion(c: TransformContext, union: Algebra.Union): Algebra.Operation {
  const peeled = peelInputs(c, union.input);
  groupIdenticalBinds(c, peeled);
  // A solution of a union comes from exactly one branch, so the solution above *is* the branch solution and
  // `e` is asked about the same μ either way - there is no (C2) obligation at all. What there is instead is
  // this all-or-nothing condition: hoisting from one branch alone would bind `?x` in the others' solutions,
  // and adding the bind to the others instead would *grow* `cVars(union)`, a wrong answer rather than a
  // conservative one.
  for (const floatingBind of peeled.allBinds) {
    if (floatingBind.disposition === 'stay' && floatingBind.expressionIsStable &&
      floatingBind.mustLeaveWith.length === union.input.length) {
      letGroupLeave(floatingBind.mustLeaveWith);
    }
  }
  settlePartition(c, peeled, () => true);
  return noBindLeaves(peeled) ?
    union :
    assembleRewrittenNode(c, peeled, inputs => c.AF.createUnion(inputs, false));
}

/**
 * Collects the floating binds of different inputs that are the *same* bind, which is what a merge and the
 * `UNION` rule are about. Only a stable bind is grouped, and a group holds at most one bind per input.
 * @param c - The transformation context
 * @param peeled - The floating binds to group, whose {@link FloatingBind.mustLeaveWith} this writes
 */
function groupIdenticalBinds(c: TransformContext, peeled: PeeledInputs): void {
  const groupsByVariable = new Map<string, FloatingBind[][]>();
  for (const floatingBind of peeled.allBinds) {
    if (!floatingBind.expressionIsStable) {
      continue;
    }
    const groups = groupsByVariable.get(floatingBind.bind.variable.value) ?? [];
    groupsByVariable.set(floatingBind.bind.variable.value, groups);
    const matchingGroup = groups.find(group =>
      group[0].inputIndex !== floatingBind.inputIndex &&
      expressionsEqual(group[0].bind.expression, floatingBind.bind.expression));
    if (matchingGroup === undefined) {
      groups.push(floatingBind.mustLeaveWith);
    } else {
      matchingGroup.push(floatingBind);
      floatingBind.mustLeaveWith = matchingGroup;
    }
  }
}

/**
 * Lets a whole group leave: its first member is written out above the operation, the rest are absorbed
 * into that one copy.
 * @param group - The group to mark
 */
function letGroupLeave(group: FloatingBind[]): void {
  for (const [ index, member ] of group.entries()) {
    member.disposition = index === 0 ? 'rise' : 'absorb';
  }
}

/**
 * (C1), read on the ranges: whether no solution reaching the re-planted `EXTEND` already binds `?x`.
 * @param floatingBind - The bind that wants to rise
 * @param carriers - The binds leaving with it, which are the operands that do not have to answer
 * @param operands - What each operand of the operation binds
 * @returns whether nothing else can bind the variable
 */
function nothingElseBindsTheVariable(
  floatingBind: FloatingBind,
  carriers: readonly FloatingBind[],
  operands: readonly CPMeta[],
): boolean {
  // Read as `neverBinds` rather than as scope on purpose. Nothing forbids `?x` being *in scope* in another
  // operand; what the spec leaves undefined is extending a μ that already **binds** `?x`. So an all-UNDEF
  // VALUES column is a legitimate hoist target. A carrier is not a binder here either, its copy of the
  // bind being deleted by the same rewrite.
  const variableName = floatingBind.bind.variable.value;
  const carrying = new Set(carriers.map(carrier => carrier.inputIndex));
  return operands.every((operand, index) => carrying.has(index) || operand.vRanges.neverBinds(variableName));
}

/**
 * The second disjunct of (C2): no operand other than the one the bind rises out of can bind `?y`, so the
 * merged solution holds whatever that operand gave it.
 * @param variableName - The variable `e` reads
 * @param carrierIndex - The index of the operand the bind rises out of
 * @param operands - What each operand of the operation binds
 * @returns whether nothing else can bind it
 */
function noOtherOperandBinds(
  variableName: string,
  carrierIndex: number,
  operands: readonly CPMeta[],
): boolean {
  return operands.every((operand, index) =>
    index === carrierIndex || operand.vRanges.neverBinds(variableName));
}
