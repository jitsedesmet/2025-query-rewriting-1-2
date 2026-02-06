import type * as RDF from '@rdfjs/types';
import { toAlgebra } from '@traqula/algebra-sparql-1-2';
import { AlgebraFactory, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { Generator } from '@traqula/generator-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { AstFactory, AstTransformer } from '@traqula/rules-sparql-1-2';
import { DataFactory } from 'rdf-data-factory';
import { ClusterSolver } from './ClusterSolver.js';

export type TemplateIri = RDF.NamedNode;
export type TemplateLiteral = RDF.Literal;
export type TemplateBlank = RDF.BlankNode;
export type Templates = TemplateIri | TemplateBlank | TemplateLiteral;

export type MappingHead = Omit<Algebra.Pattern, 'subject' | 'predicate' | 'object' | 'graph'> & {
  subject: Algebra.Pattern['subject'] | Templates;
  predicate: Algebra.Pattern['predicate'] | Templates;
  object: Algebra.Pattern['object'] | Templates;
  graph: Algebra.Pattern['graph'] | Templates;
};

export interface Mapping {
  head: MappingHead;
  body: Algebra.Project;
}

export interface TransformContext {
  parser: Parser;
  generator: Generator;
  astFactory: AstFactory;
  AF: AlgebraFactory;
  DF: DataFactory;
  astTransformer: AstTransformer;
  clusterSolver: ClusterSolver;
  mappers: Mapping[];
}

/**
 * Parse the query and change each variable by prefixing it with prefix
 */
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
            astFactory.gen(),
      ),
    }}},
  );
  return <Algebra.Construct> toAlgebra(renamedAst, { quads: true, blankToVariable: true });
}

export function createTransformContext(mappers: readonly string[]): TransformContext {
  const AF = new AlgebraFactory();
  const astTransformer = new AstTransformer();
  const partialContext: Omit<TransformContext, 'mappers'> = {
    parser: new Parser(),
    generator: new Generator(),
    astFactory: new AstFactory(),
    AF,
    DF: new DataFactory(),
    astTransformer,
    clusterSolver: new ClusterSolver(),
  };
  const algebraMappers = [ ...mappers.entries() ].map(([ index, mapper ]) => {
    const construct = <Algebra.Construct> parseQueryAndPrefixVars(partialContext, mapper, `m${index}_`);
    if (construct.template.length !== 1) {
      throw new Error(`Mappers should have only a single mapping head, found ${construct.template.length}:
${JSON.stringify(construct.template, null, 2)}`);
    }
    const head = construct.template[0];
    const usedVars: Record<string, RDF.Variable> = {};
    for (const term of [ head.subject, head.object, head.predicate, head.graph ]) {
      if (term.termType === 'Variable') {
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
  });
  return {
    mappers: algebraMappers,
    ...partialContext,
  };
}
