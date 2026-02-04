import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { deleteVarExtensionsInPlace, directExtensions } from '../utils.js';

/**
 * If the same variable is bound to the same term for all union entries,
 * the 'extend' can be removed for each input and can instead be performed on around the union.
 * Example: { { ... } BIND(<A> as ?x) } UNION { { ... } BIND(<A> as ?x) . } -> { {... } UNION { ... } BIND(<A> as ?x) }
 * Better yet: across a join you can do the same thing but stronger.
 * Where a Join of a union that gives A|B and C -> empty result
 * @param c
 * @param op
 */
export function pushUpBoundedFromUnion<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    {
      union: {
        transform: (union) => {
          if (union.input.length === 0) {
            return union;
          }
          const first = union.input[0];
          // Anything not yet included here can no longer become statically bound
          const assignments = directExtensions(c, first);
          const needsVisit = new Set<string>();
          const nonStaticBoundVars = new Set<string>();
          for (const op of union.input.slice(1)) {
            for (const key of Object.keys(assignments)) {
              needsVisit.add(key);
            }

            for (const [ var_, term ] of Object.entries(directExtensions(c, op))) {
              needsVisit.delete(var_);
              const assignment = assignments[var_];
              if (assignment && !assignment.equals(term)) {
                delete assignments[var_];
                nonStaticBoundVars.add(var_);
              }
            }

            for (const key of needsVisit) {
              delete assignments[key];
              nonStaticBoundVars.add(key);
            }
          }

          // Now you need to remove the extensions from the input of our union
          const staticVars = Object.keys(assignments);
          union.input = union.input.map(op => deleteVarExtensionsInPlace(c, op, staticVars));

          let ret: Algebra.Operation = union;
          for (const [ var_, term ] of Object.entries(assignments)) {
            ret = c.AF.createExtend(ret, c.DF.variable(var_), c.AF.createTermExpression(term));
          }
          return ret;
        },
      },
    },
  );
}
