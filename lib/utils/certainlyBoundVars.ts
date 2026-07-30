import type * as RDF from '@rdfjs/types';
import { algebraUtils, ExpressionTypes, Types } from '@traqula/algebra-transformations-1-2';
import type { Algebra as A, Algebra } from '@traqula/algebra-transformations-1-2';
import type { SSet } from './setUtils.js';
import { unionSets } from './setUtils.js';

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
  const result = asCPVars<T>(op);
  switch (result.type) {
    case Types.BGP: {
      const vars = unionSets(result.patterns.map(pattern => withCpVars(pattern).metadata.cVars));
      result.metadata.pVars = vars;
      result.metadata.cVars = vars;
      return result;
    } case Types.PATTERN: {
      const vars = unionSets([ result.subject, result.predicate, result.object, result.graph ].map(termVars));
      result.metadata.pVars = vars;
      result.metadata.cVars = vars;
      return result;
    } case Types.PATH: {
      const vars = unionSets([ result.subject, result.object ].map(termVars));
      result.metadata.pVars = vars;
      result.metadata.cVars = vars;
      return result;
    } case Types.JOIN: {
      // TODO: continue for the other operators.
      return unionSets(op.input.map(input => certainlyBoundVariables(input, options)));
    }
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

/**
 * Tests whether every element of `subset` is contained in `superset`.
 */
function isSubsetOf(subset: Set<string>, superset: Set<string>): boolean {
  for (const value of subset) {
    if (!superset.has(value)) {
      return false;
    }
  }
  return true;
}

function intersectSets(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) {
    return new Set<string>();
  }
  return sets.reduce((acc, set) => new Set([ ...acc ].filter(value => set.has(value))));
}
