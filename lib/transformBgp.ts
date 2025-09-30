import { toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra as Alg } from '@traqula/algebra-transformations-1-2';
import { rewriteSinglePattern } from './transformations/rewriteSinglePattern.js';
import type { TransformContext } from './transformContext.js';
import { parseQueryAndPrefixVars } from './transformContext.js';
import { termFalse } from './utils.js';

export function queryTransform(
  c: TransformContext,
  input: string,
  transformations: ((c: TransformContext, op: Alg.Operation) => Alg.Operation)[],
): string {
  const inputAlgebra = parseQueryAndPrefixVars(c, input, 'uq_');
  let transformedAlgebra = inputAlgebra;
  for (const transformation of transformations) {
    transformedAlgebra = transformation(c, transformedAlgebra);
  }
  const transformedAst = toAst(transformedAlgebra);
  return c.generator.generate(transformedAst);
}

export function operationTransform(c: TransformContext, input: Alg.Operation): Alg.Operation {
  const transformed = <Alg.Operation> c.algebraTransformer.transformNode<'unsafe'>(
    input,
    { [Alg.Types.BGP]: {
      transform: input => bgpTransform(c, input),
    }},
  );
  return transformed;
}

export function bgpTransform(c: TransformContext, input: Alg.Bgp): Alg.Join {
  return c.AF.createJoin(input.patterns.map(pattern => mapPattern(c, pattern)), true);
}

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
