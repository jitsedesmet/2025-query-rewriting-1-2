import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { datatypeBoolean, DF } from './rdfDatatypes.js';

/** The literal `false` with xsd:boolean datatype, used for FILTER(FALSE) patterns */
export const termFalse = DF.literal('false', datatypeBoolean);

/** The literal `true` with xsd:boolean datatype, the condition of a filter that constrains nothing */
export const termTrue = DF.literal('true', datatypeBoolean);

/**
 * Whether an operation is the `FILTER(FALSE)` sentinel for a pattern that never matches.
 * @param c - The transformation context
 * @param op - The operation to check
 * @returns whether it is that sentinel
 */
export function isFilterFalse(c: TransformContext, op: Algebra.Operation): boolean {
  return op.type === Algebra.Types.FILTER && op.expression.subType === Algebra.ExpressionTypes.TERM &&
        op.expression.term.equals(termFalse);
}

/**
 * The single-input operations that pass emptiness on: with no solutions coming in there is nothing for
 * them to produce, so the whole operation is the empty multiset too.
 *
 * `GROUP` is the one that is deliberately missing. An aggregate without a `GROUP BY` over an empty input
 * still returns a single row - `COUNT(*)` of nothing is `0` - so grouping is where emptiness stops. So is
 * `SERVICE`, whose `SILENT` form answers an unreachable endpoint with one empty solution; see the TODO in
 * {@link transformations/filterFalse!transformFilterFalse}.
 */
const emptyPreservingTypes = new Set<string>([
  Algebra.Types.PROJECT,
  Algebra.Types.DISTINCT,
  Algebra.Types.REDUCED,
  Algebra.Types.SLICE,
  Algebra.Types.ORDER_BY,
  Algebra.Types.EXTEND,
  Algebra.Types.FILTER,
  Algebra.Types.FROM,
  Algebra.Types.GRAPH,
]);

/**
 * Whether an operation has no solutions at all, seeing through the operations that pass emptiness on.
 * @param c - The transformation context
 * @param op - The operation to check
 * @returns whether it is the empty solution multiset
 */
export function isEmptyOperation(c: TransformContext, op: Algebra.Operation): boolean {
  if (isFilterFalse(c, op)) {
    return true;
  }
  if (emptyPreservingTypes.has(op.type)) {
    return isEmptyOperation(c, (<Algebra.Single> op).input);
  }
  return false;
}

/**
 * Creates the `FILTER(FALSE)` that represents an empty result set: in SPARQL algebra the empty multiset,
 * absorbing for JOIN and identity for UNION.
 * @param c - The transformation context
 * @param op - The operation it replaces, kept as its input so that the node carries that operation's
 * `pVars`; an empty BGP by default, which carries none
 * @returns the filter
 */
export function createFilterFalse(c: TransformContext, op?: Algebra.Operation): Algebra.Filter {
  return c.AF.createFilter(op ?? c.AF.createBgp([]), c.AF.createTermExpression(termFalse));
}
