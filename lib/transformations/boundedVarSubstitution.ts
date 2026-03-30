import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { isRdfVar } from '../utils.js';

/**
 * Optimization transformation that substitutes variables with their known bound values.
 *
 * After query rewriting, some variables in subselects are known to be bound to specific
 * terms (via EXTEND operations). This transformation finds those assignments and
 * substitutes the concrete terms directly into triple patterns, which can enable
 * more efficient query execution.
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The transformed operation with variable substitutions applied
 *
 * @example
 * // Before:
 * // SELECT ?m0_o WHERE { BIND(<ex:a> AS ?m0_s) . ?m0_s ?m0_p ?m0_o }
 * // After:
 * // SELECT ?m0_o WHERE { <ex:a> ?m0_p ?m0_o }
 */
export function substituteVarsThatArePreBoundToTerms<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    { project: {
      transform: projection => substituteAndUnwrapExtends(c, projection),
    }},
  );
}

/**
 * Processes a projection to find and apply variable substitutions.
 * Looks for EXTEND operations that bind variables to simple terms and
 * substitutes those terms into the contained triple patterns.
 * Only perform this operation when the variables go out of scope due to the projection
 * @param c - The transformation context
 * @param projection - The projection operation to process
 * @returns The transformed projection with substitutions applied
 */
function substituteAndUnwrapExtends(c: TransformContext, projection: Algebra.Project): Algebra.Project {
  let join: Algebra.Join | undefined;
  const stillUsedVars: RDF.Variable[] = [ ...projection.variables ];
  if (projection.input.type === 'join') {
    join = projection.input;
  } else if (projection.input.type === 'extend') {
    // Iter the extends until you find a join or return
    const iter = (op: Algebra.Operation): void => {
      if (op.type === 'join') {
        join = op;
      } else if (op.type === 'extend') {
        stillUsedVars.push(op.variable);
        iter(op.input);
      }
    };
    iter(projection.input);
    if (!join) {
      return projection;
    }
  } else {
    return projection;
  }

  // Collect variables that appear as subjects/predicates/objects in triple patterns.
  // Only those can be safely substituted (and their BIND safely unwrapped).
  const varsInTriplePatterns = new Set<string>();
  algebraUtils.visitOperation(projection, {
    pattern: {
      visitor: (pattern) => {
        for (const term of [ pattern.subject, pattern.predicate, pattern.object ]) {
          if (isRdfVar(term)) {
            varsInTriplePatterns.add((<RDF.Variable> term).value);
          }
        }
      },
    },
  });

  // Collect variables declared in VALUES clauses. Substituting such a variable
  // would leave the VALUES clause unconstrained, causing spurious duplicate results.
  const varsInValuesClauses = new Set<string>();
  algebraUtils.visitOperation(projection, {
    values: {
      visitor: (values) => {
        for (const variable of values.variables) {
          varsInValuesClauses.add(variable.value);
        }
      },
    },
  });

  // Find the variables that are bounded to a term on this level
  const assignments: Record<string, RDF.Term> = {};
  const findAssignmentsAndUnwrap = (op: Algebra.Operation): Algebra.Operation => {
    if (op.type === 'extend') {
      // If the variable is dependent on outside this joins scope, we cannot safely remove it
      const varIsProjected = stillUsedVars.some(var_ => var_.equals(op.variable));
      const expressionIsBasicTerm = op.expression.subType === Algebra.ExpressionTypes.TERM && (
        op.expression.term.termType === 'Literal' || op.expression.term.termType === 'NamedNode');
      // Only unwrap when the variable actually appears in a triple pattern AND is not
      // declared in a VALUES clause — otherwise removing the BIND loses a join constraint
      // (against a computed value or against a VALUES filter).
      const varIsInTriplePattern = varsInTriplePatterns.has(op.variable.value);
      const varIsInValuesClause = varsInValuesClauses.has(op.variable.value);
      if (!varIsProjected && expressionIsBasicTerm && varIsInTriplePattern && !varIsInValuesClause) {
        assignments[op.variable.value] = (<Algebra.TermExpression>op.expression).term;
        // Unwrap
        return findAssignmentsAndUnwrap(op.input);
      }
      op.input = findAssignmentsAndUnwrap(op.input);
      return op;
    }
    return op;
  };
  // Iterate over the join and find extends that bind to a term on the top level.
  join.input = join.input.map(input => findAssignmentsAndUnwrap(input));

  const transformedProjection = algebraUtils.mapOperation<'unsafe', typeof projection>(
    projection,
    {
      pattern: {
        transform: (pattern) => {
          pattern.subject = translateTerm(pattern.subject, assignments);
          pattern.predicate = translateTerm(pattern.predicate, assignments);
          pattern.object = translateTerm(pattern.object, assignments);
          return pattern;
        },
      },
    },
  );
  return transformedProjection;
}

/**
 * Replaces a variable term with its assigned value if one exists.
 * @param term - The term to potentially replace
 * @param assignments - Map of variable names to their assigned terms
 * @returns The assigned term if the input is a bound variable, otherwise the original term
 */
function translateTerm(term: RDF.Term, assignments: Record<string, RDF.Term>): RDF.Term {
  if (term.termType === 'Variable' && assignments[term.value]) {
    return assignments[term.value];
  }
  return term;
}
