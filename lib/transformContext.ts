import type * as RDF from '@rdfjs/types';
import { toAlgebra } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { Generator } from '@traqula/generator-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { AstFactory, AstTransformer } from '@traqula/rules-sparql-1-2';
import { DataFactory } from 'rdf-data-factory';
import { AlgebraTemplateFactory } from './AlgebraTemplateFactory.js';
import { ClusterSolver } from './ClusterSolver.js';
import { MyGenerator } from './generator/generator.js';
import type { Mapping, MappingHead } from './types.js';
import { isRdfTerm } from './utils.js';

export interface TransformContext {
  parser: Parser;
  generator: Generator;
  astFactory: AstFactory;
  AF: AlgebraTemplateFactory;
  DF: DataFactory;
  astTransformer: AstTransformer;
  clusterSolver: ClusterSolver;
  mappers: Mapping[];
}

/**
 * Parse the query and change each variable by prefixing it with prefix
 */
export function parseQuery(
  { parser }: Pick<TransformContext, 'parser'>,
  query: string,
): Algebra.Operation {
  const ast = parser.parse(query);
  return <Algebra.Construct> toAlgebra(ast, { quads: true, blankToVariable: true });
}

export function prefixVarsInOperation<T extends object>(
  { astTransformer, DF }: Pick<TransformContext, 'astTransformer' | 'DF'>,
  obj: T,
  prefix: string,
): T {
  return <T> astTransformer.transformObject(obj, (obj) => {
    if (isRdfTerm(obj) && obj.termType === 'Variable') {
      return DF.variable(prefix + obj.value);
    }
    return obj;
  });
}

export function prefixMappingVars(
  c: Pick<TransformContext, 'astTransformer' | 'DF'>,
  mapping: Mapping,
  prefix: string,
): Mapping {
  return {
    head: prefixVarsInOperation(c, mapping.head, prefix),
    body: prefixVarsInOperation(c, mapping.body, prefix),
  };
}

export function constructToMapper(
  { parser, AF, astTransformer }: Pick<TransformContext, 'parser' | 'AF' | 'astTransformer'>,
  constructQuery: string,
): Mapping {
  const construct = <Algebra.Construct> parseQuery({ parser }, constructQuery);
  if (construct.template.length !== 1) {
    throw new Error(`Mappers should have only a single mapping head, found ${construct.template.length}:
${JSON.stringify(construct.template, null, 2)}`);
  }
  const head: MappingHead = {
    ...construct.template[0],
    type: 'template',
    subType: 'Quad',
  };
  // Get used vars to create the propper projection
  const usedVars: Record<string, RDF.Variable> = {};
  for (const term of [ head.subject, head.object, head.predicate, head.graph ]) {
    if (term && isRdfTerm(term) && term.termType === 'Variable') {
      usedVars[term.value] = term;
    }
  }
  const body = AF.createProject(construct.input, Object.values(usedVars));
  // Body should not call bnode function (you should not create blank nodes in mapping body)
  algebraUtils.visitOperationSub(body, {}, {
    expression: { operator: {
      visitor: (operatorExpression) => {
        if (operatorExpression.operator === 'bnode') {
          throw new Error('BNODE function cannot be used in mapping body');
        }
      },
    }},
    // Mapping body may contain any path
  });
  // Fail if mapping head contains a BlankNode (only blank node templates are allowed!)
  astTransformer.visitObject(head, (object) => {
    if ('termType' in object && (<RDF.Term> object).termType === 'BlankNode') {
      throw new Error('Mapping head may not contain blank nodes');
    }
  });
  return {
    head,
    body,
  } satisfies Mapping;
}

export function createPartialContext(): Omit<TransformContext, 'mappers'> {
  return {
    parser: new Parser(),
    generator: new MyGenerator(),
    astFactory: new AstFactory(),
    AF: new AlgebraTemplateFactory(),
    DF: new DataFactory(),
    astTransformer: new AstTransformer(),
    clusterSolver: new ClusterSolver(),
  };
}

export function transformContextFromConstructs(mappers: readonly string[]): TransformContext {
  const partialContext = createPartialContext();
  const algebraMappers = mappers
    .map(constructQuery => constructToMapper(partialContext, constructQuery))
    .map((mapping, index) => prefixMappingVars(partialContext, mapping, `m${index}_`));
  return {
    mappers: algebraMappers,
    ...partialContext,
  };
}
