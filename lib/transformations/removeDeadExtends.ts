import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { collectVariableNames } from '../utils.js';

/**
 * The variables that may still be observed above the operation being visited.
 * `null` means "unknown", in which case no bind is considered dead.
 */
type LiveVariables = Set<string> | null;

/**
 * Removes `BIND`s whose variable can no longer be observed:
 *
 * ```
 * Project(Extend(P, ?v, <a>), ?x)   ->   Project(P, ?x)
 * ```
 *
 * An `Extend` never changes the cardinality of its input - it only adds a column - so dropping one
 * is invisible as soon as nothing above reads that column. Which variables are read is computed
 * top-down: a `PROJECT` narrows the live set to the variables it projects, every other operation
 * adds the variables it mentions itself (a filter condition, an ordering expression, a group key,
 * ...) and, for the multi-operand operations, the variables its *siblings* mention - those still
 * join on the bound variable.
 *
 * The pass complements {@link transformFilterToStaticBind}, which re-binds every variable it
 * substitutes away so that its rewrite is value-preserving. Where such a bind ends up outside the
 * scope of the variable, it is pure overhead and removed here.
 *
 * Only binds of a plain term are dropped: an arbitrary expression is left alone, keeping the pass to
 * the shape the static bind rewrite produces.
 *
 * Note that the operation tree is modified in place.
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The transformed operation
 */
export function removeDeadExtends<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  return <T> pruneDeadExtends(c, op, null);
}

/**
 * Prunes the dead binds of a subtree, given the variables that are still live above it.
 *
 * @param c - The transformation context
 * @param op - The operation to prune
 * @param live - The variables that may be observed above `op`, or null when that is unknown
 * @returns The pruned operation
 */
function pruneDeadExtends(c: TransformContext, op: Algebra.Operation, live: LiveVariables): Algebra.Operation {
  switch (op.type) {
    case Algebra.Types.EXTEND: {
      if (live !== null && !live.has(op.variable.value) &&
        op.expression.subType === Algebra.ExpressionTypes.TERM) {
        return pruneDeadExtends(c, op.input, live);
      }
      op.input = pruneDeadExtends(c, op.input, withVariablesOf(c, live, op.expression));
      return op;
    }
    case Algebra.Types.PROJECT:
      // A projection is a scope boundary: only what it projects can be read above it.
      op.input = pruneDeadExtends(c, op.input, new Set(op.variables.map(variable => variable.value)));
      return op;
    case Algebra.Types.GROUP:
      // Only the group keys and the aggregate results survive a grouping.
      op.input = pruneDeadExtends(c, op.input, withVariablesOf(
        c,
        new Set(op.variables.map(variable => variable.value)),
        ...op.aggregates,
      ));
      return op;
    case Algebra.Types.FILTER:
      op.input = pruneDeadExtends(c, op.input, withVariablesOf(c, live, op.expression));
      return op;
    case Algebra.Types.ORDER_BY:
      op.input = pruneDeadExtends(c, op.input, withVariablesOf(c, live, ...op.expressions));
      return op;
    case Algebra.Types.JOIN:
    case Algebra.Types.MINUS:
    case Algebra.Types.LEFT_JOIN: {
      // Operands are combined on their shared variables, so a bind read by a sibling is live. The
      // OPTIONAL condition reads variables of both operands alike.
      const condition = op.type === Algebra.Types.LEFT_JOIN && op.expression !== undefined ? [ op.expression ] : [];
      op.input = <typeof op.input> op.input.map((operand, index) => pruneDeadExtends(
        c,
        operand,
        withVariablesOf(c, live, ...op.input.filter((_, other) => other !== index), ...condition),
      ));
      return op;
    }
    case Algebra.Types.UNION:
      // Branches of a union are evaluated independently, so nothing is shared between them.
      op.input = op.input.map(branch => pruneDeadExtends(c, branch, live));
      return op;
    case Algebra.Types.DISTINCT:
    case Algebra.Types.REDUCED:
    case Algebra.Types.SERVICE:
      // Duplicate elimination reads the solution as a whole, and a SERVICE is evaluated remotely:
      // in both cases every bind below has to be kept.
      op.input = pruneDeadExtends(c, op.input, null);
      return op;
    case Algebra.Types.GRAPH:
    case Algebra.Types.SLICE:
    case Algebra.Types.FROM:
      op.input = pruneDeadExtends(c, op.input, live);
      return op;
    default:
      return op;
  }
}

/**
 * Extends a live variable set with every variable occurring in the given algebra nodes.
 * Stays `null` (unknown) when it already was.
 */
function withVariablesOf(c: TransformContext, live: LiveVariables, ...nodes: object[]): LiveVariables {
  if (live === null) {
    return null;
  }
  const result = new Set<string>(live);
  for (const node of nodes) {
    for (const name of collectVariableNames(c.astTransformer, node)) {
      result.add(name);
    }
  }
  return result;
}
