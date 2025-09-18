import type * as RDF from '@rdfjs/types';
import { Factory, Algebra as Alg } from '@traqula/algebra-transformations-1-2';
import { DataFactory } from 'rdf-data-factory';

const AF = new Factory();
const DF = new DataFactory();

function patternSPO(pattern: Alg.Pattern | RDF.BaseQuad): RDF.Term[] {
  return [ pattern.subject, pattern.predicate, pattern.object ];
}

export class BgpTransformer {
  public constructor(private readonly mappers: readonly Alg.Construct[]) {}

  public bgpTransform(input: Alg.Bgp): Alg.Join {
    return AF.createJoin(input.patterns.map(_ => this.mapPattern(_)), true);
  }

  private mapPattern(pattern: Alg.Pattern): Alg.Union {
    return AF.createUnion(this.mappers.flatMap((mapper) => {
      try {
        return [ this.mapSingleSubSelect(pattern, mapper) ];
      } catch {
        return [];
      }
    }), true);
  }

  private iterateMappingHead(
    mHAT: Record<string, RDF.Term>,
    tPAMH: Record<string, RDF.Term>,
    head: Alg.Pattern | RDF.BaseQuad,
    pattern: Alg.Pattern | RDF.BaseQuad,
  ): void {
    const spoPattern = patternSPO(pattern);
    for (const [ index, headTerm ] of patternSPO(head).entries()) {
      const patternTerm = spoPattern[index];
      if (headTerm.termType === 'Quad' && patternTerm.termType === 'Quad') {
        this.iterateMappingHead(mHAT, tPAMH, headTerm, patternTerm);
      } else if (patternTerm.termType === 'Variable') {
        tPAMH[patternTerm.value] = headTerm;
      } else if (patternTerm.termType === 'Quad') {
        // Pattern term is quad but head is not. - will not match IF mapping where is SPARQL 1.1.
        throw new Error(
          `The user query contain quad ${JSON.stringify(patternTerm)} and cannot be matched to mapping head ${JSON.stringify(headTerm)}`,
        );
      } else if (headTerm.termType === 'Variable') {
        // We can pinpoint the variable
        mHAT[headTerm.value] = patternTerm;
      } else if (headTerm.termType === 'BlankNode') {
        // TODO: ignore this case for now... Can it have a blanknode? What does that mean?
      } else if (!headTerm.equals(patternTerm)) {
        throw new Error(
            `Head term (${JSON.stringify(headTerm)}) and pattern term (${JSON.stringify(patternTerm)}) are both bounded but do not match.`,
        );
      }
    }
  }

  private mapSingleSubSelect(pattern: Alg.Pattern, mapper: Alg.Construct): Alg.Project | Alg.Extend {
    // If triple pattern term is bound, and mapping head is var, put here.
    const mappingHeadAsTriplePattern: Record<string, RDF.Term> = {};
    // If the triple pattern term is a var, and mapping head is not, or is - put in here.
    const triplePatternAsMappingHead: Record<string, RDF.Term> = {};
    // Match current triple pattern with mapping head.
    // look at the mapping head, for each term, see if it matches.
    // TODO: use an actual solver
    this.iterateMappingHead(mappingHeadAsTriplePattern, triplePatternAsMappingHead, mapper.template[0], pattern);

    // Now, after we know the binds, we can bind them. We bind triplePatternAsMappingHead after the subselect:
    let inProject: Alg.Operation = mapper.input;
    let mappingHeadExtensions: Alg.Extend | Alg.Bgp = AF.createBgp([]);
    for (const [ variable, expr ] of Object.entries(mappingHeadAsTriplePattern)) {
      mappingHeadExtensions = AF.createExtend(
        mappingHeadExtensions,
        DF.variable(variable),
        AF.createTermExpression(expr),
      );
    }
    if (mappingHeadExtensions.type === Alg.Types.EXTEND) {
      inProject = AF.createJoin([ mappingHeadExtensions, inProject ]);
    }

    const subQuery = AF.createProject(
      inProject,
      Object.keys(triplePatternAsMappingHead).map(x => DF.variable(x)),
    );

    let result: Alg.Project | Alg.Extend = subQuery;
    for (const [ variable, expr ] of Object.entries(triplePatternAsMappingHead)) {
      result = AF.createExtend(
        result,
        DF.variable(variable),
        AF.createTermExpression(expr),
      );
    }
    return result;
  }
}
