/* eslint-disable no-console */
import { toAlgebra, toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra as Alg, utils } from '@traqula/algebra-transformations-1-2';
import { Generator } from '@traqula/generator-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { expectedQuery, nonTripleTermConstruct, testQuery, tripleTermConstruct } from './queries.js';
import { BgpTransformer } from './transformBgp.js';

const parser = new Parser();
const generator = new Generator();
const algebraTransformer = new utils.AlgebraTransformer();
export const construct1 = <Alg.Construct> toAlgebra(parser.parse(tripleTermConstruct), { quads: true });
export const construct2 = <Alg.Construct> toAlgebra(parser.parse(nonTripleTermConstruct), { quads: true });

const expectedAst = parser.parse(expectedQuery);
const _expectedAlg = toAlgebra(expectedAst, { quads: true });
const mappers = <const> [ construct1, construct2 ];

// Console.log(JSON.stringify(construct1, null, 2));

function prettifyQuery(query: string): string {
  const builder: string[] = [];
  let indentation = 0;
  function addNewLine(): void {
    builder.push('\n', ' '.repeat(indentation));
  }
  let inIri = false;
  for (const char of query) {
    switch (char) {
      case '{': {
        builder.push(char);
        indentation += 2;
        addNewLine();
        break;
      }
      case '}': {
        const build = builder.join('').trimEnd();
        builder.length = 0;
        builder.push(build);
        indentation -= 2;
        addNewLine();
        builder.push(char);
        addNewLine();
        break;
      }
      case '.': {
        builder.push(char);
        if (!inIri) {
          addNewLine();
        }
        break;
      }
      case '>':
      case '<':
        inIri = char === '<';
      // eslint-disable-next-line no-fallthrough
      default:
        builder.push(char);
    }
  }
  return builder.join('');
}

export function rewrite(input: Alg.Operation): Alg.Operation {
  const faultyMapper = mappers.find(mapper => mapper.template.length !== 1);
  if (faultyMapper) {
    throw new Error(`Mappers should have only a single mapping head, found:
${JSON.stringify(faultyMapper.template, null, 2)}`);
  }

  const transformer = new BgpTransformer(mappers);
  const transformed = <Alg.Operation> algebraTransformer.transformNode<'unsafe'>(
    input,
    { [Alg.Types.BGP]: {
      transform: input => transformer.bgpTransform(input),
    },
    },
  );
  const asAst = toAst(transformed);
  const asQuery = generator.generate(asAst);
  console.log(prettifyQuery(asQuery));

  return transformed;
}

rewrite(toAlgebra(parser.parse(testQuery), { quads: true }));
