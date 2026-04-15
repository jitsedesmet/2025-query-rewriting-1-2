import { toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { rewriteSinglePattern } from './transformations/index.js';
import type { TransformContext } from './transformContext.js';
import { prefixVarsInOperation, parseQuery } from './transformContext.js';
import type { Mapping } from './types.js';
import { createFilterFalse, isRdfVar, RewriteNoMatchError } from './utils.js';

/**
 * Transforms a SPARQL query by applying the configured mappings and transformations.
 *
 * This is the main entry point for query rewriting. It:
 * 1. Parses the input query
 * 2. Strips any outer DISTINCT/REDUCED modifier, then the Project
 * 3. Prefixes user query variables with "uq_"
 * 4. Applies each transformation in order
 * 5. Wraps the result with EXTEND operations to map back to original variable names
 * 6. Re-applies the Project and any stripped DISTINCT/REDUCED modifier
 * 7. Generates the output SPARQL string
 *
 * @param c - The transformation context containing mappings and factories
 * @param input - The SPARQL query string to transform
 * @param transformations - Array of transformation functions to apply in order
 * @returns The transformed SPARQL query string
 *
 * @example
 * const result = queryTransform(context, 'SELECT * WHERE { ?s ?p ?o }', [operationTransform]);
 */
export function queryTransform(
  c: TransformContext,
  input: string,
  transformations: ((c: TransformContext, op: Algebra.Operation) => Algebra.Operation)[],
): string {
  const algebra = parseQuery(c, input);

  // Peel off a DISTINCT or REDUCED modifier so we can reach the inner Project.
  // SELECT DISTINCT/REDUCED produce Distinct/Reduced(Project(...)) in the algebra.
  const isDistinct = algebra.type === 'distinct';
  const isReduced = algebra.type === 'reduced';
  const innerAlgebra: Algebra.Operation = (isDistinct || isReduced) ? algebra.input : algebra;

  let transformedAlgebra = innerAlgebra;
  if (innerAlgebra.type === 'project') {
    transformedAlgebra = innerAlgebra.input;
  }
  transformedAlgebra = prefixVarsInOperation(c, transformedAlgebra, 'uq_');
  for (const transformation of transformations) {
    transformedAlgebra = transformation(c, transformedAlgebra);
  }

  if (innerAlgebra.type === 'project') {
    // Wrap the transformedAlgebra in extends to the originalVar names and project those
    for (const variable of innerAlgebra.variables) {
      transformedAlgebra = c.AF.createExtend(
        transformedAlgebra,
        variable,
        c.AF.createTermExpression(c.DF.variable(`uq_${variable.value}`)),
      );
    }
    transformedAlgebra = c.AF.createProject(transformedAlgebra, innerAlgebra.variables);
  }

  if (isDistinct) {
    transformedAlgebra = c.AF.createDistinct(transformedAlgebra);
  } else if (isReduced) {
    transformedAlgebra = c.AF.createReduced(transformedAlgebra);
  }

  const transformedAst = toAst(transformedAlgebra);
  return c.generator.generate(transformedAst);
}

/**
 * Core transformation that rewrites BGPs (Basic Graph Patterns) into unions of joins.
 *
 * For each BGP, this enumerates all possible mapper assignments across the triple
 * patterns and produces a UNION of JOINs. Each UNION branch corresponds to one
 * assignment of mappers to patterns; branches where any pattern is incompatible
 * with its assigned mapper are represented by FILTER(FALSE).
 *
 * A BGP of `n` triple patterns with `m` mappers produces at most `m^n` UNION branches.
 * Early pruning means incompatible top-level mapper choices collapse into a single
 * FILTER(FALSE) rather than propagating into the subtree.
 *
 * @param c - The transformation context
 * @param input - The algebra operation to transform
 * @returns The transformed operation with BGPs rewritten to unions of joins
 *
 * @example
 * // Input: BGP { ?s ?p ?o . ?a ?b ?c }  (2 mappers)
 * // Output: UNION [
 * //   JOIN [ mapper0_p0(?s ?p ?o), mapper0_p1(?a ?b ?c) ],
 * //   JOIN [ mapper0_p0(?s ?p ?o), mapper1_p1(?a ?b ?c) ],
 * //   JOIN [ mapper1_p0(?s ?p ?o), mapper0_p1(?a ?b ?c) ],
 * //   JOIN [ mapper1_p0(?s ?p ?o), mapper1_p1(?a ?b ?c) ],
 * // ]
 */
export function operationTransform(c: TransformContext, input: Algebra.Operation): Algebra.Operation {
  const transformed = algebraUtils.mapOperation<'unsafe', typeof input>(
    input,
    { [Algebra.Types.BGP]: {
      transform: input => bgpTransform(c, input),
    }},
  );
  return transformed;
}

/**
 * Transforms a BGP (Basic Graph Pattern) into a union of joins.
 *
 * For each possible assignment of mappers to triple patterns, this creates a JOIN of
 * the rewrites for each pattern. All such joins are collected into a UNION.
 *
 * A BGP of `n` triple patterns with `m` mappers results in at most `m^n` UNION branches.
 * Branches where any pattern cannot be matched by its assigned mapper are pruned with
 * a single FILTER(FALSE) (identity for UNION, absorbing for JOIN).
 *
 * Variables within each branch are uniquely named `m{mapperIndex}_{patternIndex}_…`
 * so that the same mapper applied to two different patterns in the same JOIN never
 * produces variable-name collisions.
 *
 * @param c - The transformation context
 * @param input - The BGP to transform
 * @returns A UNION of JOINs, or a single JOIN if only one branch exists
 */
export function bgpTransform(c: TransformContext, input: Algebra.Bgp): Algebra.Operation {
  if (input.patterns.length === 0) {
    return input;
  }

  // Pre-compute re-prefixed mappers for all (mapperIndex × patternIndex) pairs.
  // rePrefixMapperForPattern traverses the whole mapper AST, so doing it here
  // once costs O(m·n·|mapper|) instead of O(m^n·|mapper|) if done inside the DFS.
  const rePrefixedMappers = c.mappers.map((mapper, mapperIndex) =>
    input.patterns.map((_, patternIndex) =>
      rePrefixMapperForPattern(c, mapper, mapperIndex, patternIndex)));

  const savedState = c.clusterSolver.saveState();
  const branches = buildMappingBranches(c, input.patterns, 0, [], rePrefixedMappers);
  c.clusterSolver.restoreState(savedState);

  if (branches.length === 1) {
    return branches[0];
  }
  return c.AF.createUnion(branches, true);
}

/**
 * Recursively builds all mapper-assignment branches for the given patterns.
 *
 * For each mapper choice for the current pattern, attempts to rewrite that pattern.
 * On a `RewriteNoMatchError`, emits FILTER(FALSE) for that branch (pruning the entire
 * subtree rooted at this mapper×pattern choice).  All other errors propagate so
 * genuine bugs are never silently swallowed.
 *
 * The inner `saveState`/`restoreState` is intentionally absent: `rewriteSinglePattern`
 * always begins with `clusterSolver.clear()`, so solver state from one mapper attempt
 * never bleeds into the next.  The outer save/restore in `bgpTransform` is still
 * needed to preserve any pre-BGP solver context.
 *
 * @param c - The transformation context
 * @param patterns - The full list of triple patterns in the BGP
 * @param patternIndex - Index of the current pattern being assigned
 * @param accumulated - Subqueries accumulated so far for the current branch
 * @param rePrefixedMappers - Pre-computed re-prefixed mappers[mapperIndex][patternIndex]
 * @returns Array of operations (JOINs or FILTER-FALSEs) for all branches
 */
function buildMappingBranches(
  c: TransformContext,
  patterns: readonly Algebra.Pattern[],
  patternIndex: number,
  accumulated: Algebra.Operation[],
  rePrefixedMappers: Mapping[][],
): Algebra.Operation[] {
  if (patternIndex === patterns.length) {
    return [ c.AF.createJoin(accumulated, true) ];
  }

  const pattern = patterns[patternIndex];
  const allBranches: Algebra.Operation[] = [];

  for (const [ mapperIndex ] of c.mappers.entries()) {
    try {
      const subquery = rewriteSinglePattern(c, pattern, rePrefixedMappers[mapperIndex][patternIndex]);
      const subBranches = buildMappingBranches(c, patterns, patternIndex + 1, [ ...accumulated, subquery ], rePrefixedMappers);
      allBranches.push(...subBranches);
    } catch (e) {
      if (!(e instanceof RewriteNoMatchError)) {
        throw e;
      }
      allBranches.push(createFilterFalse(c));
    }
  }

  return allBranches;
}

/**
 * Creates a copy of `mapper` with its variables re-prefixed from `m{i}_` to `m{i}_{j}_`.
 *
 * This ensures that applying the same mapper to two different triple patterns in the
 * same JOIN produces disjoint variable names, preventing unintended equi-joins.
 *
 * @param c - The transformation context
 * @param mapper - The mapper to re-prefix
 * @param mapperIndex - Index of the mapper (i in m{i}_)
 * @param patternIndex - Index of the current triple pattern (j in m{i}_{j}_)
 * @returns A new Mapping with updated variable names
 */
function rePrefixMapperForPattern(
  c: TransformContext,
  mapper: Mapping,
  mapperIndex: number,
  patternIndex: number,
): Mapping {
  const oldPrefix = `m${mapperIndex}_`;
  const newPrefix = `m${mapperIndex}_${patternIndex}_`;
  return <Mapping> c.astTransformer.transformObject(mapper, (obj: object) => {
    if (isRdfVar(obj) && obj.value.startsWith(oldPrefix)) {
      return c.DF.variable(newPrefix + obj.value.slice(oldPrefix.length));
    }
    if ('type' in obj && (<Record<string, unknown>> obj).type === 'values' && 'bindings' in obj) {
      const valuesOp = <Algebra.Values> obj;
      valuesOp.bindings = valuesOp.bindings.map(binding =>
        Object.fromEntries(Object.entries(binding).map(([ key, value ]) => [
          key.startsWith(oldPrefix) ? newPrefix + key.slice(oldPrefix.length) : key,
          value,
        ])));
    }
    return obj;
  });
}
