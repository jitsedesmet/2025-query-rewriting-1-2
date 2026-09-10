import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse, isEmptyOperation } from '../utils/operationhelpers.js';
import { solutionModifierChainOf } from '../utils/solutionModifierChain.js';

/**
 * @fileoverview FILTER(FALSE) simplification transformation.
 *
 * In SPARQL algebra `FILTER(FALSE)` represents the empty solution multiset, so the operations around one
 * simplify by the algebraic identities of that multiset - absorbing for JOIN, identity for UNION.
 *
 * Emptiness is read through {@link utils/operationhelpers!isEmptyOperation} rather than off the node
 * itself, which is what lets it climb out of a sub-SELECT. `operationTransform` wraps every mapper branch
 * in one, so a branch the assertion pushdown proves empty leaves its `FILTER(FALSE)` under a PROJECT, and
 * a rule that only recognised the bare sentinel stopped there - leaving the EXTENDs above unabsorbed and
 * the dead UNION branch in the generated query, guarded by a `FILTER(false)` an engine still plans a scan
 * for.
 *
 * A PROJECT is therefore *recognised* as empty but never *replaced*. `pVars(Empty_S) := S`, and in this
 * algebra the only operation carrying a sub-SELECT's columns is the projection itself: replacing it by a
 * `FILTER(FALSE)` over the empty BGP would silently take those columns out of scope. Recognising without
 * rewriting is also what keeps the pass idempotent, a preserved node having nothing left to do on a
 * second run.
 *
 * The query's own solution modifiers are sealed on top of that ({@link
 * utils/solutionModifierChain!solutionModifierChainOf}). `queryTransform` strips them before it runs a
 * pass and puts them back afterwards, but this one is exported publicly, and an empty `SELECT DISTINCT ?a
 * ?b LIMIT 10` handed to it directly is still a `SELECT DISTINCT ?a ?b LIMIT 10` - the caller reads its
 * answer off exactly those nodes. Everything below them collapses as it always did.
 */

/**
 * Simplifies algebra by removing or propagating `FILTER(FALSE)` patterns:
 *
 * - JOIN over an empty operand becomes FILTER(FALSE) (absorbing element)
 * - UNION over an empty branch drops that branch (identity element)
 * - EXTEND/DISTINCT/etc. over an empty input becomes FILTER(FALSE)
 * - MINUS/LEFT JOIN whose right operand is empty becomes its left operand
 * - PROJECT over an empty input counts as empty for all of the above, and is kept as it stands
 * - GROUP is where emptiness stops, and so is the query's own solution-modifier chain
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
      [Algebra.Types.MINUS]: { transform: (minus) => {
        const [ left, right ] = minus.input;
        // If left FF → FF, if right FF → just left
        if (isEmptyOperation(c, left) || isEmptyOperation(c, right)) {
          return left;
        }
        return minus;
      } },
      [Algebra.Types.LEFT_JOIN]: { transform: (leftJoin) => {
        // https://www.w3.org/TR/sparql12-query/#defn_algLeftJoin
        const [ left, right ] = leftJoin.input;
        // If left FF → FF, if right FF → just left
        if (isEmptyOperation(c, left) || isEmptyOperation(c, right)) {
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
      // A PROJECT needs no callback of its own: it is empty exactly when its input is, and that is what
      // the operations above it read. Rewriting it is what would cost the sub-SELECT its columns, sealed
      // or not.
      // TODO: exists and not exists
    },
  );
}

/**
 * Handles single-input operations over an empty input: any operation over an empty input is empty.
 * @param c - The transformation context
 * @param single - A single-input operation
 * @param isSealed - Whether it is part of the query's own solution-modifier chain
 * @returns FILTER(FALSE) if the input is empty, otherwise the original operation
 */
function absorbingSingle(
  c: TransformContext,
  single: Algebra.Single,
  isSealed: boolean,
): Algebra.Single {
  // A sealed operation is what the caller reads the query's answer off, so it stays even though it is
  // empty - and it stays *empty*, which is what everything above keeps propagating.
  if (!isSealed && isEmptyOperation(c, single.input)) {
    return createFilterFalse(c);
  }
  return single;
}

/**
 * JOIN is absorbing for the empty multiset: one empty operand makes the whole join empty.
 * @param c - The transformation context
 * @param join - The JOIN operation
 * @returns FILTER(FALSE) if any input is empty, otherwise the original JOIN
 */
function absorbJoinOnEmptyBindings(c: TransformContext, join: Algebra.Join): Algebra.Join | Algebra.Filter {
  for (const op of join.input) {
    if (isEmptyOperation(c, op)) {
      return createFilterFalse(c);
    }
  }
  return join;
}

/**
 * The empty multiset is the identity element for UNION, so its empty branches are dropped.
 * @param c - The transformation context
 * @param union - The UNION operation
 * @returns FILTER(FALSE) when every branch was empty, the single remaining branch when one is left, and the
 * UNION without its empty branches otherwise
 */
function pruneUnionOfEmptyBindings(c: TransformContext, union: Algebra.Union): Algebra.Operation {
  union.input = union.input.filter(branch => !isEmptyOperation(c, branch));
  if (union.input.length > 1) {
    return union;
  }
  if (union.input.length === 1) {
    return union.input[0];
  }
  // If emptyUnion, return filterFalse
  return createFilterFalse(c);
}
