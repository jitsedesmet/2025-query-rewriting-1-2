import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse, isFilterFalse, termFalse } from '../utils.js';

/**
 * Empty BGP is identify for join (It can thus safely be removed)
 * https://www.w3.org/TR/sparql11-query/#sparqlSimplification
 */

export function transformFilterFalse(c: TransformContext, op: Algebra.Operation): Algebra.Operation {
  return c.algebraTransformer.transformNode<'unsafe'>(
    op,
    {
      join: { transform: join => absorbJoinOnEmptyBindings(c, join) },
      union: { transform: union => pruneUnionOfEmptyBindings(c, union) },
    },
  );
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

/**
 * A pattern that is known to emmit no binding is the identity operation for UNION.
 * We generate these patterns ourselves using FILTER(false)
 */
export function pruneUnionOfEmptyBindings(c: TransformContext, union: Algebra.Union): Algebra.Union | Algebra.Filter {
  // Filter out filterFalse
  union.input = union.input.filter((maybeFilter) => {
    if (maybeFilter.type === 'filter' && maybeFilter.expression.expressionType === Algebra.ExpressionTypes.TERM) {
      return !maybeFilter.expression.term.equals(termFalse);
    }
    return true;
  });
  if (union.input.length > 0) {
    return union;
  }
  // If emptyUnion, return filterFalse
  return createFilterFalse(c);
}
