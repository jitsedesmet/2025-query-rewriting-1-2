import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from './transformContext.js';

export function substituteVarsThatArePreBoundToTerms<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  const { algebraTransformer } = c;
  return algebraTransformer.transformNode<'unsafe'>(
    op,
    { project: {
      transform: projection => substituteAndUnwrapExtends(c, projection),
    }},
  );
}

// Minus: continue = false, project: continue = false -- stay in var scope?
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

  // Find the variables that are bounded to a term. on this level
  const assignments: Record<string, RDF.Term> = {};
  const findAssignments = (op: Algebra.Operation): Algebra.Operation => {
    if (op.type === 'extend') {
      // If the variable is dependent on outside this joins scope, we cannot safely remove it
      const varIsProjected = stillUsedVars.some(var_ => var_.equals(op.variable));
      const expressionIsBasicTerm = op.expression.expressionType === Algebra.ExpressionTypes.TERM && (
        op.expression.term.termType === 'Literal' || op.expression.term.termType === 'NamedNode');
      if (!varIsProjected && expressionIsBasicTerm) {
        assignments[op.variable.value] = (<Algebra.TermExpression>op.expression).term;
        // Unwrap
        return findAssignments(op.input);
      }
      op.input = findAssignments(op.input);
      return op;
    }
    return op;
  };
  // Iterate over the join and find extends that bind to a term on the top level.
  join.input = join.input.map(input => findAssignments(input));

  const transformedProjection = c.algebraTransformer.transformNode<'unsafe'>(
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

function translateTerm(term: RDF.Term, assignments: Record<string, RDF.Term>): RDF.Term {
  if (term.termType === 'Variable' && assignments[term.value]) {
    return assignments[term.value];
  }
  return term;
}
