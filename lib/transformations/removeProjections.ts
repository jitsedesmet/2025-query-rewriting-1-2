import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { collectVariableNames, freshVarGenerator, renameVariables } from '../utils.js';

/**
 * Transformation that removes all PROJECT operations from an algebra tree.
 *
 * A projection restricts which variables are visible outside its subtree. Simply
 * dropping it would leak the previously hidden variables, letting them accidentally
 * join with identically named variables in the surrounding query. To preserve
 * semantics, every variable that is *not* projected is first anonymized: it is
 * renamed to a fresh, guaranteed-unique variable (see {@link freshVarGenerator}).
 * Afterwards the PROJECT node is replaced by its input.
 *
 * Projections are processed bottom-up, so nested (sub-SELECT) projections are
 * removed before their enclosing ones.
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The transformed operation without any PROJECT operations
 *
 * @example
 * // Before: SELECT ?x { ?x ?y ?z }        (?y and ?z are not projected)
 * // After:  ?x ?v_0 ?v_1                  (projection removed, hidden vars anonymized)
 */
export function removeProjections<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  // Seed the generator with every variable in the tree so fresh names never collide.
  // We cannot collide in the top level context
  const nextVar = freshVarGenerator(collectVariableNames(c.astTransformer, op));

  // TODO: this renames even if it has already renamed so could be optimized, but that's not a priority now.
  return algebraUtils.mapOperation<'unsafe', typeof op>(op, {
    [Algebra.Types.PROJECT]: { transform: (project) => {
      const projected = new Set(project.variables.map(variable => variable.value));
      const renames: Record<string, RDF.Variable> = {};
      // For all variables in the current subquery (which you know contains no other subqueries)
      for (const name of collectVariableNames(c.astTransformer, project.input)) {
        // If that var is not projected, rename it
        if (!projected.has(name)) {
          renames[name] = nextVar();
        }
      }
      return renameVariables(c, project.input, renames);
    } },
  });
}
