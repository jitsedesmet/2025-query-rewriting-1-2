import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { termVars } from './certainlyBoundVars.js';

/**
 * Splits a filter expression on top level logical conjunctions (`&&`), implementing (SDecompI):
 * `FILTER_{R1 && R2}(A) == FILTER_R1(FILTER_R2(A))`.
 */
export function splitConjunction(expression: Algebra.Expression): Algebra.Expression[] {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.operator === '&&') {
    return expression.args.flatMap(arg => splitConjunction(arg));
  }
  return [ expression ];
}

/**
 * Combines a non-empty list of expressions into a single conjunction (`&&`).
 */
export function conjunctionOf(c: TransformContext, expressions: Algebra.Expression[]): Algebra.Expression {
  return expressions.reduce((acc, expr) => c.AF.createOperatorExpression('&&', [ acc, expr ]));
}

export function isStaticExpression(c: TransformContext, expression: Algebra.Expression[]): boolean {
  // TODO: when you have operations like `&&` or `||` you could shortcut potentially on if one branch is static.
  let isStatic = true;
  const neverStatic = { preVisitor: () => {
    isStatic = false;
    return { shortcut: true };
  } };
  algebraUtils.visitOperationSub(expression, {}, { expression: {
    term: { preVisitor: (term) => {
      if (termVars(term.term).size > 0) {
        isStatic = false;
        return { shortcut: true };
      }
      return {};
    } },
    operator: { preVisitor: (operator) => {
      // True recursion we can still find variables, but if the operator is not stable, we reject also.
      if ([ 'bnode', 'rand', 'now', 'uuid', 'struuid' ].includes(operator.operator)) {
        isStatic = false;
        return { shortcut: true };
      }
      return {};
    } },
    named: neverStatic,
    existence: neverStatic,
    aggregate: neverStatic,
    wildcard: neverStatic,
  }});
  return isStatic;
}
