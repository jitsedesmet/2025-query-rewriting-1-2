import type * as RDF from '@rdfjs/types';
import type { Algebra as Alg } from '@traqula/algebra-transformations-1-2';
import type { ClusterSolver } from '../ClusterSolver.js';
import { objectRange, predicateRange, subjectRange } from '../RangeSet.js';
import type { TransformContext } from '../transformContext.js';
import type { Mapping, MappingHead } from '../types.js';
import { collectVariableNames, isRdfQuad, isRdfVar } from '../utils.js';

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
    } else if (isRdfQuad(patternTerm) && isRdfVar(headTerm)) {
      // If pattern is a quad, head must be a var. Otherwise, it was a quad, or a static term (which fails unification)

      // We now know the varalues of the var should be FILTERed to aacount for the patternTerm restrictions;
      //   or get the values of the patternTerm contained variables. -> start recursing the patternTerm.

      function registerRestrictionsAndExpressionAssignments(quad: RDF.Quad, expression: Alg.Expression): void {
        const spoQuad = [ quad.subject, quad.predicate, quad.object ];
        const positionalOperators = [ 'subject', 'predicate', 'object' ];
        for (const [ patternIdx, patternTerm ] of spoQuad.entries()) {
          const variablePosRange = varRangesInPos[patternIdx];
          const curHeadExpression = c.AF.createOperatorExpression(positionalOperators[patternIdx], [ expression ]);
          if (isRdfQuad(patternTerm)) {
            registerRestrictionsAndExpressionAssignments(patternTerm, curHeadExpression);
          } else {
            if (isRdfVar(patternTerm)) {
              tPVars[patternTerm.value] = patternTerm;
              patternTerm.range = variablePosRange;
            }
            c.clusterSolver.register(curHeadExpression, patternTerm);
          }
        }
      }
      registerRestrictionsAndExpressionAssignments(patternTerm, c.AF.createTermExpression(headTerm));
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
 */
function collectTriplePatternBinds({
  clusterSolver,
  triplePatternVars,
  expressionFilters,
  AF,
  DF,
}: {
  clusterSolver: ClusterSolver;
  triplePatternVars: Record<string, RDF.Variable>;
  expressionFilters: Alg.Expression[];
} & Pick<TransformContext, 'AF' | 'DF'>): Record<string, Alg.Expression> {
  const triplePatternBinds: Record<string, Alg.Expression> = {};
  for (const tpVariable of Object.values(triplePatternVars)) {
    const cluster = clusterSolver.getCluster(tpVariable);
    const expressions = clusterSolver.getExpressions(tpVariable);

    const term = cluster.term;
    // If two head vars are equal,
    //  they are connected through a mapping var (would be first) and get their value from there.
    const unifiedHeadVar = cluster.vars.at(0);
    if (term) {
      triplePatternBinds[tpVariable.value] = AF.createTermExpression(term);
    } else if (unifiedHeadVar) {
      triplePatternBinds[tpVariable.value] = AF.createTermExpression(DF.variable(unifiedHeadVar.value));
    }
    let isBound = Boolean(term ?? unifiedHeadVar);

    for (const expression of expressions) {
      if (isBound) {
        expressionFilters.push(
          AF.createOperatorExpression('=', [ triplePatternBinds[tpVariable.value], expression ]),
        );
      } else {
        triplePatternBinds[tpVariable.value] = expression;
        isBound = true;
      }
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
function collectMappingHeadBindsAndFilters({ clusterSolver, mappingHeadVars, AF }: {
  clusterSolver: ClusterSolver;
  mappingHeadVars: Record<string, RDF.Variable>;
} & Pick<TransformContext, 'AF'>): Alg.Expression[] {
  const expressionFilters: Alg.Expression[] = [];
  const handledGroups = new Set<number>();

  // Start by going over headVars and how they got restricted - restrict them within the body.
  for (const headVar of Object.values(mappingHeadVars)) {
    // The cluster for this mapping head.
    const group = clusterSolver.getGroup(headVar);
    if (handledGroups.has(group)) {
      continue;
    }
    handledGroups.add(group);

    const groupTerm = clusterSolver.groupToTerm[group];
    const groupMappingVars = clusterSolver.groupToValues[group].filter(val => val.value.startsWith('m'));

    // Handle term restrictions first!
    if (groupTerm) {
      if (groupTerm.termType === 'BlankNode') {
        throw new Error(`Unreachable: The mapping head is assigned to a BlankNode, but this is not possible since blank nodes in the query have been replaced with variables during algebra conversion.`);
      }
      // Each mapping head var in the cluter should be equal to the term.
      for (const clusterVar of groupMappingVars) {
        expressionFilters.push(AF.createOperatorExpression('sameTerm', [
          AF.createTermExpression(clusterVar),
          AF.createTermExpression(groupTerm),
        ]));
      }
    } else {
      // Assert equality between the various mapping head Vars
      const headIdx = 0;
      while (headIdx < groupMappingVars.length - 1) {
        const headVar = groupMappingVars[headIdx];
        const tailVar = groupMappingVars[headIdx + 1];
        expressionFilters.push(AF.createOperatorExpression('sameTerm', [
          AF.createTermExpression(headVar),
          AF.createTermExpression(tailVar),
        ]));
      }
    }

    const expressionsToRegister = clusterSolver.getExpressions(headVar);
    for (const expression of expressionsToRegister) {
      // If group has term, check if templates equal term, otherwise check if template equals var.
      // By checking templates to terms we can perform prefix validation checks.
      const term: RDF.Term = groupTerm ?? groupMappingVars[0];
      expressionFilters.push(AF.createOperatorExpression('sameTerm', [ AF.createTermExpression(term), expression ]));
    }
  }

  return expressionFilters;
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
  triplePatternBinds: Record<string, Alg.Expression>;
  operation: Alg.Operation;
} & Pick<TransformContext, 'astTransformer' | 'DF' | 'AF'>): Alg.Project {
  let buildOperation = operation;
  // All variables required from subselect -- recursive search needed for triple terms
  const variablesToSelect = collectVariableNames(astTransformer, triplePatternBinds);
  const vars = [ ...variablesToSelect.values() ].map(x => DF.variable(x));
  if (vars.length === 0) {
    // You cannot select nothing, but actually we just want this subquery to validate if data exists.
    // You cannot have a subAsk, but you can do a select over a dummy var: SELECT (1 as ?dummy)
    // [proof this works](https://query.comunica.dev/#transientDatasources=%2F%2Ffragments.dbpedia.org%2F2016-04%2Fen&query=SELECT%20*%0AWHERE%20%7B%0A%20%20%3Fs%20%3Fp%20%3Fo%20.%0A%20%20%7B%20SELECT%20%281%20as%20%3Fdummy%29%20WHERE%20%7B%0A%20%20%20%20%20%20%3Chttp%3A%2F%2F0-access.newspaperarchive.com.lib.utep.edu%2Fus%2Fmississippi%2Fbiloxi%2Fbiloxi-daily-herald%2F1899%2F05-06%2Fpage-6%3Ftag%3Dtierce%2Bwine%26rtserp%3Dtags%2Ftierce-wine%3Fpage%3D2%3E%0A%20%20%20%20%20%20%3Chttp%3A%2F%2Fdbpedia.org%2Fproperty%2Fdate%3E%0A%20%20%20%20%20%20%221899-05-05%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%20%20%20%23%20%221899-05-06%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%7D%20%7D%0A%7D)
    // The name is deterministic: callers namespace each pattern's variables uniquely, so no
    // global counter is needed to keep existence vars of distinct patterns apart.
    const existenceVar = DF.variable('mExists');
    buildOperation = AF.createExtend(
      buildOperation,
      existenceVar,
      AF.createTermExpression(DF.literal('dummy')),
    );
    vars.push(existenceVar);
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
  subQuery: Alg.Project;
  triplePatternBinds: Record<string, Alg.Expression>;
} & Pick<TransformContext, 'DF' | 'AF'>): Alg.Project | Alg.Extend {
  let buildOperation: Alg.Project | Alg.Extend = subQuery;
  // Finally add the binds after the subselect - Sort to create stable tests
  for (const [ variable, expression ] of Object.entries(triplePatternBinds).sort((a, b) => a[0].localeCompare(b[0]))) {
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

  const expressionFilters = collectMappingHeadBindsAndFilters({ mappingHeadVars, clusterSolver, AF });

  // A map between what each uqVar now equals. Adds bind after the subselect
  const triplePatternBinds: Record<string, Alg.Expression> = collectTriplePatternBinds({
    clusterSolver,
    triplePatternVars,
    expressionFilters,
    AF,
    DF,
  });

  // Construct the contents of our subselect
  let inProject: Alg.Operation = mapping.body.input;
  // Collapse unified head variables onto their fresh representative. Where a
  // representative would be bound twice, the redundant BIND becomes an equality
  // FILTER so the variables' equality is asserted, not dropped.
  for (const expression of [
    ...expressionFilters,
    ...clusterSolver.getStaticExpressionValidation()
      .map(x => AF.createOperatorExpression('sameTerm', [ AF.createTermExpression(x.term), x.expression ])),
  ]) {
    inProject = AF.createFilter(inProject, expression);
  }

  const subQuery = wrapOperationInProject({ triplePatternBinds, AF, DF, astTransformer, operation: inProject });
  return bindPatternTerms({ subQuery, triplePatternBinds, DF, AF });
}
