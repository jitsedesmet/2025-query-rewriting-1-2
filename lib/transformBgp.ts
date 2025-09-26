import { toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra as Alg } from '@traqula/algebra-transformations-1-2';
import { mapSingleMapper } from './mapperTransformer.js';
import { substituteVarsThatArePreBoundToTerms } from './termBoundVarSubsititution.js';
import type { TransformContext } from './transformContext.js';
import { parseQueryAndPrefixVars } from './transformContext.js';

export function queryTransform(c: TransformContext, input: string, context: { optimizeBinds?: boolean } = {}): string {
  const inputAlgebra = parseQueryAndPrefixVars(c, input, 'uq_');
  let transformedAlgebra = operationTransform(c, inputAlgebra);
  if (context?.optimizeBinds ?? false) {
    transformedAlgebra = substituteVarsThatArePreBoundToTerms(c, transformedAlgebra);
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
      return mapSingleMapper(c, pattern, mapper);
    } catch {
      // Console.error(e);
      return c.AF.createBgp([]);
    }
  });
  return c.AF.createUnion(mappedPatterns, true);
}
