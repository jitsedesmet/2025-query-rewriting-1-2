import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { Algebra as Alg } from '@traqula/algebra-transformations-1-2';
import type { ClusterSolver } from '../ClusterSolver.js';
import { objectRange, predicateRange, subjectRange } from '../RangeSet.js';
import type { TransformContext } from '../transformContext.js';
import type { Mapping, MappingHead, Template } from '../types.js';
import { isMappingHead, isRdfDefaultGraph, isRdfQuad, isRdfVar, templateToExpr } from '../utils.js';

/**
 * Returns the subject, predicate, and object of a {@link MappingHead} or
 * {@link RDF.BaseQuad} as an ordered triple.
 *
 * @param head - The mapping head or quad to destructure.
 */
function headSPO(head: MappingHead | RDF.BaseQuad): (RDF.Term | MappingHead | Template)[] {
  return [ head.subject, head.predicate, head.object ];
}

/**
 * Returns the subject, predicate, and object of an algebra {@link Algebra.Pattern}
 * or {@link RDF.BaseQuad} as an ordered triple.
 *
 * @param pattern - The triple pattern or quad to destructure.
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
      throw new Error(
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
 * Builds the binding map for each user-query triple-pattern variable by inspecting its cluster.
 *
 * For every variable in `triplePatternVars` the function looks up its cluster in the solver
 * and decides what it is bound to:
 * - **Bound to a static term** – the term is recorded directly, and any template equalities that
 *   were not already covered by a mapping-head variable comparison are queued as `templateFilters`.
 * - **Bound to a mapping-head variable** – the mapping variable (potentially remapped to a unified
 *   variable by `headVarsRemap`) is used as the binding value.
 * - **Bound to a template** – the first template associated with the cluster is used directly.
 *
 * @returns A map from user-query variable name to the term or template it should be bound to
 *          after the subselect.
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
 * Builds the pre-bind map for mapping-head variables and collects any template filter constraints.
 *
 * For each mapping-head variable this function:
 * 1. Detects whether it is part of a cluster with other mapping-head variables.  When multiple
 *    mapping-head variables are equal to each other they are all renamed to a fresh unified variable
 *    (prefix `r`), and the `headVarsRemap` map is populated accordingly.
 * 2. If the cluster is bound to a static term, that term is recorded in `mappingHeadBinds`
 *    so it can be injected via a `BIND(term AS ?var)` extend before the mapping body.
 * 3. If the cluster has associated templates, template filter entries are produced that will
 *    later be emitted as `FILTER` expressions inside the subselect.
 *
 * @returns An object containing:
 *   - `mappingHeadBinds`  – map from (possibly remapped) variable name to bound static term.
 *   - `headVarsRemap`     – map from original mapping-head variable name to its unified replacement.
 *   - `templateFilters`   – list of `{ template, term }` pairs to emit as `FILTER` expressions.
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
        throw new Error('mapping variable being bound to a blank node will result in empty result');
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
 * Walks `operation` and replaces every variable whose name appears in `headVarsRemap`
 * with the corresponding unified replacement variable.
 *
 * This is a no-op when `headVarsRemap` is empty.
 *
 * @param args.headVarsRemap  - Map from original variable name to its replacement.
 * @param args.operation      - The algebra operation to transform.
 * @param args.astTransformer - The AST transformer used for the deep walk.
 * @returns The (possibly new) algebra operation with renamed variables.
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
    return something;
  });
}

/**
 * Prepends `BIND(term AS ?var)` extend nodes to `operation` for every entry in
 * `mappingHeadBinds`, making each mapping-head variable carry its statically known value
 * inside the subselect.
 *
 * The extends are joined with an empty BGP so the static bindings do not interfere
 * with the mapping body.  The entries are sorted alphabetically for test stability.
 *
 * @param args.mappingHeadBinds - Map from variable name to the static term to bind.
 * @param args.operation        - The mapping-body operation to extend.
 * @param args.AF               - Algebra factory.
 * @param args.DF               - Data factory.
 * @returns The extended algebra operation.
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
 * Wraps `operation` in a chain of `FILTER(term = templateExpr)` expressions for
 * each entry in `templateFilters`.
 *
 * These filters ensure that, at evaluation time, the value of a variable matches
 * what the template would produce.  They are needed when a mapping-head variable is
 * constrained by both a static term and a template (or when a static term in the
 * user query must match a template in the mapping head).
 *
 * @param args.operation       - The inner operation to filter.
 * @param args.templateFilters - List of `{ term, template }` pairs to emit as filters.
 * @param args.AF              - Algebra factory.
 * @param args.DF              - Data factory.
 * @returns The (possibly wrapped) algebra operation.
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
 * Wraps `operation` in a `Project` node that selects exactly the variables needed
 * to compute the `triplePatternBinds` in the outer scope.
 *
 * The projected variable set is derived by visiting the values of `triplePatternBinds`
 * and collecting all variables referenced there.  If no variables are needed (all
 * bindings are static terms), a dummy `SELECT (1 AS ?dummy)` is emitted so the
 * sub-query remains valid SPARQL.
 *
 * @param args.triplePatternBinds - Map from user-query variable name to its binding (term or template).
 * @param args.operation          - The inner operation to project.
 * @param args.astTransformer     - Used to collect variables from the bind values.
 * @param args.DF                 - Data factory.
 * @param args.AF                 - Algebra factory.
 * @returns A `Project` node selecting the required variables.
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
 * Appends `BIND(templateExpr AS ?var)` extends after the sub-query for every entry
 * in `triplePatternBinds`.
 *
 * These extends expose the rewritten values of the user-query variables to the
 * outer join, making the sub-query act as a self-contained "virtual triple pattern".
 * Entries are sorted alphabetically for test stability.
 *
 * @param args.subQuery            - The subselect `Project` node to extend.
 * @param args.triplePatternBinds  - Map from user-query variable name to its binding.
 * @param args.DF                  - Data factory.
 * @param args.AF                  - Algebra factory.
 * @returns The extended projection.
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
