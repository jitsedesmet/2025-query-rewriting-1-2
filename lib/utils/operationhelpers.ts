import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { datatypeBoolean, DF } from './rdfDatatypes.js';

/** The literal `false` with xsd:boolean datatype, used for FILTER(FALSE) patterns */
export const termFalse = DF.literal('false', datatypeBoolean);

/** The literal `true` with xsd:boolean datatype, used for conditions that are statically satisfied */
export const termTrue = DF.literal('true', datatypeBoolean);

/**
 * Checks if an operation is a FILTER(FALSE) pattern.
 * FILTER(FALSE) is used as a sentinel to represent patterns that will never match.
 * @param c - Transform context
 * @param op - The operation to check
 * @returns True if the operation is FILTER(FALSE)
 */
export function isFilterFalse(c: TransformContext, op: Algebra.Operation): boolean {
  return op.type === Algebra.Types.FILTER && op.expression.subType === Algebra.ExpressionTypes.TERM &&
        op.expression.term.equals(termFalse);
}

/**
 * Creates a FILTER(FALSE) operation, used to represent an empty result set.
 * In SPARQL algebra, FILTER(FALSE) is equivalent to the empty multiset
 * and is absorbing for JOIN and identity for UNION.
 * @param c - Transform context
 * @param op - Optional input operation (defaults to empty BGP)
 * @returns A Filter operation with FALSE as the condition
 */
export function createFilterFalse(c: TransformContext, op?: Algebra.Operation): Algebra.Filter {
  return c.AF.createFilter(op ?? c.AF.createBgp([]), c.AF.createTermExpression(termFalse));
}

/**
 * Splits a filter expression on top level logical conjunctions (`&&`), implementing (SDecompI) of
 * Schmidt et al. (https://arxiv.org/pdf/0812.3788):
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
