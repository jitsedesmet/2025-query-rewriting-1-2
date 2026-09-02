import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { childOperationsOf, collectVariableNames } from '../utils.js';
import { cpMetaOf, stripCachedMetadataInPlace, termVars } from './certainlyBoundVars.js';

/**
 * @fileoverview A top-down *needed* analysis for {@link pullUpExtends}, run once over the plan before the
 * bottom-up pull.
 *
 * Every node is mapped to what its **output** is read for. The pull-up drops a floating bind whose variable
 * is not in what the operation above it needs, which is what catches
 * `OPTIONAL { … BIND(:a AS ?x) }` under a projection that never wanted `?x` - a drop the phase-1
 * direct-child `PROJECT`/`GROUP` rules miss.
 *
 * ```
 * needed(root)  = every variable in pVars(root), unless the caller says otherwise
 * needed(child) = needed(op) ∪ variablesRead(op) ∪ ⋃ { pVars(sibling) : op is join/leftJoin/minus }
 * ```
 *
 * This is the paper's projection pushing read as an analysis rather than as a rewrite: `(PJPush)`/`(PLPush)`
 * push `S ∪ (pVars(A₁) ∩ pVars(A₂))` into both operands, `(PMPush)` that intersection into the right of a
 * `MINUS`, because a variable bound in one operand silently acts as a join key with the other and because
 * `MINUS`' disjointness test reads the *domain*, not the values.
 *
 * Every unhandled node type keeps everything: its children need their whole scope, so the analysis never
 * licenses a drop it cannot prove sound. The precise handling covers the operations the pull-up floats
 * binds through, minus `DISTINCT` and `REDUCED`, below which deleting a column changes what deduplicates.
 */

/** The in-scope variables of an operation - its `pVars`, the key set of its ranges. */
function pVarsOf(op: Algebra.Operation): Set<string> {
  return new Set(cpMetaOf(op).vRanges.keys());
}

/**
 * The variables an operation reads out of its own inputs: every expression, name and variable list it owns.
 * @param c - The transformation context
 * @param op - The operation to read
 * @returns the variables it reads
 */
function variablesReadBy(c: TransformContext, op: Algebra.Operation): Set<string> {
  switch (op.type) {
    case Algebra.Types.FILTER:
    case Algebra.Types.EXTEND:
      return collectVariableNames(c.astTransformer, op.expression);
    case Algebra.Types.ORDER_BY:
      return collectVariableNames(c.astTransformer, op.expressions);
    case Algebra.Types.PROJECT:
      return new Set(op.variables.map(variable => variable.value));
    case Algebra.Types.GROUP: {
      // The three a grouping reads: its keys, and both what every aggregate reads and - through the target
      // never being an input variable - nothing of what it writes.
      const read = new Set(op.variables.map(variable => variable.value));
      for (const aggregate of op.aggregates) {
        for (const name of collectVariableNames(c.astTransformer, aggregate.expression)) {
          read.add(name);
        }
      }
      return read;
    }
    case Algebra.Types.GRAPH:
      return termVars(op.name);
    case Algebra.Types.LEFT_JOIN:
      return op.expression === undefined ? new Set() : collectVariableNames(c.astTransformer, op.expression);
    default:
      return new Set();
  }
}

/**
 * Maps every operation of a plan to the variables its output is read for, top-down.
 * @param c - The transformation context
 * @param op - The root of the plan to analyse
 * @param atRoot - What the caller reads off the root; the whole scope of the root when omitted
 * @returns a map from each operation, by identity, to the variables needed of its output
 */
export function neededVariables(
  c: TransformContext,
  op: Algebra.Operation,
  atRoot?: Iterable<string>,
): Map<Algebra.Operation, Set<string>> {
  const needed = new Map<Algebra.Operation, Set<string>>();

  function visit(node: Algebra.Operation, neededHere: Set<string>): void {
    needed.set(node, neededHere);
    const children = childOperationsOf(node);
    if (children.length === 0) {
      return;
    }
    // An unhandled node type keeps its children's whole scope: a drop there is never licensed. The handled
    // types are exactly those the pull-up floats binds through, so this is the only place precision is lost
    // and it is lost only where no drop is attempted.
    if (!isPreciselyHandled(node.type)) {
      for (const child of children) {
        visit(child, pVarsOf(child));
      }
      return;
    }
    const read = variablesReadBy(c, node);
    const mergesInputs = node.type === Algebra.Types.JOIN ||
      node.type === Algebra.Types.LEFT_JOIN ||
      node.type === Algebra.Types.MINUS;
    for (const [ index, child ] of children.entries()) {
      const childNeeded = new Set([ ...neededHere, ...read ]);
      // A variable bound in a sibling silently joins with this operand, so it has to survive here too.
      if (mergesInputs) {
        for (const [ siblingIndex, sibling ] of children.entries()) {
          if (siblingIndex !== index) {
            for (const name of pVarsOf(sibling)) {
              childNeeded.add(name);
            }
          }
        }
      }
      visit(child, childNeeded);
    }
  }

  visit(op, atRoot === undefined ? pVarsOf(op) : new Set(atRoot));
  // The analysis cached `CPMeta` on the plan as it read `pVars`; strip it so the caller may reuse this
  // exact tree as a transform source without the algebra's copying walk corrupting those cached sets.
  stripCachedMetadataInPlace(op);
  return needed;
}

// The operation types {@link neededVariables} reads precisely rather than conservatively. These are the
// operations the pull-up floats binds through *and* whose output multiset a dropped bind cannot disturb -
// which excludes `DISTINCT` and `REDUCED`, where deleting a column changes what deduplicates.
const preciselyHandledTypes = new Set<string>([
  Algebra.Types.FILTER,
  Algebra.Types.EXTEND,
  Algebra.Types.ORDER_BY,
  Algebra.Types.PROJECT,
  Algebra.Types.GROUP,
  Algebra.Types.GRAPH,
  Algebra.Types.JOIN,
  Algebra.Types.LEFT_JOIN,
  Algebra.Types.MINUS,
  Algebra.Types.UNION,
  Algebra.Types.SLICE,
  Algebra.Types.FROM,
]);

/**
 * Whether {@link neededVariables} reads this operation type precisely rather than keeping its whole scope.
 * @param type - The operation type
 * @returns whether it is one the pull-up floats binds through soundly for dropping
 */
function isPreciselyHandled(type: string): boolean {
  return preciselyHandledTypes.has(type);
}
