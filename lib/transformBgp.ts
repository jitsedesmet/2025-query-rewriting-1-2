import { toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { rewriteSinglePattern } from './transformations/index.js';
import type { TransformContext } from './transformContext.js';
import { prefixVarsInOperation, parseQuery } from './transformContext.js';
import { createFilterFalse } from './utils.js';

/**
 * Transform an input query by executing the given transformations in order.
 *
 * The function:
 * 1. Parses `input` into algebra.
 * 2. Strips the outer `Project` (if present) and renames all variables with the `uq_` prefix
 *    so they cannot collide with mapping variables.
 * 3. Applies each transformation from `transformations` in sequence.
 * 4. If the original query was a `SELECT`, wraps the result back in the original
 *    projection by adding `BIND(?uq_<var> AS ?<var>)` extends for every projected variable.
 * 5. Serialises the resulting algebra back to a SPARQL string.
 *
 * @param c               - The transformation context containing mappers and factories.
 * @param input           - The SPARQL query string to rewrite.
 * @param transformations - An ordered list of algebra-level transformations to apply.
 * @returns The rewritten SPARQL query as a string.
 */
export function queryTransform(
  c: TransformContext,
  input: string,
  transformations: ((c: TransformContext, op: Algebra.Operation) => Algebra.Operation)[],
): string {
  const algebra = parseQuery(c, input);
  let transformedAlgebra = algebra;
  if (algebra.type === 'project') {
    transformedAlgebra = algebra.input;
  }
  transformedAlgebra = prefixVarsInOperation(c, transformedAlgebra, 'uq_');
  for (const transformation of transformations) {
    transformedAlgebra = transformation(c, transformedAlgebra);
  }

  if (algebra.type === 'project') {
    // Wrap the transformedAlgebra in extends to the originalVar names and project those
    for (const variable of algebra.variables) {
      transformedAlgebra = c.AF.createExtend(
        transformedAlgebra,
        variable,
        c.AF.createTermExpression(c.DF.variable(`uq_${variable.value}`)),
      );
    }
    transformedAlgebra = c.AF.createProject(transformedAlgebra, algebra.variables);
  }

  const transformedAst = toAst(transformedAlgebra);
  return c.generator.generate(transformedAst);
}

/**
 * Recursively rewrites all BGP nodes in `input` by replacing each one with a join
 * of per-pattern unions (one union member per active mapping rule) via {@link bgpTransform}.
 *
 * This is a convenience wrapper around {@link bgpTransform} that operates on any
 * algebra subtree, not just a single BGP.
 *
 * @param c     - The transformation context.
 * @param input - The algebra operation to transform.
 * @returns The transformed algebra with all BGPs expanded.
 */
export function operationTransform(c: TransformContext, input: Algebra.Operation): Algebra.Operation {
  const transformed = algebraUtils.mapOperation<'unsafe', typeof input>(
    input,
    { [Algebra.Types.BGP]: {
      transform: input => bgpTransform(c, input),
    }},
  );
  return transformed;
}

/**
 * Transforms a single BGP into a join of per-pattern unions.
 *
 * A BGP containing `n` triple patterns and a context with `m` mappers produces a
 * join of `n` unions, where each union has `m` members – one per mapper.  Each
 * member is the rewritten sub-query for that (pattern, mapper) pair (or
 * `FILTER(false)` when the mapper is incompatible with the pattern).
 *
 * @param c     - The transformation context.
 * @param input - The BGP to expand.
 * @returns A `Join` of per-pattern `Union` nodes.
 */
export function bgpTransform(c: TransformContext, input: Algebra.Bgp): Algebra.Join {
  return c.AF.createJoin(input.patterns.map(pattern => mapPattern(c, pattern)), true);
}

/**
 * Rewrites a single triple `pattern` against all mappers in the context.
 *
 * For each mapper, {@link rewriteSinglePattern} is called.  If it succeeds, the
 * result (a sub-query expression) is included in the union; if it throws (because
 * the mapper is structurally incompatible with the pattern) a `FILTER(false)` is
 * emitted instead.
 *
 * @param c       - The transformation context.
 * @param pattern - The triple pattern to rewrite.
 * @returns A `Union` of all per-mapper rewrites, or a `Group` when only one mapper is present.
 */
export function mapPattern(c: TransformContext, pattern: Algebra.Pattern): Algebra.Union | Algebra.Group {
  const mappedPatterns = c.mappers.map((mapper) => {
    try {
      return rewriteSinglePattern(c, pattern, mapper);
    } catch {
      // Console.error(e);
      return createFilterFalse(c);
    }
  });
  return c.AF.createUnion(mappedPatterns, true);
}
