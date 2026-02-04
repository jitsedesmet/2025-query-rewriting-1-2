import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse, isFilterFalse, termFalse } from '../utils.js';

/**
 * Empty BGP is identify for join (It can thus safely be removed)
 * https://www.w3.org/TR/sparql11-query/#sparqlSimplification
 */

export function transformFilterFalse(c: TransformContext, op: Algebra.Operation): Algebra.Operation {
  const absorbSingle = { transform: (x: Algebra.Single): Algebra.Single => absorbingSingle(c, x) };
  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    {
      [Algebra.Types.JOIN]: { transform: join => absorbJoinOnEmptyBindings(c, join) },
      [Algebra.Types.UNION]: { transform: union => pruneUnionOfEmptyBindings(c, union) },

      [Algebra.Types.EXTEND]: absorbSingle,
      [Algebra.Types.FROM]: absorbSingle,
      [Algebra.Types.DISTINCT]: absorbSingle,
      [Algebra.Types.FILTER]: absorbSingle,
      [Algebra.Types.SERVICE]: absorbSingle,
      [Algebra.Types.REDUCED]: absorbSingle,
      [Algebra.Types.SLICE]: absorbSingle,
      [Algebra.Types.GRAPH]: absorbSingle,
      [Algebra.Types.ORDER_BY]: absorbSingle,
      [Algebra.Types.MINUS]: { transform: (minus) => {
        const [ left, right ] = minus.input;
        // If left FF - than it FF, if right -than it is just left
        if (isFilterFalse(c, left) || isFilterFalse(c, right)) {
          return left;
        }
        return minus;
      } },
      [Algebra.Types.LEFT_JOIN]: { transform: (leftJoin) => {
        // https://www.w3.org/TR/sparql12-query/#defn_algLeftJoin
        const [ left, right ] = leftJoin.input;
        // If left FF - than it FF, if right FF - than it is just left
        if (isFilterFalse(c, left) || isFilterFalse(c, right)) {
          return left;
        }
        return leftJoin;
      } },
      // TODO: the projection of an empty query s the empty query (if not outer project)
      // TODO: expression, minus, leftjoin, group? of empty is empty
    },
  );
}

export function absorbingSingle(
  c: TransformContext,
  single: Algebra.Single,
): Algebra.Single {
  if (isFilterFalse(c, single.input)) {
    return createFilterFalse(c);
  }
  return single;
}

/**
 * A join over any member which is the filterFalse is the empty resultset
 */
export function absorbJoinOnEmptyBindings(c: TransformContext, join: Algebra.Join): Algebra.Join | Algebra.Filter {
  for (const op of join.input) {
    if (isFilterFalse(c, op)) {
      return createFilterFalse(c);
    }
  }
  return join;
}

function isAlgebraTyped<T extends string>(val: { type: unknown }, type: T):
val is Extract<Algebra.Operation, { type: T }> extends object ?
  Extract<Algebra.Operation, { type: T }> : (T extends Algebra.Operation['type'] ? never : { type: T }) {
  return val.type === type;
}

/**
 * A pattern that is known to emmit no binding is the identity operation for UNION.
 * We generate these patterns ourselves using FILTER(false)
 */
export function pruneUnionOfEmptyBindings(c: TransformContext, union: Algebra.Union): Algebra.Operation {
  // Filter out filterFalse
  union.input = union.input.filter((maybeFilter: Algebra.Operation | { type: string }) => {
    if (isAlgebraTyped(maybeFilter, Algebra.Types.FILTER) &&
      maybeFilter.expression.subType === Algebra.ExpressionTypes.TERM) {
      return !maybeFilter.expression.term.equals(termFalse);
    }
    return true;
  });
  if (union.input.length > 1) {
    return union;
  }
  if (union.input.length === 1) {
    return union.input[0];
  }
  // If emptyUnion, return filterFalse
  return createFilterFalse(c);
}
