import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from './transformContext.js';
import { termFalse } from './utils.js';

/**
 * Empty BGP is identify for join
 * https://www.w3.org/TR/sparql11-query/#sparqlSimplification
 */

/**
 * A pattern that is known to emmit no binding is the identity operation for UNION.
 * We generate these patterns ourselves using FILTER(false)
 */
export function pruneUnionOfEmptyBindings<T>(c: TransformContext, op: Algebra.Operation): T {
  return c.algebraTransformer.transformNode<'unsafe'>(
    op,
    { union: {
      transform: (union) => {
        union.input = union.input.filter((maybeFilter) => {
          if (maybeFilter.type === 'filter' && maybeFilter.expression.expressionType === Algebra.ExpressionTypes.TERM) {
            return !maybeFilter.expression.term.equals(termFalse);
          }
          return true;
        });
        if (union.input.length > 0) {
          return union;
        }
        return c.AF.createFilter(c.AF.createBgp([]), c.AF.createTermExpression(termFalse));
      },
    }},
  );
}
