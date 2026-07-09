import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { Algebra as Alg } from '@traqula/algebra-transformations-1-2';
import type { ClusterSolver } from '../ClusterSolver.js';
import { objectRange, predicateRange, subjectRange } from '../RangeSet.js';
import type { TransformContext } from '../transformContext.js';
import type { Mapping, MappingHead } from '../types.js';
import { collectVariableNames, isRdfQuad, isRdfVar, renameVariables, templateToExpr } from '../utils.js';

/**
 * @fileoverview Core pattern rewriting logic.
 *
 * This module implements the core algorithm for rewriting a single triple pattern
 * against a mapping definition. The rewriting process involves:
 *
 * 1. **Variable Clustering**: Determine which variables from the user query and
 *    mapping are equivalent (must have the same value).
 *
 * 2. **Bind Collection**: Determine what values each variable will be bound to
 *    after the subquery executes.
 *
 * 3. **Query Construction**: Build the subquery that finds matching data in the
 *    underlying RDF 1.1 store.
 *
 * 4. **Result Binding**: Add EXTEND operations to bind the user query variables
 *    to the values retrieved from the subquery.
 */

/**
 * Extracts subject, predicate, object from a mapping head or quad.
 * @param head - The mapping head or quad
 * @returns Array of [subject, predicate, object]
 */
function headSPO(head: MappingHead): (MappingHead['subject'] | MappingHead['predicate'] | MappingHead['object'])[] {
  return [ head.subject, head.predicate, head.object ];
}

/**
 * Register the unification between the current mapping and the triple pattern.
 * Function allows us to recurse over Triple Terms or nested Mapping Heads.
 * @param c transformation context
 * @param mHVars set of variables in the mapping head
 * @param tPVars set of variables in the triple pattern
 * @param head the mapping head to iterate
 * @param pattern the triple pattern to iterate
 */
function iterateMappingHead(
  c: TransformContext,
  mHVars: Record<string, RDF.Variable>,
  tPVars: Record<string, RDF.Variable>,
  head: MappingHead,
  pattern: Alg.Pattern | RDF.BaseQuad,
): void {
  // Static array that allows us to access the range using the position index.
  const varRangesInPos = <const> [ subjectRange, predicateRange, objectRange ];
  const spoPattern = [ pattern.subject, pattern.predicate, pattern.object ];
  for (const [ headIdx, headTerm ] of headSPO(head).entries()) {
    const patternTerm = spoPattern[headIdx];
    const variablePosRange = varRangesInPos[headIdx];
    if (isRdfQuad(headTerm) && isRdfQuad(patternTerm)) {
      // Recursion in triple term
      iterateMappingHead(c, mHVars, tPVars, headTerm, patternTerm);
    } else if (isRdfQuad(patternTerm)) {
      // TODO: a pattern provides restrictions on a variable being bound against.
      //  These restrictions are only expressible through expressions though
      //  and thus the solver should take expressions into account.
    } else {
      // If the head term is a Quad and the TP is a var, no issue, we perform the EXTEND to create the Triple Term
      // Register var and range it according to position (metadata for cluster algo). Done for triple pattern and head
      if (isRdfVar(headTerm)) {
        mHVars[headTerm.value] = headTerm;
        headTerm.range = variablePosRange;
      }
      if (isRdfVar(patternTerm)) {
        tPVars[patternTerm.value] = patternTerm;
        patternTerm.range = variablePosRange;
      }
      // Register the static terms to the solver.
      c.clusterSolver.register(headTerm, patternTerm);
    }
  }
}

/**
 * Collects bindings for triple pattern variables based on cluster analysis.
 *
 * For each variable in the user's triple pattern, determines what it should
 * be bound to after the subquery executes:
 * - A concrete term (if the mapping determines a specific value)
 * - A mapping variable (if bound through the subquery)
 *
 * @param params - Configuration object
 * @param params.clusterSolver - The cluster solver with variable unification info
 * @param params.triplePatternVars - Variables from the user's triple pattern
 * @param params.headVarsRemap - Remapping for unified head variables
 * @returns A record mapping variable names to their bindings
 */
function collectTriplePatternBinds({
  clusterSolver,
  triplePatternVars,
  headVarsRemap,
}: {
  clusterSolver: ClusterSolver;
  triplePatternVars: Record<string, RDF.Variable>;
  headVarsRemap: Record<string, RDF.Variable>;
}): Record<string, RDF.Term> {
  const triplePatternBinds: Record<string, RDF.Term> = {};
  for (const tpVariable of Object.values(triplePatternVars)) {
    const cluster = clusterSolver.getCluster(tpVariable);
    const term = cluster.term;
    if (term) {
      triplePatternBinds[tpVariable.value] = term;
    } else {
      // If not bound to a term, you are always bound to a mappingHead var:
      const boundTo = cluster.vars[0];
      triplePatternBinds[tpVariable.value] = headVarsRemap[boundTo.value] ?? boundTo;
    }
  }
  return triplePatternBinds;
}

/**
 * Collects bindings for mapping head variables and generates necessary filters.
 *
 * For each variable in the mapping head:
 * - If bound to a concrete term, adds to mappingHeadBinds (for subquery injection)
 * - If equal to other head vars, creates a unified replacement variable
 * - If needs template validation, adds to templateFilters
 *
 * @param params - Configuration object
 * @param params.clusterSolver - The cluster solver with variable unification info
 * @param params.mappingHeadVars - Variables from the mapping head
 * @param params.DF - Data factory for creating variables
 * @returns Object containing binds, remapping, and filters
 */
function collectMappingHeadBindsAndFilters({ clusterSolver, mappingHeadVars, DF }: {
  clusterSolver: ClusterSolver;
  mappingHeadVars: Record<string, RDF.Variable>;
} & Pick<TransformContext, 'DF'>): {
    mappingHeadBinds: Record<string, RDF.Term>;
    headVarsRemap: Record<string, RDF.Variable>;
  } {
  // If UQ triple pattern term is bound, and mapping head is var, put here - (starting Binds of subselect)
  const mappingHeadBinds: Record<string, RDF.Term> = {};
  // In case multiple headvars are equal to each-other, map them to their unifying replacement var.
  const headVarsRemap: Record<string, RDF.Variable> = {};

  // Start by going over headVars and how they got restricted - restrict them within the body
  for (const headVar of Object.values(mappingHeadVars)) {
    // If this headVar is equal to other headvars, we know it will be replaced by the new unifying rewrittenHeadVar
    if (headVarsRemap[headVar.value]) {
      continue;
    }

    // The cluster for this mapping head.
    const cluster = clusterSolver.getCluster(headVar);
    let iterHeadVar = headVar;

    // If boundlist contains other mappingHead Variables,
    //  you need to create a new variable for the matching mappingHead vars since they are the same.
    //  Since any group links to each-other, the first such match is enough to find all equal vars.
    //  All future vars in the group can be ignored.
    //  Furthermore, it is essential to capture the new variable in the triplePatternBinds
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
        [ headVar, ...otherMappingVars ].map(x => x.value.slice(varNamespacePrefix.length + 1)).join('_AND_'),
      ].join('');
      iterHeadVar = DF.variable(newVarName);
      headVarsRemap[headVar.value] = iterHeadVar;
      for (const variable of otherMappingVars) {
        headVarsRemap[variable.value] = iterHeadVar;
      }
    }

    if (cluster.term) {
      if (cluster.term.termType === 'BlankNode') {
        throw new Error(`Unreachable: The mapping head is assigned to a BlankNode, but this is not possible since blank nodes in the query have been replaced with variables during algebra conversion.`);
      }
      mappingHeadBinds[iterHeadVar.value] = cluster.term;
    }
  }

  return {
    mappingHeadBinds,
    headVarsRemap,
  };
}

/**
 * Adds EXTEND operations at the start of the subquery for known variable bindings.
 *
 * When a mapping head variable is determined to equal a specific term,
 * we inject that binding at the start of the subquery using EXTEND operations.
 * This allows pattern matching to use the concrete values.
 *
 * @param params - Configuration object
 * @param params.mappingHeadBinds - Map of variable names to their bound terms
 * @param params.operation - The operation to wrap
 * @param params.AF - Algebra factory
 * @param params.DF - Data factory
 * @returns The operation wrapped with necessary EXTEND operations
 */
function rewriteToPreBindVars({ AF, DF, mappingHeadBinds, operation }: {
  mappingHeadBinds: Record<string, RDF.Term>;
  operation: Algebra.Operation;
} & Pick<TransformContext, 'AF' | 'DF'>): Algebra.Operation {
  // For all statically bound mappingHead vars, register the terms they are equal too.
  // (add extend at start of subselect)
  let mappingHeadExtensions: Alg.Extend | Alg.Bgp = AF.createBgp([]);
  // Sort for consistent testing
  for (const [ variable, expr ] of Object.entries(mappingHeadBinds).sort((a, b) =>
    a[0].localeCompare(b[0]))) {
    mappingHeadExtensions = AF.createExtend(
      mappingHeadExtensions,
      DF.variable(variable),
      AF.createTermExpression(expr),
    );
  }
  if (mappingHeadExtensions.type === Alg.Types.EXTEND) {
    // Change the projection only when needed.
    return AF.createJoin([ mappingHeadExtensions, operation ]);
  }
  return operation;
}

/**
 * Wraps an operation in a PROJECT (subselect) with appropriate variable projection.
 *
 * Creates the subselect that will execute against the RDF 1.1 store.
 * Projects only the variables needed for binding the triple pattern results.
 *
 * @param params - Configuration object
 * @param params.triplePatternBinds - The bindings for triple pattern variables
 * @param params.operation - The operation to project
 * @param params.astTransformer - AST transformer for collecting variables
 * @param params.DF - Data factory
 * @param params.AF - Algebra factory
 * @returns A PROJECT operation with the correct variable projection
 */
function wrapOperationInProject({ triplePatternBinds, operation, astTransformer, DF, AF }: {
  triplePatternBinds: Record<string, RDF.Term>;
  operation: Algebra.Operation;
} & Pick<TransformContext, 'astTransformer' | 'DF' | 'AF'>): Algebra.Project {
  let buildOperation = operation;
  // All variables required from subselect -- recursive search needed for triple terms
  const variablesToSelect = collectVariableNames(astTransformer, triplePatternBinds);
  const vars = Object.values(variablesToSelect);
  if (vars.length === 0) {
    // You cannot select nothing, but actually we just want this subquery to validate if data exists.
    // You cannot have a subAsk, but you can do a select over a dummy var: SELECT (1 as ?dummy)
    // [proof this works](https://query.comunica.dev/#transientDatasources=%2F%2Ffragments.dbpedia.org%2F2016-04%2Fen&query=SELECT%20*%0AWHERE%20%7B%0A%20%20%3Fs%20%3Fp%20%3Fo%20.%0A%20%20%7B%20SELECT%20%281%20as%20%3Fdummy%29%20WHERE%20%7B%0A%20%20%20%20%20%20%3Chttp%3A%2F%2F0-access.newspaperarchive.com.lib.utep.edu%2Fus%2Fmississippi%2Fbiloxi%2Fbiloxi-daily-herald%2F1899%2F05-06%2Fpage-6%3Ftag%3Dtierce%2Bwine%26rtserp%3Dtags%2Ftierce-wine%3Fpage%3D2%3E%0A%20%20%20%20%20%20%3Chttp%3A%2F%2Fdbpedia.org%2Fproperty%2Fdate%3E%0A%20%20%20%20%20%20%221899-05-05%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%20%20%20%23%20%221899-05-06%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%7D%20%7D%0A%7D)
    // TODO: this should be a fresh variable to avoid collisions
    buildOperation = AF.createExtend(
      buildOperation,
      DF.variable('dummy'),
      AF.createTermExpression(DF.literal('dummy')),
    );
    vars.push(DF.variable('dummy'));
  }
  // Sort allows for stable tests but does not practically change anything.
  vars.sort((a, b) => a.value.localeCompare(b.value));
  return AF.createProject(buildOperation, vars);
}

/**
 * Adds EXTEND operations after the subselect to bind triple pattern variables.
 *
 * After the subquery executes, we need to bind the user query's variables
 * to the appropriate values (mapping variables, concrete terms, or template results).
 *
 * @param params - Configuration object
 * @param params.subQuery - The subquery (PROJECT operation)
 * @param params.triplePatternBinds - Map of variable names to their bindings
 * @param params.DF - Data factory
 * @param params.AF - Algebra factory
 * @returns The subquery with EXTEND operations for variable binding
 */
function bindPatternTerms({ subQuery, AF, DF, triplePatternBinds }: {
  subQuery: Algebra.Project;
  triplePatternBinds: Record<string, RDF.Term>;
} & Pick<TransformContext, 'DF' | 'AF'>): Alg.Project | Alg.Extend {
  let buildOperation: Alg.Project | Alg.Extend = subQuery;
  // Finally add the binds after the subselect - Sort to create stable tests
  for (const [ variable, template ] of Object.entries(triplePatternBinds).sort((a, b) => a[0].localeCompare(b[0]))) {
    const expression = templateToExpr(AF, DF, template);
    buildOperation = AF.createExtend(
      buildOperation,
      DF.variable(variable),
      expression,
    );
  }
  return buildOperation;
}

/**
 * Rewrites a single triple pattern using a mapping definition.
 */
export function rewriteSinglePattern(
  c: TransformContext,
  pattern: Alg.Pattern,
  mapping: Mapping,
): Alg.Project | Alg.Extend {
  const { astTransformer, clusterSolver, AF, DF } = c;
  clusterSolver.clear();
  // Set of variables in the mapping head
  const mappingHeadVars: Record<string, RDF.Variable> = {};
  // Set of variables in the triple pattern
  const triplePatternVars: Record<string, RDF.Variable> = {};
  iterateMappingHead(c, mappingHeadVars, triplePatternVars, mapping.head, pattern);

  clusterSolver.sortClusters();

  const { mappingHeadBinds, headVarsRemap } =
    collectMappingHeadBindsAndFilters({ mappingHeadVars, DF, clusterSolver });

  // A map between what each uqVar now equals. Adds bind after the subselect
  const triplePatternBinds: Record<string, RDF.Term> = collectTriplePatternBinds({
    clusterSolver,
    triplePatternVars,
    headVarsRemap,
  });

  // Construct the contents of our subselect
  let inProject: Alg.Operation = mapping.body.input;
  inProject = renameVariables(c, inProject, headVarsRemap);
  inProject = rewriteToPreBindVars({ AF, DF, mappingHeadBinds, operation: inProject });

  const subQuery = wrapOperationInProject({ triplePatternBinds, AF, DF, astTransformer, operation: inProject });
  return bindPatternTerms({ subQuery, triplePatternBinds, DF, AF });
}
