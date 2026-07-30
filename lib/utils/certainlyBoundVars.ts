import type * as RDF from '@rdfjs/types';
import type { Algebra as A, Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils, ExpressionTypes, Types } from '@traqula/algebra-transformations-1-2';
import type { SSet } from './setUtils.js';
import { differenceSets, intersectSets, isSubsetOf, unionSets } from './setUtils.js';

export interface CPMeta {
  cVars: SSet;
  pVars: SSet;
}

export type CPOp<T extends Algebra.Operation = Algebra.Operation> = T & { metadata: CPMeta };

/**
 * Return Algebra Operations but with certain and possible vars assigned.
 * We use Dynamic programming and assert that the metadata is kept up to date when manipulated.
 */
export function withCpVars<T extends Algebra.Operation>(op: T): CPOp<T> {
  function asCPVars<T extends Algebra.Operation>(op: T): CPOp<T> {
    const casted = <CPOp<T>> op;
    if (!Object.hasOwn(op, 'metadata')) {
      casted.metadata = <any> {};
      if (!casted.metadata.cVars) {
        casted.metadata.cVars = new Set<string>();
      }
      if (!casted.metadata.pVars) {
        casted.metadata.pVars = new Set<string>();
      }
    }
    return casted;
  }
  const casted = <T & { metadata?: Partial<CPMeta> }> op;
  if (casted.metadata !== undefined && casted.metadata.cVars !== undefined && casted.metadata.pVars !== undefined) {
    return <CPOp<T>> casted;
  }
  const resOp = asCPVars<T>(op);
  switch (resOp.type) {
    case Types.BGP: {
      const vars = unionSets(resOp.patterns.map(pattern => withCpVars(pattern).metadata.cVars));
      resOp.metadata.pVars = vars;
      resOp.metadata.cVars = vars;
      return resOp;
    } case Types.PATTERN: {
      const vars = unionSets([ resOp.subject, resOp.predicate, resOp.object, resOp.graph ].map(termVars));
      resOp.metadata.pVars = vars;
      resOp.metadata.cVars = vars;
      return resOp;
    } case Types.PATH: {
      const vars = unionSets([ resOp.subject, resOp.object, resOp.graph ].map(termVars));
      resOp.metadata.pVars = vars;
      resOp.metadata.cVars = vars;
      return resOp;
    } case Types.JOIN: {
      const inputs = resOp.input.map(input => withCpVars(input));
      resOp.metadata.pVars = unionSets(inputs.map(input => input.metadata.pVars));
      resOp.metadata.cVars = unionSets(inputs.map(input => input.metadata.cVars));
      return resOp;
    } case Types.UNION: {
      // A variable is only certain when every branch binds it, but any branch may bind it.
      const inputs = resOp.input.map(input => withCpVars(input));
      resOp.metadata.pVars = unionSets(inputs.map(input => input.metadata.pVars));
      resOp.metadata.cVars = intersectSets(inputs.map(input => input.metadata.cVars));
      return resOp;
    } case Types.MINUS: {
      // The right-hand side of a MINUS contributes no binding at all to the result, not even a
      // possible one - its variables are out of scope above it.
      const left = withCpVars(resOp.input[0]);
      resOp.metadata.pVars = new Set(left.metadata.pVars);
      resOp.metadata.cVars = new Set(left.metadata.cVars);
      return resOp;
    } case Types.LEFT_JOIN: {
      // OPTIONAL only certainly binds whatever its left-hand (required) side binds.
      const [ left, right ] = resOp.input.map(input => withCpVars(input));
      resOp.metadata.pVars = unionSets([ left.metadata.pVars, right.metadata.pVars ]);
      resOp.metadata.cVars = new Set(left.metadata.cVars);
      return resOp;
    } case Types.PROJECT: {
      const projected = new Set(resOp.variables.map(variable => variable.value));
      const input = withCpVars(resOp.input);
      resOp.metadata.pVars = intersectSets([ input.metadata.pVars, projected ]);
      resOp.metadata.cVars = intersectSets([ input.metadata.cVars, projected ]);
      return resOp;
    } case Types.GROUP: {
      // Only the grouping keys and the aggregate targets survive the grouping. A key is certain only
      // when the input binds it certainly: grouping on an unbound variable yields a group in which it
      // stays unbound. An aggregate may raise an evaluation error, so its target is never certain.
      const keys = new Set(resOp.variables.map(variable => variable.value));
      const input = withCpVars(resOp.input);
      resOp.metadata.pVars = unionSets([
        intersectSets([ input.metadata.pVars, keys ]),
        new Set(resOp.aggregates.map(aggregate => aggregate.variable.value)),
      ]);
      // COUNT is the one aggregate that cannot fail: it counts the bound, non-error values of its
      // argument, so it yields an integer.
      // All others can end up with an error value leaving their target unbound.
      resOp.metadata.cVars = unionSets([
        intersectSets([ input.metadata.cVars, keys ]),
        new Set(resOp.aggregates
          .filter(aggregate => aggregate.aggregator === 'count')
          .map(aggregate => aggregate.variable.value)),
      ]);
      return resOp;
    } case Types.VALUES: {
      // A VALUES variable is certainly bound only if every row provides a value for it.
      resOp.metadata.pVars = new Set(resOp.variables.map(variable => variable.value));
      resOp.metadata.cVars = new Set(resOp.variables
        .filter(variable => resOp.bindings.every(binding => binding[variable.value] !== undefined))
        .map(variable => variable.value));
      return resOp;
    } case Types.EXTEND: {
      const input = withCpVars(resOp.input);
      const certain = new Set(input.metadata.cVars);
      // Maybe the var we will create is also certain:
      if (resOp.expression.subType === ExpressionTypes.TERM &&
          // A triple-term construction may raise an evaluation error, so it is not certainly bound.
          resOp.expression.term.termType !== 'Quad' &&
          // If it is a var, and that var is certain, we also certain
          isSubsetOf(termVars(resOp.expression.term), certain)) {
        certain.add(resOp.variable.value);
      }
      resOp.metadata.pVars = new Set<string>(input.metadata.pVars);
      resOp.metadata.pVars.add(resOp.variable.value);
      resOp.metadata.cVars = certain;
      return resOp;
    } case Types.FILTER: {
      // The variables of an EXISTS stay inside it, so a filter never adds a possible binding.
      // However: depending on the filter, we can say something on vars being present.
      // Also filters pVars and cVars for `!bound(?x)`
      // TODO: Filter False is a special case. How can we model it?
      const input = withCpVars(resOp.input);
      const unbound = variablesImpliedUnboundBy(resOp.expression);
      resOp.metadata.pVars = differenceSets(input.metadata.pVars, unbound);
      resOp.metadata.cVars = differenceSets(unionSets([
        input.metadata.cVars,
        variablesImpliedBoundBy(resOp.expression),
      ]), unbound);
      return resOp;
    } case Types.GRAPH: {
      // Asserting on the graph variable selects one graph, so it is in scope above the GRAPH.
      const input = withCpVars(resOp.input);
      const graphVars = termVars(resOp.name);
      resOp.metadata.pVars = unionSets([ input.metadata.pVars, graphVars ]);
      resOp.metadata.cVars = unionSets([ input.metadata.cVars, graphVars ]);
      return resOp;
    } case Types.SERVICE: {
      // A SILENT service that fails is replaced by a single empty solution, so no variable is certain.
      const input = withCpVars(resOp.input);
      resOp.metadata.pVars = unionSets([ input.metadata.pVars, termVars(resOp.name) ]);
      resOp.metadata.cVars = resOp.silent ? new Set<string>() : new Set(input.metadata.cVars);
      return resOp;
    }
    case Types.DISTINCT:
    case Types.REDUCED:
    case Types.SLICE:
    case Types.ORDER_BY:
    case Types.FROM: {
      // These only drop or reorder solutions, they never change which variables a solution binds.
      const input = withCpVars((<A.Single> <A.Operation> resOp).input);
      resOp.metadata.pVars = new Set(input.metadata.pVars);
      resOp.metadata.cVars = new Set(input.metadata.cVars);
      return resOp;
    }
    case Types.ASK:
    case Types.INV:
    case Types.NPS:
    case Types.ADD:
    case Types.COMPOSITE_UPDATE:
    case Types.CLEAR:
    case Types.CONSTRUCT:
    case Types.COPY:
    case Types.DELETE_INSERT:
    case Types.CREATE:
    case Types.DESCRIBE:
    case Types.DROP:
    case Types.EXPRESSION:
    case Types.LINK:
    case Types.LOAD:
    case Types.MOVE:
    case Types.ONE_OR_MORE_PATH:
    case Types.ALT:
    case Types.ZERO_OR_MORE_PATH:
    case Types.ZERO_OR_ONE_PATH:
    case Types.NOP:
    case Types.SEQ:
      // Everything without solution mappings of its own.
      resOp.metadata.pVars = new Set<string>();
      resOp.metadata.cVars = new Set<string>();
      return resOp;
  }
}

/**
 * Options controlling how {@link certainlyBoundVariables} decides whether a variable is certainly
 * bound.
 */
export interface BoundVariablesOptions {
  /**
   * When `true`, an EXTEND (BIND) is treated as binding its target variable, but only when the bound
   * expression is a plain term whose own variables are all certainly bound.
   *
   * This is sound: a constant term never raises an evaluation error, and a bare variable reference
   * never raises one either (it simply leaves the target unbound when its source is unbound).
   * Triple-term (quoted-triple) constructions are deliberately excluded: building one can raise an
   * evaluation error (e.g. a literal in the subject or predicate position is not a well-formed RDF
   * triple per SPARQL 1.2), so its target cannot be assumed to be bound. BINDs of arbitrary
   * (possibly erroring) expressions are always ignored.
   *
   * When `false` (the default), EXTEND is ignored entirely - matching the classic `safeVars`
   * definition of Schmidt et al. (https://arxiv.org/pdf/0812.3788, Definition 5), where a BIND may
   * raise an evaluation error and therefore leave its variable unbound.
   *
   * @defaultValue false
   */
  extendBinds?: boolean;
  /**
   * When `true`, a FILTER is treated as making a variable certainly bound whenever its condition can
   * only hold for solutions that bind it: `cVars(σ_R(A)) := cVars(A) ∪ boundImpliedBy(R)`.
   *
   * This strengthens the definition of Schmidt et al., which has `cVars(σ_R(A)) := cVars(A)` - sound,
   * but blind to conditions implying boundness. It is sound because an expression applied to an
   * unbound variable raises an evaluation error, and a FILTER discards the solutions whose condition
   * errors. Only the positions where that reasoning is immediate are used: the argument of `BOUND`
   * (which is *defined* to hold only for bound variables), the plain variable arguments of
   * `sameTerm`, and the conjuncts of a `&&` (all of which must hold).
   *
   * Worth enabling for a filter pushdown: it can license the push of an assertion at an enclosing
   * JOIN, where `?y ∈ cVars(A₁)` only holds once `A₁`'s own `FILTER(sameTerm(?y, c))` is recognised
   * as making `?y` certain.
   *
   * @defaultValue false
   */
  filterImpliesBound?: boolean;
}

/**
 * Computes a sound under-approximation of the variables that are *certainly bound* (a.k.a. "must be
 * bound") after evaluating `op` on any dataset - i.e. the variables guaranteed to have a value in
 * every produced solution.
 *
 * This differs from {@link inScopeVariables}, which computes the (over-approximating) set of
 * *in-scope* variables that *may* be bound. Any variable that cannot be proven to be certainly
 * bound is left out, keeping the result a safe under-approximation. This is the notion required to
 * soundly push a FILTER onto a JOIN operand (SJPush of Schmidt et al.) or to rewrite a single-row
 * VALUES join into an equality FILTER.
 *
 * @param op - The operation whose certainly-bound variables are computed
 * @param options - Options tuning the approximation (see {@link BoundVariablesOptions})
 * @returns The set of certainly-bound variable names
 */
export function certainlyBoundVariables(op: A.Operation, options: BoundVariablesOptions = {}): Set<string> {
  switch (op.type) {
    case Types.BGP:
      return unionSets(op.patterns.map(pattern => patternVars(pattern)));
    case Types.PATTERN:
      return patternVars(op);
    case Types.PATH:
      return unionSets([ termVars(op.subject), termVars(op.object) ]);
    case Types.JOIN:
      return unionSets(op.input.map(input => certainlyBoundVariables(input, options)));
    case Types.UNION:
      return intersectSets(op.input.map(input => certainlyBoundVariables(input, options)));
    case Types.MINUS:
    case Types.LEFT_JOIN:
      // MINUS / OPTIONAL only certainly bind whatever their left-hand (required) side binds.
      return certainlyBoundVariables(op.input[0], options);
    case Types.PROJECT: {
      const projected = new Set(op.variables.map(variable => variable.value));
      return intersectSets([ certainlyBoundVariables(op.input, options), projected ]);
    }
    case Types.GROUP:
      return new Set(op.variables.map(variable => variable.value));
    case Types.VALUES:
      // A VALUES variable is certainly bound only if every row provides a value for it.
      return new Set(op.variables
        .filter(variable => op.bindings.every(binding => binding[variable.value] !== undefined))
        .map(variable => variable.value));
    case Types.EXTEND: {
      const inputBound = certainlyBoundVariables(op.input, options);
      if (options.extendBinds &&
                op.expression.subType === ExpressionTypes.TERM &&
                // A triple-term construction may raise an evaluation error, so it is not certainly bound.
                op.expression.term.termType !== 'Quad' &&
                isSubsetOf(termVars(op.expression.term), inputBound)) {
        inputBound.add(op.variable.value);
      }
      return inputBound;
    }
    case Types.FILTER: {
      const inputBound = certainlyBoundVariables(op.input, options);
      if (options.filterImpliesBound) {
        for (const name of variablesImpliedBoundBy(op.expression)) {
          inputBound.add(name);
        }
      }
      return inputBound;
    }
    case Types.GRAPH:
    case Types.SERVICE:
    case Types.DISTINCT:
    case Types.REDUCED:
    case Types.SLICE:
    case Types.ORDER_BY:
    case Types.FROM:
      return certainlyBoundVariables((<A.Single> op).input, options);
    default:
      return new Set<string>();
  }
}

/**
 * Computes a sound over-approximation of the variables an operation can bind: the `pVars` ("possibly
 * bound", a.k.a. "may be bound") set of Schmidt et al., which for SPARQL coincides with the
 * [in-scope variables](https://www.w3.org/TR/sparql11-query/#variableScope) of the operation.
 *
 * The counterpart of {@link certainlyBoundVariables}: a variable outside this set is bound by no
 * solution at all, which is what licenses replacing `FILTER(sameTerm(?x, c))` over such an operation
 * by the empty result (FBndII), and what licenses pushing a filter into the other operand of a JOIN.
 *
 * The result is an over-approximation on two counts: {@link algebraUtils.inScopeVariables} descends
 * into the pattern of an `EXISTS`, whose variables are not really in scope outside of it, and into the
 * input of a GROUP, which only outputs its keys and aggregates. Over-approximating `pVars` is sound
 * (Proposition 2 of Schmidt et al.) - both uses above become more conservative, never less.
 *
 * @param op - The operation whose possibly-bound variables are computed
 * @returns The set of possibly-bound variable names
 */
export function possiblyBoundVariables(op: A.Operation): Set<string> {
  return new Set(algebraUtils.inScopeVariables(op).map(variable => variable.value));
}

/**
 * Decides whether a single variable is *certainly bound* after evaluating `op`.
 *
 * @param op - The operation to inspect
 * @param variable - The variable (or its name) to test
 * @param options - Options tuning the approximation (see {@link BoundVariablesOptions})
 * @returns `true` when the variable is guaranteed to be bound in every produced solution
 */
export function isVariableCertainlyBound(
  op: A.Operation,
  variable: string | RDF.Variable,
  options: BoundVariablesOptions = {},
): boolean {
  const name = typeof variable === 'string' ? variable : variable.value;
  return certainlyBoundVariables(op, options).has(name);
}

/**
 * Collects the variables a filter condition can only hold for when they are bound.
 *
 * See {@link BoundVariablesOptions.filterImpliesBound} for why these positions - and only these - are
 * safe to conclude boundness from.
 */
function variablesImpliedBoundBy(expression: A.Expression, agg = new Set<string>()): Set<string> {
  if (expression.subType !== ExpressionTypes.OPERATOR) {
    return agg;
  }
  // Every conjunct of a `&&` has to hold, so each of them contributes.
  if (expression.operator === '&&') {
    for (const arg of expression.args) {
      variablesImpliedBoundBy(arg, agg);
    }
    return agg;
  }
  if (expression.operator === 'bound' || expression.operator === 'sameterm') {
    for (const arg of expression.args) {
      if (arg.subType === ExpressionTypes.TERM && arg.term.termType === 'Variable') {
        agg.add(arg.term.value);
      }
    }
  }
  return agg;
}

/**
 * Collects the variables a filter condition can only hold for when they are *unbound*.
 */
function variablesImpliedUnboundBy(expression: A.Expression, agg = new Set<string>()): SSet {
  if (expression.subType !== ExpressionTypes.OPERATOR) {
    return agg;
  }
  if (expression.operator === '&&') {
    for (const arg of expression.args) {
      variablesImpliedUnboundBy(arg, agg);
    }
    return agg;
  }
  if (expression.operator === '!') {
    for (const arg of expression.args) {
      if (arg.subType === ExpressionTypes.OPERATOR && arg.operator === 'bound') {
        for (const nested of arg.args) {
          if (nested.subType === ExpressionTypes.TERM && nested.term.termType === 'Variable') {
            agg.add(nested.term.value);
          }
        }
      }
    }
  }
  return agg;
}

/**
 * Collects the variables appearing in a single triple/quad pattern (including nested quoted triples).
 */
function patternVars(pattern: A.Pattern): Set<string> {
  return unionSets([
    termVars(pattern.subject),
    termVars(pattern.predicate),
    termVars(pattern.object),
    termVars(pattern.graph),
  ]);
}

/**
 * Collects the variables in an RDF term, recursing into quoted triples.
 */
function termVars(term: RDF.Term): Set<string> {
  if (term.termType === 'Variable') {
    return new Set([ term.value ]);
  }
  if (term.termType === 'Quad') {
    return unionSets([ termVars(term.subject), termVars(term.predicate), termVars(term.object) ]);
  }
  return new Set<string>();
}
