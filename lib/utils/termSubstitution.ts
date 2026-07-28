import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse, termTrue } from './operationhelpers.js';

/**
 * A map from variable name to the term that variable is statically known to be bound to.
 */
export type TermSubstitutions = Record<string, RDF.Term>;

/**
 * Applies a term-substitution map to an operation sub-tree using `mapOperation` for traversal.
 *
 * Substituting `?v` by `t` is only value-preserving when every solution of `op` binds `?v` to `t`;
 * it is up to the caller to establish that (see for instance
 * {@link certainlyBoundVariables}). What this function guarantees is that *every* occurrence of the
 * substituted variables is dealt with, so the variables are no longer bound by the result:
 *
 * - BGP / PATH: substitutes variable references in subjects, predicates and objects.
 * - EXTEND whose variable is being substituted:
 *     same term   → unwrap
 *     term differ → FILTER(FALSE)
 *     complex     → FILTER(sameTerm(expr, term)); solution mappings are compatible on *term*
 *                   equality, so `sameTerm` - and not `=` - is the faithful residual constraint.
 * - VALUES: rows binding the variable to another term (or leaving it UNDEF) are dropped and the
 *   column is removed; see {@link cleanupValues}.
 * - PROJECT: substituted variables are removed from the projection list; the inner body
 *   is recursed into so that outer substitutions propagate into nested subqueries.
 * - GROUP: substituted variables are removed from the GROUP BY list; aggregate expressions
 *   are rewritten via {@link substituteTermsInExpression}.
 * - ORDER_BY: ordering expressions are rewritten via {@link substituteTermsInExpression}.
 * - LEFT_JOIN: the OPTIONAL condition is rewritten via {@link substituteTermsInExpression}.
 * - FILTER: the filter expression is excluded from automatic traversal and handled via
 *   {@link substituteTermsInExpression}, which substitutes variables in conditions and recurses into
 *   EXISTS/NOT EXISTS sub-patterns.
 * - EXTEND expression: also excluded from automatic traversal and handled via
 *   {@link substituteTermsInExpression}.
 * - All other operations: traversal is handled automatically by mapOperation.
 *
 * @param c - The transformation context
 * @param op - The operation to substitute in
 * @param subs - The variable to term substitutions to apply
 * @returns The operation in which the substituted variables no longer occur
 */
export function substituteTerms(
  c: TransformContext,
  op: Algebra.Operation,
  subs: TermSubstitutions,
): Algebra.Operation {
  const { AF } = c;
  const subExpr = (e: Algebra.Expression): Algebra.Expression => substituteTermsInExpression(c, e, subs);
  const subTerm = (term: RDF.Term): RDF.Term =>
    (term.termType === 'Variable' && subs[term.value] !== undefined) ? subs[term.value] : term;

  return algebraUtils.mapOperation<'unsafe', Algebra.Operation>(op, {
    [Algebra.Types.BGP]: { transform: (bgp) => {
      bgp.patterns = bgp.patterns.map(p =>
        AF.createPattern(subTerm(p.subject), subTerm(p.predicate), subTerm(p.object), subTerm(p.graph)));
      return bgp;
    } },
    [Algebra.Types.PATH]: { transform: (path) => {
      path.subject = subTerm(path.subject);
      path.object = subTerm(path.object);
      return path;
    } },
    // Exclude expression from automatic traversal; it is handled manually in the transform.
    [Algebra.Types.EXTEND]: {
      preVisitor: () => ({ ignoreKeys: new Set([ 'expression' ]) }),
      transform: (extend) => {
        const varSub = subs[extend.variable.value];

        if (varSub === undefined) {
          // Substitute vars in the expression itself.
          extend.expression = subExpr(extend.expression);
          return extend;
        }

        // In case the var being assigned to is in replaced:
        // 1. the simple bind matching assignment is removed, and
        // 2. Simple bind not matching becomes a Filter false.
        // 3. complex bind becomes a filter,

        const expr = extend.expression;
        if (expr.subType === Algebra.ExpressionTypes.TERM && expr.term.termType !== 'Variable') {
          if (expr.term.equals(varSub)) {
            return extend.input;
          }
          return createFilterFalse(c, extend.input);
        }
        return AF.createFilter(
          extend.input,
          AF.createOperatorExpression('sameTerm', [ subExpr(expr), AF.createTermExpression(varSub) ]),
        );
      },
    },
    [Algebra.Types.VALUES]: {
      transform: values => cleanupValues(c, values, subs),
    },
    // The OPTIONAL condition is an expression too, and is excluded from automatic traversal alike.
    [Algebra.Types.LEFT_JOIN]: {
      preVisitor: () => ({ ignoreKeys: new Set([ 'expression' ]) }),
      transform: (leftJoin) => {
        if (leftJoin.expression !== undefined) {
          leftJoin.expression = subExpr(leftJoin.expression);
        }
        return leftJoin;
      },
    },
    // Recurse into the inner body and drop substituted variables from the projection list.
    // This propagates outer substitutions into nested subqueries.
    [Algebra.Types.PROJECT]: {
      preVisitor: () => ({ ignoreKeys: new Set([ 'variables' ]) }),
      transform: (project) => {
        project.variables = project.variables.filter(v => subs[v.value] === undefined);
        return project;
      },
    },
    // Exclude expression from automatic traversal and apply substituteTermsInExpression manually.
    // It substitutes variables in conditions and recurses into EXISTS/NOT EXISTS
    // sub-patterns, giving complete and correct substitution of the filter expression.
    [Algebra.Types.FILTER]: {
      preVisitor: () => ({ ignoreKeys: new Set([ 'expression' ]) }),
      transform: (filter) => {
        filter.expression = subExpr(filter.expression);
        return filter;
      },
    },
    // Drop substituted variables from the GROUP BY list and substitute inside aggregates.
    [Algebra.Types.GROUP]: {
      preVisitor: () => ({ ignoreKeys: new Set([ 'variables', 'aggregates' ]) }),
      transform: (group) => {
        group.variables = group.variables.filter(v => subs[v.value] === undefined);
        group.aggregates = group.aggregates.map(agg => ({ ...agg, expression: subExpr(agg.expression) }));
        return group;
      },
    },
    // Substitute variables referenced in ORDER BY expressions.
    [Algebra.Types.ORDER_BY]: {
      preVisitor: () => ({ ignoreKeys: new Set([ 'expressions' ]) }),
      transform: (orderBy) => {
        orderBy.expressions = orderBy.expressions
          .map(e => subExpr(e))
          .filter(expr => !(expr.subType === Algebra.ExpressionTypes.TERM && expr.term.termType !== 'Variable'));

        if (orderBy.expressions.length > 0) {
          return orderBy;
        }

        return orderBy.input;
      },
    },
    [Algebra.Types.GRAPH]: {
      transform: (graph) => {
        graph.name = <RDF.Variable | RDF.NamedNode> subTerm(graph.name);
        return graph;
      },
    },
  });
}

/**
 * Applies a term-substitution map to an expression.
 *
 * Besides replacing the variable terms themselves, two constructs need special care:
 * - `BOUND(?v)`: the substituted variable is known to be bound, and `BOUND` only accepts a variable
 *   argument, so the call is replaced by `true`.
 * - `EXISTS` / `NOT EXISTS`: the sub-pattern is an operation, and is substituted through
 *   {@link substituteTerms}.
 *
 * @param c - The transformation context
 * @param expr - The expression to substitute in
 * @param subs - The variable to term substitutions to apply
 * @returns The expression in which the substituted variables no longer occur
 */
export function substituteTermsInExpression(
  c: TransformContext,
  expr: Algebra.Expression,
  subs: TermSubstitutions,
): Algebra.Expression {
  const { AF } = c;
  return algebraUtils.mapOperationSub<'unsafe', Algebra.Expression>(expr, {}, {
    [Algebra.Types.EXPRESSION]: {
      [Algebra.ExpressionTypes.TERM]: { transform: (term) => {
        if (term.term.termType === 'Variable' && subs[term.term.value] !== undefined) {
          return AF.createTermExpression(subs[term.term.value]);
        }
        return term;
      } },
      [Algebra.ExpressionTypes.OPERATOR]: {
        // The argument of a substituted BOUND is dropped entirely, so there is no need to visit it -
        // which also keeps the argument of the copy handed to the transform recognisable.
        preVisitor: operator => isBoundOfSubstituted(operator, subs) ? { ignoreKeys: new Set([ 'args' ]) } : {},
        transform: operator => isBoundOfSubstituted(operator, subs) ? AF.createTermExpression(termTrue) : operator,
      },
      [Algebra.ExpressionTypes.EXISTENCE]: {
        // Don't auto-traverse the input Operation; substituteTerms handles it.
        preVisitor: () => ({ ignoreKeys: new Set([ 'input' ]) }),
        transform: (existence) => {
          existence.input = substituteTerms(c, existence.input, subs);
          return existence;
        },
      },
    },
  });
}

/**
 * Detects `BOUND(?v)` calls on a variable that is being substituted by a term.
 * Since the substitution asserts `?v` is bound, such a call is statically `true`.
 */
function isBoundOfSubstituted(expression: Algebra.OperatorExpression, subs: TermSubstitutions): boolean {
  if (expression.operator.toLowerCase() !== 'bound' || expression.args.length !== 1) {
    return false;
  }
  const [ arg ] = expression.args;
  return arg.subType === Algebra.ExpressionTypes.TERM &&
    arg.term.termType === 'Variable' &&
    subs[arg.term.value] !== undefined;
}

/**
 * Filters a VALUES operation to keep only rows compatible with the given substitutions,
 * removes substituted variables from the column list, and collapses degenerate cases:
 * - zero remaining rows → FILTER(FALSE)
 * - zero remaining columns → empty BGP (identity for JOIN)
 */
function cleanupValues(
  c: TransformContext,
  values: Algebra.Values,
  subs: TermSubstitutions,
): Algebra.Operation {
  const { AF } = c;

  const variablesInReplacement = values.variables.filter(v => subs[v.value] === undefined);
  if (variablesInReplacement.length === values.variables.length) {
    return values;
  }

  // Construct the replacement.
  const origVars = values.variables;
  const replacementBindings: Algebra.Values['bindings'] = [];
  for (const binding of values.bindings) {
    const newBinding: typeof replacementBindings[0] = {};
    let validBinding = true;
    for (const variable of origVars) {
      const replacementTerm = subs[variable.value];
      if (replacementTerm === undefined) {
        newBinding[variable.value] = binding[variable.value];
      } else if (!replacementTerm.equals(binding[variable.value])) {
        validBinding = false;
      }
    }
    if (validBinding) {
      replacementBindings.push(newBinding);
    }
  }

  if (replacementBindings.length === 0) {
    return createFilterFalse(c);
  }

  if (variablesInReplacement.length === 0) {
    return AF.createBgp([]);
  }

  return AF.createValues(variablesInReplacement, replacementBindings);
}
