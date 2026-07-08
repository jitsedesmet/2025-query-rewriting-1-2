import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { freshVarGenerator, isRdfTerm } from '../utils.js';

/**
 * Collects the names of every variable that occurs anywhere in an operation subtree.
 * This includes variable terms (subjects, predicates, objects, expression operands,
 * projected/extended variables, ...) as well as the string keys used in VALUES bindings.
 *
 * @param c - The transformation context
 * @param obj - The operation (or any object) to scan
 * @returns The set of variable names present in the subtree
 */
function collectVariableNames(c: TransformContext, obj: object): Set<string> {
  const names = new Set<string>();
  c.astTransformer.visitObject(obj, (object) => {
    if (isRdfTerm(object) && object.termType === 'Variable') {
      names.add(object.value);
    }
    // VALUES bindings reference their variables through string keys.
    if ('type' in object && object.type === 'values' && 'bindings' in object) {
      for (const binding of (<Algebra.Values> object).bindings) {
        for (const key of Object.keys(binding)) {
          names.add(key);
        }
      }
    }
  });
  return names;
}

/**
 * Renames variables in an operation subtree according to the given map.
 * Handles both variable terms and the string keys used in VALUES bindings.
 *
 * @param c - The transformation context
 * @param obj - The operation to rewrite
 * @param renames - Map from original variable name to its replacement variable
 * @returns The rewritten operation
 */
function renameVariables<T extends object>(
  c: TransformContext,
  obj: T,
  renames: Record<string, RDF.Variable>,
): T {
  return <T> c.astTransformer.transformObject(obj, (object) => {
    if (isRdfTerm(object) && object.termType === 'Variable' && object.value in renames) {
      return renames[object.value];
    }
    if ('type' in object && object.type === 'values' && 'bindings' in object) {
      const valuesOp = <Algebra.Values> object;
      valuesOp.bindings = valuesOp.bindings.map(binding => Object.fromEntries(
        Object.entries(binding).map(([ key, value ]) => [ key in renames ? renames[key].value : key, value ]),
      ));
    }
    return object;
  });
}

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
 * // After:  ?x ?v_0 ?v_1                   (projection removed, hidden vars anonymized)
 */
export function removeProjections<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  // Seed the generator with every variable in the tree so fresh names never collide.
  const nextVar = freshVarGenerator(collectVariableNames(c, op));

  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    {
      [Algebra.Types.PROJECT]: {
        transform: (project) => {
          const projected = new Set(project.variables.map(variable => variable.value));
          const renames: Record<string, RDF.Variable> = {};
          for (const name of collectVariableNames(c, project.input)) {
            if (!projected.has(name)) {
              renames[name] = nextVar();
            }
          }
          return renameVariables(c, project.input, renames);
        },
      },
    },
  );
}
