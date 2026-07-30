import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { termFalse, termTrue } from './operationhelpers.js';

/**
 * Splits a filter expression on top level logical conjunctions (`&&`), implementing (SDecompI):
 * `FILTER_{R1 && R2}(A) == FILTER_R1(FILTER_R2(A))`, so each conjunct can be handled independently.
 *
 * @param expression - The filter expression to split
 * @returns The list of top level conjuncts (a single element list when there is no `&&`)
 */
export function splitConjunction(expression: Algebra.Expression): Algebra.Expression[] {
  if (
    expression.subType === Algebra.ExpressionTypes.OPERATOR &&
    expression.operator === '&&'
  ) {
    return expression.args.flatMap(arg => splitConjunction(arg));
  }
  return [ expression ];
}

/**
 * Combines a non-empty list of expressions back into a single conjunction (`&&`).
 * @param c - The transformation context
 * @param expressions - The conjuncts to combine (must contain at least one element)
 * @returns A single expression equivalent to the conjunction of the inputs
 */
export function conjunctionOf(c: TransformContext, expressions: Algebra.Expression[]): Algebra.Expression {
  return expressions.reduce((acc, expr) => c.AF.createOperatorExpression('&&', [ acc, expr ]));
}

/**
 * Recognizes an expression that is the constant `true` or `false`.
 * @param expression - The expression to inspect
 * @returns The boolean the expression is a constant for, or `undefined` when it is not a constant
 */
export function booleanConstantOf(expression: Algebra.Expression): boolean | undefined {
  if (expression.subType !== Algebra.ExpressionTypes.TERM) {
    return undefined;
  }
  if (expression.term.equals(termTrue)) {
    return true;
  }
  return expression.term.equals(termFalse) ? false : undefined;
}

/**
 * Creates the constant `true` or `false` expression.
 * @param c - The transformation context
 * @param value - The boolean to create an expression for
 * @returns The `xsd:boolean` term expression
 */
export function createBooleanExpression(c: TransformContext, value: boolean): Algebra.Expression {
  return c.AF.createTermExpression(value ? termTrue : termFalse);
}
