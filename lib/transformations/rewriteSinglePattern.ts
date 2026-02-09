import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { Algebra as Alg } from '@traqula/algebra-transformations-1-2';
import { objectRange, predicateRange, subjectRange } from '../RangeSet.js';
import type { TransformContext } from '../transformContext.js';
import type { Mapping, MappingHead } from '../types.js';
import { isMappingHead, isRdfDefaultGraph, isRdfQuad, isRdfVar } from '../utils.js';

function headSPO(head: MappingHead | RDF.BaseQuad): (RDF.Term | MappingHead)[] {
  return [ head.subject, head.predicate, head.object ];
}

function patternSPO(pattern: Algebra.Pattern | RDF.BaseQuad): RDF.Term[] {
  return [ pattern.subject, pattern.predicate, pattern.object ];
}

/**
 * Register the cluster between the current mapping and the triple term
 * @param c
 * @param mHVars
 * @param tPVars
 * @param head
 * @param pattern
 */
function iterateMappingHead(
  c: TransformContext,
  mHVars: Record<string, RDF.Variable>,
  tPVars: Record<string, RDF.Variable>,
  head: MappingHead | Algebra.Pattern | RDF.BaseQuad,
  pattern: Alg.Pattern | RDF.BaseQuad,
): void {
  const varRangesInPos = [ subjectRange, predicateRange, objectRange ];
  const spoPattern = patternSPO(pattern);
  for (const [ index, headTerm ] of headSPO(head).entries()) {
    const patternTerm = spoPattern[index];
    const variablePosRange = varRangesInPos[index];
    if ((isRdfQuad(headTerm) || isMappingHead(headTerm)) && isRdfQuad(patternTerm)) {
      // Recursion in triple term
      iterateMappingHead(c, mHVars, tPVars, headTerm, patternTerm);
    } else if (isRdfQuad(patternTerm)) {
      // Shortcutting, pattern term is quad but head is not. - will not match IF mapping where is SPARQL 1.1.
      throw new Error(
          `The user query contain quad ${JSON.stringify(patternTerm)} and cannot be matched to mapping head ${JSON.stringify(headTerm)}`,
      );
    } else {
      if (isRdfVar(headTerm)) {
        mHVars[headTerm.value] = headTerm;
        headTerm.range = variablePosRange;
      }
      if (isRdfVar(patternTerm)) {
        tPVars[patternTerm.value] = patternTerm;
        patternTerm.range = variablePosRange;
      }
      if (!isRdfDefaultGraph(headTerm) && !isRdfDefaultGraph(patternTerm)) {
        c.clusterSolver.register(<RDF.Term> headTerm, patternTerm);
      }
    }
  }
}

/**
 * You register the mapping head and link the variables. After that, you solve.
 * Once you have solved, go over the mapping head again.
 *  If mapping head is variable, check whether bound to a non-var (check if only one).
 *    If not bound to non-var, it is because the user query has a var in this position.
 * For the user query, if there is a var in this position, look whether it is bound to a term and does not conflict.
 */
export function rewriteSinglePattern(
  c: TransformContext,
  pattern: Alg.Pattern,
  mapping: Mapping,
): Alg.Project | Alg.Extend {
  const { astTransformer, clusterSolver, AF, DF } = c;
  clusterSolver.clear();
  const mappingHeadVars: Record<string, RDF.Variable> = {};
  const triplePatternVars: Record<string, RDF.Variable> = {};
  iterateMappingHead(c, mappingHeadVars, triplePatternVars, mapping.head, pattern);

  // If triple pattern term is bound, and mapping head is var, put here.
  const mappingHeadBinds: Record<string, RDF.Term> = {};
  const headVarsRemap: Record<string, RDF.Variable> = {};
  // If the triple pattern term is a var, and mapping head is not, or is - put in here.
  const triplePatternBinds: Record<string, RDF.Term> = {};
  clusterSolver.sortClusters();
  for (const variable of Object.values(mappingHeadVars)) {
    if (headVarsRemap[variable.value]) {
      continue;
    }
    const cluster = clusterSolver.getCluster(variable);
    if (cluster.term) {
      if (cluster.term.termType === 'BlankNode') {
        throw new Error('mapping variable being bound to a blank node will result in empty result');
      }
      mappingHeadBinds[variable.value] = cluster.term;
    } else {
      // If your cluster is not bound to a term, and boundlist contains other mappingHead Variables,
      //  you need to create a new variable for the matching mappingHead vars since they are the same.
      //  Since any group links to each-other, the first such match is enough to find all equal vars.
      //  All future vars in the group can be ignored.
      //  Furthermore it is essential to capture the new variable in the triplePatternBinds
      // Note that Head does not bind to var,
      // if a var in the head is equal to a var in the pattern, we handle it on the pattern
      const otherMappingVars = cluster.vars.filter(x => x.value.startsWith('m'));
      if (otherMappingVars.length > 0) {
        const varNamespacePrefix = otherMappingVars[0].value
          .slice(0, otherMappingVars[0].value.indexOf('_'));
        const newVarName = [
          'r',
          varNamespacePrefix,
          '_',
          [ variable, ...otherMappingVars ].map(x => x.value.slice(varNamespacePrefix.length + 1)).join('_AND_'),
        ].join('');
        const newVar = DF.variable(newVarName);
        headVarsRemap[variable.value] = newVar;
        for (const variable of otherMappingVars) {
          headVarsRemap[variable.value] = newVar;
        }
      }
    }
  }
  for (const variable of Object.values(triplePatternVars)) {
    const cluster = clusterSolver.getCluster(variable);
    if (cluster.term) {
      triplePatternBinds[variable.value] = cluster.term;
    } else {
      let boundTo = cluster.vars[0];
      if (headVarsRemap[boundTo.value]) {
        boundTo = headVarsRemap[boundTo.value];
      }
      triplePatternBinds[variable.value] = boundTo;
    }
  }

  // Now, after we know the binds, we can bind them. We bind triplePatternBinds after the subselect:
  let inProject: Alg.Operation = mapping.body.input;
  // Translate vars in Project
  if (Object.keys(headVarsRemap).length > 0) {
    inProject = <Alg.Operation> astTransformer.transformObject(inProject, (something) => {
      if ('termType' in something && 'value' in something && something.termType === 'Variable' &&
          typeof something.value === 'string' && headVarsRemap[something.value]) {
        return headVarsRemap[something.value];
      }
      return something;
    });
  }
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
    // [proof this works](https://query.comunica.dev/#transientDatasources=%2F%2Ffragments.dbpedia.org%2F2016-04%2Fen&query=SELECT%20*%0AWHERE%20%7B%0A%20%20%3Fs%20%3Fp%20%3Fo%20.%0A%20%20%7B%20SELECT%20%281%20as%20%3Fdummy%29%20WHERE%20%7B%0A%20%20%20%20%20%20%3Chttp%3A%2F%2F0-access.newspaperarchive.com.lib.utep.edu%2Fus%2Fmississippi%2Fbiloxi%2Fbiloxi-daily-herald%2F1899%2F05-06%2Fpage-6%3Ftag%3Dtierce%2Bwine%26rtserp%3Dtags%2Ftierce-wine%3Fpage%3D2%3E%0A%20%20%20%20%20%20%3Chttp%3A%2F%2Fdbpedia.org%2Fproperty%2Fdate%3E%0A%20%20%20%20%20%20%221899-05-05%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%20%20%20%23%20%221899-05-06%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%7D%20%7D%0A%7D)
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
    const termExpression: Alg.TermExpression | Alg.OperatorExpression = expr.termType === 'BlankNode' ?
      AF.createOperatorExpression('BNODE', [ AF.createTermExpression(DF.literal(expr.value)) ]) :
      AF.createTermExpression(expr);
    result = AF.createExtend(
      result,
      DF.variable(variable),
      termExpression,
    );
  }
  return result;
}
