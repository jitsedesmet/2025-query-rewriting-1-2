import { toAlgebra } from '@traqula/algebra-sparql-1-2';
import type { Algebra as Alg } from '@traqula/algebra-transformations-1-1';
import { AlgebraFactory } from '@traqula/algebra-transformations-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { Generator } from '@traqula/generator-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { AstFactory, AstTransformer } from '@traqula/rules-sparql-1-2';
import { DataFactory } from 'rdf-data-factory';
import { ClusterSolver } from './ClusterSolver.js';

export interface TransformContext {
  parser: Parser;
  generator: Generator;
  astFactory: AstFactory;
  AF: AlgebraFactory;
  DF: DataFactory;
  astTransformer: AstTransformer;
  clusterSolver: ClusterSolver;
  mappers: Alg.Construct[];
}

export function parseQueryAndPrefixVars(
  { astTransformer, astFactory, parser }: Pick<TransformContext, 'parser' | 'astTransformer' | 'astFactory'>,
  query: string,
  prefix: string,
): Algebra.Operation {
  const ast = parser.parse(query);
  const renamedAst = astTransformer.transformNodeSpecific<'unsafe', typeof ast>(
    ast,
    {},
    { term: { variable: {
      transform: ast => astFactory.termVariable(
            `${prefix}${ast.value}`,
            astFactory.sourceLocationNodeReplaceUnsafe(ast.loc),
      ),
    }}},
  );
  return <Alg.Construct> toAlgebra(renamedAst, { quads: true, blankToVariable: true });
}

export function createTransformContext(mappers: readonly string[]): TransformContext {
  const partialContext: Omit<TransformContext, 'mappers'> = {
    parser: new Parser(),
    generator: new Generator(),
    astFactory: new AstFactory(),
    AF: new AlgebraFactory(),
    DF: new DataFactory(),
    astTransformer: new AstTransformer(),
    clusterSolver: new ClusterSolver(),
  };
  const algebraMappers = [ ...mappers.entries() ].map(([ index, mapper ]) =>
    <Algebra.Construct> parseQueryAndPrefixVars(partialContext, mapper, `m${index}_`));
  const faultyMapper = algebraMappers.find(mapper => mapper.template.length !== 1);
  if (faultyMapper) {
    throw new Error(`Mappers should have only a single mapping head, found:
${JSON.stringify(faultyMapper.template, null, 2)}`);
  }
  return {
    mappers: algebraMappers,
    ...partialContext,
  };
}
