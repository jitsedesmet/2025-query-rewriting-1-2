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
      extend: { transform: extend => extendsEmptyBindingsDoesNotGiveBindings(c, extend) },
    },
  );
}

export function extendsEmptyBindingsDoesNotGiveBindings(
  c: TransformContext,
  extend: Algebra.Extend,
): Algebra.Extend | Algebra.Filter {
  if (isFilterFalse(c, extend.input)) {
    return createFilterFalse(c);
  }
  return extend;
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
      maybeFilter.expression.expressionType === Algebra.ExpressionTypes.TERM) {
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
