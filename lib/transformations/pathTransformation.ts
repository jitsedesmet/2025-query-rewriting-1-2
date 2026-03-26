import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse, isRdfVar } from '../utils.js';

let counter = 0;

/**
 * Rewrites all non-recursive property-path expressions in `op` into equivalent BGP /
 * algebra constructs so that downstream query-rewriting passes only need to handle
 * plain triple patterns.
 *
 * Supported path operators and their rewrites:
 * - **`alt`** (`|`)          – expanded to a `UNION` of the alternative paths.
 * - **`link`**               – converted to a single-pattern BGP.
 * - **`inv`** (`^`)          – subject and object are swapped and the inner path is recursed.
 * - **`seq`** (`/`)          – converted to a `JOIN` chain with fresh intermediate variables.
 * - **`nps`** (negated set)  – converted to a `FILTER(?p NOT IN (...))` over a fresh predicate variable.
 * - **`ZeroOrOnePath`** (`?`) – expanded according to whether subject/object are variables or terms:
 *   - both variables → `UNION` of the path and a same-subject extend over the node-set.
 *   - both terms and equal → empty BGP (matches trivially).
 *   - both terms and unequal → recursed inner path.
 *   - one variable → `UNION` of the path and a `BIND(term AS ?var)` extend.
 *
 * Recursive operators (`*`, `+`) are left as-is (not supported by this rewrite).
 *
 * @param c  - The transformation context providing the algebra and data factories.
 * @param op - The algebra operation to rewrite.
 * @returns The transformed operation with non-recursive paths expanded.
 */
export function rewriteNonRecursivePaths<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  const { AF, DF } = c;

  function resolvePathOp(pathOp: Algebra.PropertyPathSymbol, path: Algebra.Path): Algebra.Operation {
    const { subject, object } = path;
    if (pathOp.type === 'alt') {
      return AF.createUnion(pathOp.input.map(x => resolvePathOp(x, path)));
    }
    if (pathOp.type === 'link') {
      return AF.createBgp([ AF.createPattern(subject, pathOp.iri, object, path.graph) ]);
    }
    if (pathOp.type === 'inv') {
      const switchPath = {
        ...path,
        subject: object,
        object: subject,
      };
      return resolvePathOp(pathOp.path, switchPath);
    }
    if (pathOp.type === 'seq') {
      if (pathOp.input.length === 0) {
        return createFilterFalse(c);
      }
      if (pathOp.input.length === 1) {
        return resolvePathOp(pathOp.input[0], path);
      }
      let linkVar = DF.variable(`linkvar_${counter++}`);
      const operations = [ resolvePathOp(pathOp.input[0], { ...path, object: linkVar }) ];
      for (const subOp of pathOp.input.slice(1, -1)) {
        const newLink = DF.variable(`linkvar_${counter++}`);
        operations.push(resolvePathOp(subOp, { ...path, subject: linkVar, object: newLink }));
        linkVar = newLink;
      }
      operations.push(resolvePathOp(pathOp.input.at(-1)!, { ...path, subject: linkVar }));
      // Create a join of operations with n - 2 new variables to introduce
      return AF.createJoin(operations);
    }
    if (pathOp.type === 'nps') {
      // https://www.w3.org/TR/sparql12-query/#eval_negatedPropertySet
      const predicate = DF.variable(`rewrite_${counter++}`);
      return AF.createFilter(
        AF.createPattern(subject, predicate, object, path.graph),
        AF.createOperatorExpression('notin', [
          AF.createTermExpression(predicate),
          ...pathOp.iris.map(x => AF.createTermExpression(x)),
        ]),
      );
    }
    // https://www.w3.org/TR/sparql12-query/#defn_evalPP_ZeroOrOnePath
    if (pathOp.type === 'ZeroOrOnePath') {
      if (isRdfVar(subject) && isRdfVar(object)) {
        // Both are var
        return AF.createUnion([
          resolvePathOp(pathOp.path, path),
          AF.createExtend(
            // Nodes implementation: https://www.w3.org/TR/sparql12-query/#defn_nodeSet
            AF.createDistinct(AF.createProject(
              AF.createBgp([ AF.createPattern(
                subject,
                DF.variable(`p_${subject.value}`),
                DF.variable(`o_${subject.value}`),
                path.graph,
              ) ]),
              [ subject ],
            )),
            object,
            AF.createTermExpression(subject),
          ),
        ]);
      }
      if (!isRdfVar(subject) && !isRdfVar(object)) {
        if (subject.equals(object)) {
          return AF.createBgp([]);
        }
        return resolvePathOp(pathOp.path, path);
      }
      // Only one is a var, the other is term
      const [ variable, term ] =
        <[RDF.Variable, RDF.Term]> (isRdfVar(subject) ? [ subject, object ] : [ object, subject ]);
      return AF.createUnion([
        resolvePathOp(pathOp.path, path),
        AF.createExtend(AF.createBgp([]), variable, AF.createTermExpression(term)),
      ]);
    }
    // If (pathOp.type === 'ZeroOrMorePath' || pathOp.type === 'OneOrMorePath') {
    // Throw new Error('Cannot transform recursive paths');
    return AF.createPath(subject, pathOp, object, path.graph);
    // }
  }

  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    { path: { transform: pathOp => resolvePathOp(pathOp.predicate, pathOp) }},
  );
}
