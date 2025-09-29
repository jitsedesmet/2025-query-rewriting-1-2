import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from './transformContext.js';

/**
 * JOIN [
 *   UNION [ ?s = 'a', ?s = 'b' ]
 *   ?s = 'c'
 * ]
 *  -> { FILTER(false) }
 * @param c
 * @param op
 */
export function nullifyJoinOverIncompatibleBounds<T extends Algebra.Operation>(
  c: TransformContext,
  op: Algebra.Operation,
): T {
  return c.algebraTransformer.transformNode<'unsafe'>(
    op,
    { join: {
      transform: (_join) => {
        // Find for each member of the join whether variables are bound to known terms

        // We optimize
      },
    }},
  );
}
