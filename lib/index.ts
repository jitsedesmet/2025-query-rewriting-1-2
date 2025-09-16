/* eslint-disable no-console */
import { toAlgebra, toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra as Alg, utils, Factory } from '@traqula/algebra-transformations-1-2';
import { Generator } from '@traqula/generator-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';

const tripleTermConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?t rdf:reifies <<( ?s ?p ?o )>>
} WHERE {
  ?t rdf:reifies [
      a rdf:tripleTerm ;
      rdf:ttSubject ?s ;
      rdf:ttPredicate ?p ;
      rdf:ttObject ?o ;
  ]
}
`;

const nonTripleTermConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?s ?p ?o .
} WHERE {
  ?s ?p ?o .
  # Next filter is not needed since in 1.1 the function does not exist
  FILTER ( !isTriple(?o) ) . 
  FILTER ( ?p != "rdf:reifies" && NOT EXISTS {
    ?sRoot rdf:reifies ?s . 
  } )
}
`;

const testQuery = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX : <https://example.com/>

SELECT * WHERE {
  :t rdf:reifies <<( :me :name ?name )>> .
  :t :statedBy :govBE
}`;

const expectedQuery = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX : <https://example.com/>

SELECT * WHERE {
  { 
    ?t rdf:reifies [
      a rdf:tripleTerm ;
      rdf:ttSubject ?s ;
      rdf:ttPredicate ?p ;
      rdf:ttObject ?o ;
  ] }
  UNION {
    ?s ?p ?o .
  # Next filter is not needed since in 1.1 the function does not exist
  FILTER ( !isTriple(?o) ) . 
  FILTER ( ?p != "rdf:reifies" && NOT EXISTS {
    ?sRoot rdf:reifies ?s . 
  } )
  }
  { 
    ?t rdf:reifies [
      a rdf:tripleTerm ;
      rdf:ttSubject ?s ;
      rdf:ttPredicate ?p ;
      rdf:ttObject ?o ;
  ] }
  UNION {
    ?s ?p ?o .
  # Next filter is not needed since in 1.1 the function does not exist
  FILTER ( !isTriple(?o) ) . 
  FILTER ( ?p != "rdf:reifies" && NOT EXISTS {
    ?sRoot rdf:reifies ?s . 
  } )
  } 
}`;

const parser = new Parser();
const generator = new Generator();
const algFact = new Factory();
const algebraTransformer = new utils.AlgebraTransformer();
export const construct1 = <Alg.Construct> toAlgebra(parser.parse(tripleTermConstruct), { quads: true });
export const construct2 = <Alg.Construct> toAlgebra(parser.parse(nonTripleTermConstruct), { quads: true });

const expectedAst = parser.parse(expectedQuery);
const _expectedAlg = toAlgebra(expectedAst, { quads: true });
const mappers = <const> [ construct1, construct2 ];

// Console.log(JSON.stringify(construct1, null, 2));
//
function bgpTransform(input: Alg.Bgp): Alg.Join {
  return algFact.createJoin(input.patterns.map(_ =>
    algFact.createUnion(mappers.map(x => x.input), true)), true);
}

function prettifyQuery(query: string): string {
  const builder: string[] = [];
  let indentation = 0;
  let last = -1;
  let nextOpen = query.indexOf('{');
  let nextClose = query.indexOf('}');
  while (nextOpen >= last || nextClose >= last) {
    if (nextOpen >= last && nextOpen < nextClose) {
      // We open a bracket
      builder.push(' '.repeat(indentation), query.slice(last + 1, nextOpen + 1).trim(), '\n');
      indentation += 2;
      last = nextOpen;
      nextOpen = query.indexOf('{', last + 1);
    } else {
      // We close a bracket
      builder.push(' '.repeat(indentation), query.slice(last + 1, nextClose).trim(), '\n');
      indentation -= 2;
      builder.push(' '.repeat(indentation), '}', '\n');
      last = nextClose;
      nextClose = query.indexOf('}', last + 1);
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

  const transformed = <Alg.Operation> algebraTransformer.transformNode<'unsafe'>(
    input,
    { [Alg.Types.BGP]: {
      transform: input => bgpTransform(input),
    },
    },
  );
  const asAst = toAst(transformed);
  const asQuery = generator.generate(asAst);
  console.log(prettifyQuery(asQuery));

  return transformed;
}

rewrite(toAlgebra(parser.parse(testQuery), { quads: true }));
