import { Algebra } from '@traqula/algebra-transformations-1-2';

/**
 * @fileoverview The chain of solution modifiers at the top of a query.
 *
 * What a pass is handed at its root is a whole query as often as it is a subtree, and the operations
 * between that root and the pattern the query is about - its `PROJECT`, its `DISTINCT`, its `LIMIT` - are
 * what decides the query's *answer*: which columns it exposes, in what form, and how many rows of it. A
 * subtree may be rewritten into anything with the same solutions; those nodes may not, because a caller
 * reads the result off them. So passes seal them, each for its own reason - nothing rises into them
 * ({@link transformations/pullUpExtends!pullUpExtends}), nothing collapses them
 * ({@link transformations/filterFalse!transformFilterFalse}) - and the chain itself is shared.
 */

/**
 * The operation types that make up a query's solution-modifier chain.
 *
 * An `ORDER_BY` is deliberately absent. It stands *below* the projection, so what a pass does there is
 * still inside the pattern rather than to the query's answer, and stopping the walk at one costs nothing:
 * a query's chain holds no further modifier below its ordering.
 */
const solutionModifierTypes = new Set<string>([
  Algebra.Types.ASK,
  Algebra.Types.CONSTRUCT,
  Algebra.Types.DESCRIBE,
  Algebra.Types.PROJECT,
  Algebra.Types.DISTINCT,
  Algebra.Types.REDUCED,
  Algebra.Types.SLICE,
  Algebra.Types.FROM,
]);

/**
 * The nodes of the solution-modifier chain at the top of `root`.
 * @param root - The root of the tree the traversal is about to run over
 * @returns those nodes, by identity, so that a callback can recognise its own original
 */
export function solutionModifierChainOf(root: Algebra.Operation): Set<Algebra.Operation> {
  const sealed = new Set<Algebra.Operation>();
  let current = root;
  while (solutionModifierTypes.has(current.type)) {
    sealed.add(current);
    current = (<Algebra.Single> current).input;
  }
  return sealed;
}
