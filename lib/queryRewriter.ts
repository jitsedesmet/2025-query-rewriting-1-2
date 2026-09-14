import { toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import { VAR_PREFIX_USER_QUERY } from './consts.js';
import type { TransformationContext } from './transformContext.js';
import { createTransformationContext, parseQuery, prefixVarsInOperation } from './transformContext.js';
import type { QueryTransformation } from './types.js';
import { assertUserQueryIsSupported } from './userQueryRestrictions.js';

/**
 * @fileoverview The pipeline runner: a list of {@link QueryTransformation}s applied to a query in order.
 *
 * Around that list sits the bookkeeping every rewrite needs and no single pass should have to know about.
 * The user query's variables are renamed under {@link VAR_PREFIX_USER_QUERY} before anything runs, so that
 * a mapping variable and a user variable of the same name cannot be unified by accident; the query's own
 * solution modifiers are peeled off first and put back afterwards, over an `EXTEND` per projected variable
 * restoring the name the user wrote.
 *
 * Every rewrite gets a {@link TransformationContext} of its own: the {@link ClusterSolver} in it is
 * stateful, and the pipeline is asynchronous, so two concurrent rewrites sharing one context would
 * interleave.
 */

/** A configured pipeline, ready to rewrite queries. */
export interface QueryRewriter {
  /**
   * Rewrites a SPARQL query string.
   * @param query - The query to rewrite
   * @returns the rewritten query
   */
  rewriteQuery: (query: string) => Promise<string>;
  /**
   * Rewrites a query that is already in algebra form.
   * @param operation - The operation to rewrite
   * @returns the rewritten operation
   */
  rewriteOperation: (operation: Algebra.Operation) => Promise<Algebra.Operation>;
}

/**
 * Whether a GROUP node sits at the top of the operation's Extend / Filter / OrderBy chain.
 *
 * This matters for the projection rebuilding below: the extra outer EXTEND nodes it adds for variable
 * renaming must not be visible to `toAst`'s `translateAlgProject`, which flattens all Extend nodes, replaces
 * intermediate aggregate variables by their aggregate expressions, and pushes any unused one into the WHERE
 * clause - producing invalid SPARQL such as `BIND(COUNT(?o) AS ?count)`.
 * @param op - The operation to inspect
 * @returns whether the query groups, in which case the grouped sub-tree is wrapped in a subSELECT first
 */
function hasGroupInTopLevelChain(op: Algebra.Operation): boolean {
  if (op.type === Algebra.Types.GROUP) {
    return true;
  }
  if (
    op.type === Algebra.Types.EXTEND ||
    op.type === Algebra.Types.FILTER ||
    op.type === Algebra.Types.ORDER_BY
  ) {
    return hasGroupInTopLevelChain((<{ input: Algebra.Operation }>op).input);
  }
  return false;
}

/**
 * Runs the pipeline over the pattern of a query, restoring the solution modifiers it was peeled out of.
 * @param c - The transformation context of this rewrite
 * @param transformations - The pipeline to run
 * @param operation - The parsed user query
 * @returns the rewritten query, modifiers and projected variable names as the user wrote them
 */
async function rewriteParsedQuery(
  c: TransformationContext,
  transformations: readonly QueryTransformation[],
  operation: Algebra.Operation,
): Promise<Algebra.Operation> {
  assertUserQueryIsSupported(operation);

  // Peel off a SLICE (LIMIT/OFFSET) modifier so we can reach the inner Project.
  // SELECT ... LIMIT/OFFSET produces Slice(Project(...)) (or Slice(Distinct/Reduced(Project(...)))).
  const slice = operation.type === Algebra.Types.SLICE ? operation : undefined;
  const afterSlice: Algebra.Operation = slice ? slice.input : operation;

  // Peel off a DISTINCT or REDUCED modifier so we can reach the inner Project.
  // SELECT DISTINCT/REDUCED produce Distinct/Reduced(Project(...)) in the algebra.
  const isDistinct = afterSlice.type === Algebra.Types.DISTINCT;
  const isReduced = afterSlice.type === Algebra.Types.REDUCED;
  const innerAlgebra: Algebra.Operation = (isDistinct || isReduced) ? afterSlice.input : afterSlice;

  let rewritten = innerAlgebra.type === Algebra.Types.PROJECT ? innerAlgebra.input : innerAlgebra;
  rewritten = prefixVarsInOperation(c, rewritten, VAR_PREFIX_USER_QUERY);
  for (const transformation of transformations) {
    rewritten = await transformation(c, rewritten);
  }

  if (innerAlgebra.type === Algebra.Types.PROJECT) {
    // Because of the variable renaming, when we group,
    // we need to group as part of a subquery and then rename afterwards.
    if (hasGroupInTopLevelChain(rewritten)) {
      rewritten = c.AF.createProject(rewritten, innerAlgebra.variables
        .map(variable => c.DF.variable(`${VAR_PREFIX_USER_QUERY}${variable.value}`)));
    }

    // Wrap the rewritten query in extends to the original variable names and project those.
    for (const variable of innerAlgebra.variables) {
      rewritten = c.AF.createExtend(
        rewritten,
        variable,
        c.AF.createTermExpression(c.DF.variable(`${VAR_PREFIX_USER_QUERY}${variable.value}`)),
      );
    }
    rewritten = c.AF.createProject(rewritten, innerAlgebra.variables);
  }

  if (isDistinct) {
    rewritten = c.AF.createDistinct(rewritten);
  } else if (isReduced) {
    rewritten = c.AF.createReduced(rewritten);
  }

  if (slice) {
    rewritten = c.AF.createSlice(rewritten, slice.start, slice.length);
  }
  return rewritten;
}

/**
 * Creates a rewriter applying the given transformations, in order, to every query handed to it.
 * @param transformations - The pipeline, for instance the one
 * {@link createDefaultTransformationPipeline} builds
 * @returns the rewriter
 * @example
 * const rewriter = createQueryRewriter([
 *   rewriteNonRecursivePathsTransformation(),
 *   unfoldingTransformation(mappingFromConstructQueries([ construct ])),
 *   filterFalseTransformation(),
 * ]);
 * const sparql11Query = await rewriter.rewriteQuery('SELECT * WHERE { ?s ?p ?o }');
 */
export function createQueryRewriter(transformations: readonly QueryTransformation[]): QueryRewriter {
  return {
    async rewriteQuery(query: string): Promise<string> {
      const c = createTransformationContext();
      const rewritten = await rewriteParsedQuery(c, transformations, parseQuery(c, query));
      return c.generator.generate(toAst(rewritten));
    },
    async rewriteOperation(operation: Algebra.Operation): Promise<Algebra.Operation> {
      return rewriteParsedQuery(createTransformationContext(), transformations, operation);
    },
  };
}
