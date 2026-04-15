import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { Algebra as Alg } from '@traqula/algebra-transformations-1-2';
import type { ClusterSolver } from '../ClusterSolver.js';
import { objectRange, predicateRange, subjectRange } from '../RangeSet.js';
import type { TransformContext } from '../transformContext.js';
import type { Mapping, MappingHead, Template } from '../types.js';
import { isMappingHead, isRdfDefaultGraph, isRdfQuad, isRdfVar, RewriteNoMatchError, templateToExpr } from '../utils.js';

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
function headSPO(head: MappingHead | RDF.BaseQuad): (RDF.Term | MappingHead | Template)[] {
  return [ head.subject, head.predicate, head.object ];
}

/**
 * Extracts subject, predicate, object from a pattern or quad.
 * @param pattern - The pattern or quad
 * @returns Array of [subject, predicate, object]
 */
function patternSPO(pattern: Algebra.Pattern | RDF.BaseQuad): RDF.Term[] {
  return [ pattern.subject, pattern.predicate, pattern.object ];
}

/**
 * Register the cluster between the current mapping and the triple pattern.
 * Function allows us to recuse over Triple Terms or nested Mapping Heads.
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
  head: MappingHead | Algebra.Pattern | RDF.BaseQuad,
  pattern: Alg.Pattern | RDF.BaseQuad,
): void {
  // Static array that allows us to access the range using the position index.
  const varRangesInPos = <const> [ subjectRange, predicateRange, objectRange ];
  const spoPattern = patternSPO(pattern);
  for (const [ index, headTerm ] of headSPO(head).entries()) {
    const patternTerm = spoPattern[index];
    const variablePosRange = varRangesInPos[index];
    if ((isRdfQuad(headTerm) || isMappingHead(headTerm)) && isRdfQuad(patternTerm)) {
      // Recursion in triple term
      iterateMappingHead(c, mHVars, tPVars, headTerm, patternTerm);
    } else if (isRdfQuad(patternTerm)) {
      // UQ looks for tripleTerm but MappingHead does not provide:
      // TODO: Shortcutting, pattern term is quad but head is not. - will not match IF mapping where is SPARQL 1.1.
      throw new RewriteNoMatchError(
          `The user query contain quad ${JSON.stringify(patternTerm)} and cannot be matched to mapping head ${JSON.stringify(headTerm)}`,
      );
    } else {
      // Head can still be a Quad or MappingHead type
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
      if (!isRdfDefaultGraph(headTerm) && !isRdfDefaultGraph(patternTerm)) {
        c.clusterSolver.register(headTerm, patternTerm);
      }
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
 * - A template (if the value needs to be constructed)
 *
 * @param params - Configuration object
 * @param params.clusterSolver - The cluster solver with variable unification info
 * @param params.triplePatternVars - Variables from the user's triple pattern
 * @param params.headVarsRemap - Remapping for unified head variables
 * @param params.templateFilters - Array to collect template equality filters
 * @returns A record mapping variable names to their bindings
 */
function collectTriplePatternBinds({
  clusterSolver,
  triplePatternVars,
  headVarsRemap,
  templateFilters,
}: {
  clusterSolver: ClusterSolver;
  triplePatternVars: Record<string, RDF.Variable>;
  headVarsRemap: Record<string, RDF.Variable>;
  templateFilters: { term: RDF.Term; template: Template }[];
}): Record<string, RDF.Term | Template> {
  const triplePatternBinds: Record<string, RDF.Term | Template> = {};
  for (const tpVariable of Object.values(triplePatternVars)) {
    const cluster = clusterSolver.getCluster(tpVariable);
    const templates = clusterSolver.getTemplates(tpVariable);
    const term = cluster.term;
    if (term) {
      triplePatternBinds[tpVariable.value] = term;
      // In case the TP variable equals a term AND a template, the term-template equality needs to be checked!
      // Only needed when no mapping vars would have done so.
      if (cluster.vars.findIndex(value => value.value.startsWith('m')) === -1) {
        templateFilters.push(
          ...templates.map(template => ({ term, template })),
        );
      }
    } else {
      // If not bound to a term, check whether bound to a mapping var:
      const boundTo = cluster.vars.at(0);
      if (boundTo && boundTo.value.startsWith(`m`)) {
        triplePatternBinds[tpVariable.value] = headVarsRemap[boundTo.value] ?? boundTo;
      } else {
        // You bind to one of the mapping heads.
        triplePatternBinds[tpVariable.value] = templates[0];
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
function collectMappingHeadBindsAndFilters({ clusterSolver, mappingHeadVars, DF }: {
  clusterSolver: ClusterSolver;
  mappingHeadVars: Record<string, RDF.Variable>;
} & Pick<TransformContext, 'DF'>): {
    mappingHeadBinds: Record<string, RDF.Term>;
    headVarsRemap: Record<string, RDF.Variable>;
    templateFilters: { term: RDF.Term; template: Template }[];
  } {
  // If UQ triple pattern term is bound, and mapping head is var, put here - (starting Binds of subselect)
  const mappingHeadBinds: Record<string, RDF.Term> = {};
  // In case multiple headvars are equal to each-other, map them to their unifying replacement var.
  const headVarsRemap: Record<string, RDF.Variable> = {};
  const templateFilters: { term: RDF.Term; template: Template }[] = [];

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
        // TODO: when does this happen?
        throw new RewriteNoMatchError('mapping variable being bound to a blank node will result in empty result');
      }
      mappingHeadBinds[iterHeadVar.value] = cluster.term;
    }
    const templatesToRegister = clusterSolver.getTemplates(headVar);
    if (templatesToRegister.length > 0) {
      // If group has term, check if templates equal term, otherwise check if template equals var.
      // By checking templates to terms we can perform prefix validation checks.
      const term: RDF.Term = cluster.term ?? iterHeadVar;
      templateFilters.push(...templatesToRegister.map(template => ({ template, term })));
    }
  }

  return {
    templateFilters,
    mappingHeadBinds,
    headVarsRemap,
  };
}

/**
 * Rewrites an operation to use unified variable names.
 *
 * When multiple head variables are determined to be equal, they must use
 * the same variable name in the query. This function performs that substitution.
 *
 * @param params - Configuration object
 * @param params.headVarsRemap - Map of original var names to unified var names
 * @param params.operation - The operation to transform
 * @param params.astTransformer - AST transformer utility
 * @returns The transformed operation with unified variable names
 */
function rewriteUnifiedVariables({
  headVarsRemap,
  operation,
  astTransformer,
}: {
  headVarsRemap: Record<string, RDF.Variable>;
  operation: Algebra.Operation;
} & Pick<TransformContext, 'astTransformer'>): Algebra.Operation {
  if (Object.keys(headVarsRemap).length === 0) {
    return operation;
  }
  return <Alg.Operation> astTransformer.transformObject(operation, (something) => {
    if (isRdfVar(something) && headVarsRemap[something.value]) {
      return headVarsRemap[something.value];
    }
    // Values.bindings uses string keys for variable names — rename those too.
    if ('type' in something && something.type === 'values' && 'bindings' in something) {
      const valuesOp = <Alg.Values> something;
      valuesOp.bindings = valuesOp.bindings.map(binding => Object.fromEntries(
        Object.entries(binding).map(([ key, value ]) => [
          headVarsRemap[key] ? headVarsRemap[key].value : key,
          value,
        ]),
      ));
    }
    return something;
  });
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
 * Wraps an operation with FILTER expressions for template validations.
 *
 * When a template (constructed IRI, literal, etc.) must equal a specific term,
 * we add a FILTER to verify this equality at runtime.
 *
 * @param params - Configuration object
 * @param params.operation - The operation to wrap
 * @param params.templateFilters - Array of template-term equality checks
 * @param params.AF - Algebra factory
 * @param params.DF - Data factory
 * @returns The operation wrapped with necessary FILTER operations
 */
function wrapInTemplateFilters({ operation, templateFilters, AF, DF }: {
  operation: Algebra.Operation;
  templateFilters: { term: RDF.Term; template: Template }[];
} & Pick<TransformContext, 'AF' | 'DF'>): Algebra.Operation {
  let buildOperation = operation;
  for (const { term, template } of templateFilters) {
    buildOperation = AF.createFilter(
      buildOperation,
      AF.createOperatorExpression('=', [
        AF.createTermExpression(term),
        templateToExpr(AF, DF, template),
      ]),
    );
  }
  return buildOperation;
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
function wrapOperationInProject({
  triplePatternBinds,
  operation,
  astTransformer,
  DF,
  AF,
}: {
  triplePatternBinds: Record<string, RDF.Term | Template>;
  operation: Algebra.Operation;
} & Pick<TransformContext, 'astTransformer' | 'DF' | 'AF'>): Algebra.Project {
  let buildOperation = operation;
  // All variables required from subselect
  const variablesToSelect: Record<string, RDF.Variable> = {};
  astTransformer.visitObject(Object.values(triplePatternBinds), (something) => {
    if (isRdfVar(something)) {
      variablesToSelect[something.value] = something;
    }
  });
  const vars = Object.values(variablesToSelect);
  if (vars.length === 0) {
    // You cannot select nothing, but actually we just want this subquery to validate if data exists.
    // You cannot have a subAsk, but you can do a select over a dummy var: SELECT (1 as ?dummy)
    // [proof this works](https://query.comunica.dev/#transientDatasources=%2F%2Ffragments.dbpedia.org%2F2016-04%2Fen&query=SELECT%20*%0AWHERE%20%7B%0A%20%20%3Fs%20%3Fp%20%3Fo%20.%0A%20%20%7B%20SELECT%20%281%20as%20%3Fdummy%29%20WHERE%20%7B%0A%20%20%20%20%20%20%3Chttp%3A%2F%2F0-access.newspaperarchive.com.lib.utep.edu%2Fus%2Fmississippi%2Fbiloxi%2Fbiloxi-daily-herald%2F1899%2F05-06%2Fpage-6%3Ftag%3Dtierce%2Bwine%26rtserp%3Dtags%2Ftierce-wine%3Fpage%3D2%3E%0A%20%20%20%20%20%20%3Chttp%3A%2F%2Fdbpedia.org%2Fproperty%2Fdate%3E%0A%20%20%20%20%20%20%221899-05-05%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%20%20%20%23%20%221899-05-06%22%5E%5E%3Chttp%3A%2F%2Fwww.w3.org%2F2001%2FXMLSchema%23date%3E%0A%20%20%20%7D%20%7D%0A%7D)
    buildOperation = AF.createExtend(
      buildOperation,
      DF.variable('dummy'),
      AF.createTermExpression(DF.literal('dummy')),
    );
    vars.push(DF.variable('dummy'));
  }
  // SOrt allows for stable tests but does not practically change anything.
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
  triplePatternBinds: Record<string, RDF.Term | Template>;
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
 *
 * This is the core function that transforms a user's triple pattern into
 * an equivalent subquery that retrieves data from the RDF 1.1 representation.
 *
 * ## Algorithm Overview:
 *
 * 1. **Cluster Analysis**: Match the triple pattern against the mapping head,
 *    determining which variables must be equal and what values they're bound to.
 *
 * 2. **Head Variable Processing**: For each mapping head variable, determine
 *    if it's bound to a term, needs unification with other vars, or has template constraints.
 *
 * 3. **Pattern Variable Processing**: For each triple pattern variable, determine
 *    what it should bind to (term, mapping var, or template).
 *
 * 4. **Query Construction**: Build the subquery by:
 *    - Unifying variable names where needed
 *    - Injecting known bindings at query start
 *    - Adding template validation filters
 *    - Projecting required variables
 *
 * 5. **Result Binding**: Add EXTEND operations to bind user variables to results.
 *
 * @param c - The transformation context
 * @param pattern - The user's triple pattern to rewrite
 * @param mapping - The mapping definition to use
 * @returns A PROJECT or EXTEND operation representing the rewritten pattern
 * @throws Error if the pattern cannot be matched to the mapping
 *
 * @example
 * // Given pattern: ?t rdf:reifies <<( :me :name ?name )>>
 * // And mapping: CONSTRUCT { ?t rdf:reifies <<(?s ?p ?o)>> } WHERE { ... }
 * // Produces: { SELECT ?m0_o ?m0_t WHERE { ... } } BIND(?m0_o AS ?uq_name) BIND(?m0_t AS ?uq_t)
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

  const { mappingHeadBinds, headVarsRemap, templateFilters } =
    collectMappingHeadBindsAndFilters({ mappingHeadVars, DF, clusterSolver });

  // A map between what each uqVar now equals. Adds bind after the subselect
  const triplePatternBinds: Record<string, RDF.Term | Template> = collectTriplePatternBinds({
    clusterSolver,
    triplePatternVars,
    headVarsRemap,
    templateFilters,
  });

  // Construct the contents of our subselect
  let inProject: Alg.Operation = mapping.body.input;
  inProject = rewriteUnifiedVariables({ astTransformer, operation: inProject, headVarsRemap });
  inProject = rewriteToPreBindVars({ AF, DF, mappingHeadBinds, operation: inProject });
  inProject = wrapInTemplateFilters({
    AF,
    DF,
    templateFilters: [ ...templateFilters, ...clusterSolver.getStaticTemplateValidation() ],
    operation: inProject,
  });

  const subQuery = wrapOperationInProject({ triplePatternBinds, AF, DF, astTransformer, operation: inProject });
  return bindPatternTerms({ subQuery, triplePatternBinds, DF, AF });
}
