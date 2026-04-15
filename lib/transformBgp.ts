import { toAst } from '@traqula/algebra-sparql-1-2';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { rewriteSinglePattern } from './transformations/index.js';
import type { TransformContext } from './transformContext.js';
import { prefixVarsInOperation, parseQuery } from './transformContext.js';
import { createFilterFalse } from './utils.js';

/**
 * Returns true when a GROUP node exists at the top of the operation's
 * Extend / Filter / OrderBy chain.
 *
 * This matters for `queryTransform`: when the user query contains a GROUP BY,
 * extra outer EXTEND nodes added for variable renaming must not be visible to
 * `toAst`'s `translateAlgProject`. That function flattens all Extend nodes and
 * replaces intermediate aggregate variables (e.g. `var0`) with their aggregate
 * expressions. Any unused flattened Extend gets pushed into the WHERE clause via
 * `putExtensionsInGroup`, producing invalid SPARQL such as
 * `BIND(COUNT(?o) AS ?count)`.
 *
 * Wrapping the grouped sub-tree in a subSELECT (Project) before adding the outer
 * EXTEND renames isolates the aggregate from the outer scope and avoids the issue.
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
 * **GROUP BY queries**: when the user query contains a GROUP BY (detected by
 * `hasGroupInTopLevelChain`), the transformed algebra is first wrapped in a
 * subSELECT projecting the `uq_`-prefixed result variables. This prevents
 * `toAst` from incorrectly serialising aggregate alias Extend nodes as
 * `BIND(aggregate AS var)` in the WHERE clause.
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
    // When the user query has GROUP BY, a chain of Extend nodes sits above the Group
    // node in the algebra. toAst's translateAlgProject flattens all visible Extend
    // nodes and replaces intermediate aggregate variables with their expressions.
    // Any Extend that does not end up in the SELECT list or GROUP BY is then dumped
    // into the WHERE clause by putExtensionsInGroup, producing invalid SPARQL like
    // BIND(COUNT(?o) AS ?count). Wrapping the grouped sub-tree in a Project
    // (subSELECT) isolates it from the outer renaming Extends.
    if (hasGroupInTopLevelChain(transformedAlgebra)) {
      const uqVariables = innerAlgebra.variables.map(v => c.DF.variable(`uq_${v.value}`));
      transformedAlgebra = c.AF.createProject(transformedAlgebra, uqVariables);
    }

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
 * Core transformation that rewrites BGPs (Basic Graph Patterns) into unions of subselects.
 *
 * For each triple pattern in a BGP, this creates a UNION of alternatives where
 * each alternative corresponds to one of the configured mappings. This is the
 * key operation that enables query rewriting from SPARQL 1.2 to SPARQL 1.1.
 *
 * A BGP of `n` triple patterns with `m` mappers results in:
 * - A JOIN of `n` unions
 * - Each union has `m` alternatives (one per mapper)
 *
 * @param c - The transformation context
 * @param input - The algebra operation to transform
 * @returns The transformed operation with BGPs rewritten to unions
 *
 * @example
 * // Input: BGP { ?s ?p ?o . ?a ?b ?c }
 * // Output: JOIN [
 * //   UNION [ mapper1(?s ?p ?o), mapper2(?s ?p ?o) ],
 * //   UNION [ mapper1(?a ?b ?c), mapper2(?a ?b ?c) ]
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
 * Transforms a BGP (Basic Graph Pattern) into a join of unions.
 * Each triple pattern becomes a union of subselects (one per mapper).
 *
 * @param c - The transformation context
 * @param input - The BGP to transform
 * @returns A Join containing one Union per triple pattern
 */
export function bgpTransform(c: TransformContext, input: Algebra.Bgp): Algebra.Join {
  return c.AF.createJoin(input.patterns.map(pattern => mapPattern(c, pattern)), true);
}

/**
 * Transforms a single triple pattern into a union of alternatives.
 *
 * For each configured mapper, attempts to rewrite the pattern using that mapper.
 * If rewriting fails (e.g., incompatible patterns), a FILTER(FALSE) placeholder
 * is used to maintain the union structure.
 *
 * @param c - The transformation context
 * @param pattern - The triple pattern to transform
 * @returns A Union of rewritten patterns (or FILTER(FALSE) for non-matching mappers)
 */
export function mapPattern(
  c: TransformContext,
  pattern: Algebra.Pattern,
): Algebra.Union | Algebra.Filter | Algebra.Project | Algebra.Extend {
  const mappedPatterns = c.mappers.map((mapper) => {
    try {
      return rewriteSinglePattern(c, pattern, mapper);
    } catch {
      // Console.error(e);
      return createFilterFalse(c);
    }
  });
  if (mappedPatterns.length === 1) {
    return mappedPatterns[0];
  }
  return c.AF.createUnion(mappedPatterns, true);
}
