import { toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra as Alg, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { rewriteSinglePattern } from './transformations/rewriteSinglePattern.js';
import type { TransformContext } from './transformContext.js';
import { prefixVarsInOperation, parseQuery } from './transformContext.js';
import { termFalse } from './utils.js';

/**
 * Transform an input query by executing the given transformations in order
 */
export function queryTransform(
  c: TransformContext,
  input: string,
  transformations: ((c: TransformContext, op: Alg.Operation) => Alg.Operation)[],
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
 * Simple transformation that transforms a BGPs into a union of joins each containing subselects.
 * A BGP of `n` triple patterns and a context of `m` mappers results in a join of `n` unions each having `m` patterns.
 * @param c
 * @param input
 */
export function operationTransform(c: TransformContext, input: Alg.Operation): Alg.Operation {
  const transformed = algebraUtils.mapOperation<'unsafe', typeof input>(
    input,
    { [Alg.Types.BGP]: {
      transform: input => bgpTransform(c, input),
    }},
  );
  return transformed;
}

/**
 * Transforms a Bgp into union of joins containing subselects.
 */
export function bgpTransform(c: TransformContext, input: Alg.Bgp): Alg.Join {
  return c.AF.createJoin(input.patterns.map(pattern => mapPattern(c, pattern)), true);
}

/**
 * Transform a single Triple Pattern into a Union of subselect of filterFalse in cas no mappers match
 */
export function mapPattern(c: TransformContext, pattern: Alg.Pattern): Alg.Union | Alg.Group {
  const mappedPatterns = c.mappers.map((mapper) => {
    try {
      return rewriteSinglePattern(c, pattern, mapper);
    } catch {
      // Console.error(e);
      return c.AF.createFilter(
        c.AF.createBgp([]),
        c.AF.createTermExpression(termFalse),
      );
    }
  });
  return c.AF.createUnion(mappedPatterns, true);
}
