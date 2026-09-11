import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse, isFilterFalse } from '../utils/operationhelpers.js';
import { solutionModifierChainOf } from '../utils/solutionModifierChain.js';

/**
 * @fileoverview FILTER(FALSE) simplification transformation.
 *
 * In SPARQL algebra `FILTER(FALSE)` represents the empty solution multiset, so the operations around one
 * simplify by the algebraic identities of that multiset - absorbing for JOIN, identity for UNION.
 *
 * The traversal is bottom-up, so by the time an operation is visited everything below it has already
 * collapsed: an operation is empty exactly when one of its inputs *is* `FILTER(FALSE)`, and that is all a
 * rule has to look at.
 *
 * What is dropped with an empty operation is its scope as well as its (absent) solutions, and that is
 * sound. No solution of it binds anything, and SPARQL's scope rules only ever forbid a variable that is
 * *already* in scope - a `BIND(… AS ?v)`, a `SELECT (… AS ?v)` - so taking variables out of scope can not
 * break one. The replacement has to be a *fresh* `FILTER(FALSE)` for that to hold, though, never the input
 * of what it replaces: the pushdown builds its `FILTER(FALSE)` over the operation it replaced, and lifting
 * that out of a sub-SELECT would bring the variables the projection hid back into scope.
 *
 * The one place scope is observable is the query's own answer: its columns, its DISTINCT, its LIMIT. Those
 * nodes are sealed ({@link utils/solutionModifierChain!solutionModifierChainOf}) - `queryTransform` strips
 * them before a pass and puts them back afterwards, but this pass is exported publicly, and an empty
 * `SELECT DISTINCT ?a ?b LIMIT 10` handed to it directly is still a `SELECT DISTINCT ?a ?b LIMIT 10`.
 * Inside `queryTransform` the root is the query's WHERE clause instead, so a sub-SELECT that makes up the
 * whole of it is sealed too; that costs nothing, its answer being the query's answer.
 */

/**
 * Simplifies algebra by removing or propagating `FILTER(FALSE)` patterns:
 *
 * - JOIN over FILTER(FALSE) becomes FILTER(FALSE) (absorbing element)
 * - UNION over FILTER(FALSE) drops that branch (identity element)
 * - PROJECT/EXTEND/DISTINCT/etc. over FILTER(FALSE) becomes FILTER(FALSE), so emptiness climbs out of a
 *   sub-SELECT
 * - MINUS/LEFT JOIN whose right operand is FILTER(FALSE) becomes its left operand
 * - GROUP is not absorbing, since an aggregate over nothing still returns a row
 * - the query's own solution modifiers (its PROJECT, DISTINCT, LIMIT, ...) are left in place
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns the simplified operation
 */
export function transformFilterFalse(c: TransformContext, op: Algebra.Operation): Algebra.Operation {
  const sealed = solutionModifierChainOf(op);
  const absorbSingle = { transform: (x: Algebra.Single, original: Algebra.Operation): Algebra.Single =>
    absorbingSingle(c, x, sealed.has(original)) };
  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    {
      [Algebra.Types.JOIN]: { transform: join => absorbJoinOnEmptyBindings(c, join) },
      [Algebra.Types.UNION]: { transform: union => pruneUnionOfEmptyBindings(c, union) },

      [Algebra.Types.PROJECT]: absorbSingle,
      [Algebra.Types.EXTEND]: absorbSingle,
      [Algebra.Types.FROM]: absorbSingle,
      [Algebra.Types.DISTINCT]: absorbSingle,
      [Algebra.Types.FILTER]: absorbSingle,
      // TODO: wrong in case of silent!!!
      [Algebra.Types.SERVICE]: absorbSingle,
      [Algebra.Types.REDUCED]: absorbSingle,
      [Algebra.Types.SLICE]: absorbSingle,
      [Algebra.Types.GRAPH]: absorbSingle,
      [Algebra.Types.ORDER_BY]: absorbSingle,
      // A GROUP is deliberately absent: an aggregate without a GROUP BY over an empty input still returns
      // a single row - `COUNT(*)` of nothing is `0` - so it is not empty.
      [Algebra.Types.MINUS]: { transform: (minus) => {
        const [ left, right ] = minus.input;
        // If left FF → FF, if right FF → just left
        if (isFilterFalse(c, left) || isFilterFalse(c, right)) {
          return left;
        }
        return minus;
      } },
      [Algebra.Types.LEFT_JOIN]: { transform: (leftJoin) => {
        // https://www.w3.org/TR/sparql12-query/#defn_algLeftJoin
        const [ left, right ] = leftJoin.input;
        // If left FF → FF, if right FF → just left
        if (isFilterFalse(c, left) || isFilterFalse(c, right)) {
          return left;
        }
        return leftJoin;
      } },
      [Algebra.Types.VALUES]: { transform: (values) => {
        if (values.bindings.length === 0) {
          return createFilterFalse(c);
        }
        return values;
      } },
      // TODO: exists and not exists
    },
  );
}

/**
 * Handles single-input operations over `FILTER(FALSE)`: any operation over an empty input is empty.
 * @param c - The transformation context
 * @param single - A single-input operation
 * @param isSealed - Whether it is part of the query's own solution-modifier chain
 * @returns FILTER(FALSE) if the input is empty and the operation is not sealed, otherwise the original
 * operation
 */
function absorbingSingle(
  c: TransformContext,
  single: Algebra.Single,
  isSealed: boolean,
): Algebra.Single {
  // A sealed operation is what the caller reads the query's answer off, so it stays even though it is
  // empty. Nothing above it is left to absorb it: what stands above a sealed node is sealed too.
  if (!isSealed && isFilterFalse(c, single.input)) {
    return createFilterFalse(c);
  }
  return single;
}

/**
 * JOIN is absorbing for `FILTER(FALSE)`: one empty operand makes the whole join empty.
 * @param c - The transformation context
 * @param join - The JOIN operation
 * @returns FILTER(FALSE) if any input is empty, otherwise the original JOIN
 */
function absorbJoinOnEmptyBindings(c: TransformContext, join: Algebra.Join): Algebra.Join | Algebra.Filter {
  for (const op of join.input) {
    if (isFilterFalse(c, op)) {
      return createFilterFalse(c);
    }
  }
  return join;
}

/**
 * `FILTER(FALSE)` is the identity element for UNION, so its branches are dropped.
 * @param c - The transformation context
 * @param union - The UNION operation
 * @returns FILTER(FALSE) when every branch was empty, the single remaining branch when one is left, and the
 * UNION without its empty branches otherwise
 */
function pruneUnionOfEmptyBindings(c: TransformContext, union: Algebra.Union): Algebra.Operation {
  union.input = union.input.filter(branch => !isFilterFalse(c, branch));
  if (union.input.length > 1) {
    return union;
  }
  if (union.input.length === 1) {
    return union.input[0];
  }
  // If emptyUnion, return filterFalse
  return createFilterFalse(c);
}
