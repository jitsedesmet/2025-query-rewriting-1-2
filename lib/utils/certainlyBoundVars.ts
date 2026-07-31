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

/** Drops the `metadata` of the operation it is applied to, whatever that metadata holds. */
const dropMetadata = { transform: (copy: { metadata?: unknown }): unknown => {
  delete copy.metadata;
  return copy;
} };

/** Drops the metadata of every operation, no matter its type. */
const dropAllMetadata = Object.fromEntries(Object.values(Types).map(type => [ type, dropMetadata ]));

/**
 * Returns a copy of `op` without any cached metadata, the state {@link withCpVars} recomputes from.
 *
 * Two reasons to start a pass with this. Metadata is a cache of what the *current* shape of the plan
 * implies, so metadata another pass left behind may describe an operation that has since been rewritten.
 * And the sets it holds do not survive a generic traversal: a `Set` shallow copied by
 * {@link algebraUtils.mapOperation} keeps its prototype but loses its contents, so any traversal that
 * does not know to leave `metadata` alone silently breaks it. Dropping it first means neither can bite.
 *
 * Since every operation is copied, this also leaves the tree it is given untouched.
 *
 * @param op - The operation to copy
 * @returns The copy, with no operation in it carrying metadata
 */
export function withoutCpVars<T extends Algebra.Operation>(op: T): T {
  return algebraUtils.mapOperation<'unsafe', T>(op, dropAllMetadata);
}

/**
 * Return Algebra Operations but with certain and possible vars assigned.
 * We use Dynamic programming and assert that the metadata is kept up to date when manipulated.
 *
 * We do not explicitly handle filter false here since it can be rewritten/ removed cheaply already by
 * {@link transformFilterFalse}.
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
      // Keep in mind: Filter False is a special case.
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
 * Collects the variables in an RDF term, recursing into quoted triples.
 */
export function termVars(term: RDF.Term): Set<string> {
  if (term.termType === 'Variable') {
    return new Set([ term.value ]);
  }
  if (term.termType === 'Quad') {
    return unionSets([ termVars(term.subject), termVars(term.predicate), termVars(term.object) ]);
  }
  return new Set<string>();
}
