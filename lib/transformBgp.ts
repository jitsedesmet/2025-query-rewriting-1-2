import type * as RDF from '@rdfjs/types';
import { toAlgebra, toAst } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { AlgebraFactory, Algebra as Alg, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { Generator } from '@traqula/generator-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { AstTransformer, AstFactory } from '@traqula/rules-sparql-1-2';
import { DataFactory } from 'rdf-data-factory';
import { BoundSolver } from './BoundSolver.js';

const AF = new AlgebraFactory();
const DF = new DataFactory();

function patternSPO(pattern: Alg.Pattern | RDF.BaseQuad): RDF.Term[] {
  return [ pattern.subject, pattern.predicate, pattern.object ];
}

export class BgpTransformer {
  private readonly parser = new Parser();
  private readonly generator = new Generator();
  private readonly algebraTransformer = new algebraUtils.AlgebraTransformer();
  private readonly astFactory = new AstFactory();
  private readonly astTransformer = new AstTransformer();
  private readonly boundSolver = new BoundSolver();
  private readonly mappers: Alg.Construct[];

  private parseQueryAndPrefixVars(query: string, prefix: string): Algebra.Operation {
    const ast = this.parser.parse(query);
    const renamedAst = this.astTransformer.transformNodeSpecific<'unsafe'>(
      ast,
      {},
      { term: { variable: {
        transform: ast => this.astFactory.variable(
            `${prefix}${ast.value}`,
            this.astFactory.sourceLocationNodeReplaceUnsafe(ast.loc),
        ),
      }}},
    );
    return <Alg.Construct> toAlgebra(renamedAst, { quads: true, blankToVariable: true });
  }

  public constructor(mappers: readonly string[]) {
    this.mappers = [ ...mappers.entries() ].map(([ index, mapper ]) =>
      <Algebra.Construct> this.parseQueryAndPrefixVars(mapper, `m${index}_`));
    const faultyMapper = this.mappers.find(mapper => mapper.template.length !== 1);
    if (faultyMapper) {
      throw new Error(`Mappers should have only a single mapping head, found:
${JSON.stringify(faultyMapper.template, null, 2)}`);
    }
  }

  public queryTransform(input: string): string {
    const inputAlgebra = this.parseQueryAndPrefixVars(input, 'uq_');
    const transformedAlgebra = this.operationTransform(inputAlgebra);
    const transformedAst = toAst(transformedAlgebra);
    return this.generator.generate(transformedAst);
  }

  public operationTransform(input: Alg.Operation): Alg.Operation {
    const transformed = <Alg.Operation> this.algebraTransformer.transformNode<'unsafe'>(
      input,
      { [Alg.Types.BGP]: {
        transform: input => this.bgpTransform(input),
      },
      },
    );
    return transformed;
  }

  public bgpTransform(input: Alg.Bgp): Alg.Join {
    return AF.createJoin(input.patterns.map(pattern => this.mapPattern(pattern)), true);
  }

  private mapPattern(pattern: Alg.Pattern): Alg.Union {
    return AF.createUnion(this.mappers.flatMap((mapper) => {
      try {
        return [ this.mapSingleMapper(pattern, mapper) ];
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e);
        return [];
      }
    }), true);
  }

  private iterateMappingHead(
    mHVars: Record<string, RDF.Variable>,
    tPVars: Record<string, RDF.Variable>,
    head: Alg.Pattern | RDF.BaseQuad,
    pattern: Alg.Pattern | RDF.BaseQuad,
  ): void {
    const spoPattern = patternSPO(pattern);
    for (const [ index, headTerm ] of patternSPO(head).entries()) {
      const patternTerm = spoPattern[index];
      if (headTerm.termType === 'Quad' && patternTerm.termType === 'Quad') {
        // Recursion in triple term
        this.iterateMappingHead(mHVars, tPVars, headTerm, patternTerm);
      } else if (patternTerm.termType === 'Quad') {
        // Shortcutting, pattern term is quad but head is not. - will not match IF mapping where is SPARQL 1.1.
        throw new Error(
          `The user query contain quad ${JSON.stringify(patternTerm)} and cannot be matched to mapping head ${JSON.stringify(headTerm)}`,
        );
      } else {
        if (headTerm.termType === 'Variable') {
          mHVars[headTerm.value] = headTerm;
        }
        if (patternTerm.termType === 'Variable') {
          tPVars[patternTerm.value] = patternTerm;
        }
        if (headTerm.termType !== 'DefaultGraph' && patternTerm.termType !== 'DefaultGraph') {
          this.boundSolver.register(headTerm, patternTerm);
        }
      }
    }
  }

  // You register the mapping head and link the variables. After that, you solve.
  // Once you have solved, go over the mapping head again.
  //  If mapping head is variable, check whether bound to a non-var (check if only one).
  //    If not bound to non-var, it is because the user query has a var in this position.
  // For the user query, if there is a var in this position, look whether it is bound to a term and does not conflict.
  private mapSingleMapper(pattern: Alg.Pattern, mapper: Alg.Construct): Alg.Project | Alg.Extend {
    this.boundSolver.clear();
    const mappingHeadVars: Record<string, RDF.Variable> = {};
    const triplePatternVars: Record<string, RDF.Variable> = {};
    this.iterateMappingHead(mappingHeadVars, triplePatternVars, mapper.template[0], pattern);

    // If triple pattern term is bound, and mapping head is var, put here.
    const mappingHeadBinds: Record<string, RDF.Term> = {};
    // If the triple pattern term is a var, and mapping head is not, or is - put in here.
    const triplePatternBinds: Record<string, RDF.Term> = {};
    for (const variable of Object.values(mappingHeadVars)) {
      const boundList = this.boundSolver.getConnected(variable);
      const boundTo = boundList[0];
      // Head does not bind to var, if a var in the head is equal to a var in the pattern, we handle it on the pattern
      if (boundTo.termType !== 'Variable') {
        mappingHeadBinds[variable.value] = boundTo;
      }
      // TODO: you need to rewrite your query if you entail that two mapping head vars are the same.
    }
    for (const variable of Object.values(triplePatternVars)) {
      const boundList = this.boundSolver.getConnected(variable);
      triplePatternBinds[variable.value] = boundList[0];
    }

    // Now, after we know the binds, we can bind them. We bind triplePatternBinds after the subselect:
    let inProject: Alg.Operation = mapper.input;
    let mappingHeadExtensions: Alg.Extend | Alg.Bgp = AF.createBgp([]);
    for (const [ variable, expr ] of Object.entries(mappingHeadBinds)) {
      mappingHeadExtensions = AF.createExtend(
        mappingHeadExtensions,
        DF.variable(variable),
        AF.createTermExpression(expr),
      );
    }
    if (mappingHeadExtensions.type === Alg.Types.EXTEND) {
      inProject = AF.createJoin([ mappingHeadExtensions, inProject ]);
    }

    const variablesToSelect: RDF.Variable[] = [];
    function registerVars(cur: RDF.Term): void {
      if (cur.termType === 'Variable') {
        variablesToSelect.push(cur);
      }
      if (cur.termType === 'Quad') {
        registerVars(cur.subject);
        registerVars(cur.predicate);
        registerVars(cur.object);
      }
    }
    for (const var_ of Object.values(triplePatternBinds)) {
      registerVars(var_);
    }
    if (variablesToSelect.length === 0) {
      // You cannot select nothing, but actually we just want this subquery to validate if data exists.
      // You cannot have a subAsk, but you can do a select over a dummy var: SELECT (1 as ?dummy)
      // [proof this works: https://query.comunica.dev/#transientDatasources=%2F%2Ffragments.dbpedia.org%2F2016-04%2Fen&query=SELECT%20*%0AWHERE%20%7B%0A%20%20%3Fs%20%3Fp%20%3Fo%20.%0A%20%20%7B%20SELECT%20%281%20as%20%3Fdummy%29%20WHERE%20%7B%0A%20%20%20%20%20%20%3Chttp%3A%2F%2F0-access.newspaperarchive.com.lib.utep.edu%2Fus%2Fmississippi%2Fbiloxi%2Fbiloxi-daily-herald%2F1899%2F05-06%2Fpage-6%3Ftag%3Dtierce%2Bwine%26rtserp%3Dtags%2Ftierce-wine%3Fpage%3D2%3E%0A%20%20%20%20%20%20%3Chttp%3A%2F%2Fdbpedia.org%2Fproperty%2Fdate%3E%0A%20%20%20%20%20%20%221899-05-05%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%20%20%20%23%20%221899-05-06%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%7D%20%7D%0A%7D
      inProject = AF.createExtend(
        inProject,
        DF.variable('dummy'),
        AF.createTermExpression(DF.literal('dummy')),
      );
      variablesToSelect.push(DF.variable('dummy'));
    }

    const subQuery = AF.createProject(inProject, variablesToSelect);

    let result: Alg.Project | Alg.Extend = subQuery;
    for (const [ variable, expr ] of Object.entries(triplePatternBinds)) {
      result = AF.createExtend(
        result,
        DF.variable(variable),
        AF.createTermExpression(expr),
      );
    }
    return result;
  }
}
