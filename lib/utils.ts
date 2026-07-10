import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { Typed } from '@traqula/core';
import { DataFactory } from 'rdf-data-factory';
import { RangeSet } from './RangeSet.js';
import type { TransformContext } from './transformContext.js';

/** Shared DataFactory instance for creating RDF terms */
export const DF = new DataFactory();

/** XSD namespace URI */
export const xsd = 'http://www.w3.org/2001/XMLSchema#';

/** XSD boolean datatype as a NamedNode */
export const datatypeBoolean = DF.namedNode(`${xsd}boolean`);

/** XSD string datatype as a NamedNode */
export const datatypeString = DF.namedNode(`${xsd}string`);

/** The literal `false` with xsd:boolean datatype, used for FILTER(FALSE) patterns */
export const termFalse = DF.literal('false', datatypeBoolean);

/**
 * Checks if an operation is a FILTER(FALSE) pattern.
 * FILTER(FALSE) is used as a sentinel to represent patterns that will never match.
 * @param c - Transform context
 * @param op - The operation to check
 * @returns True if the operation is FILTER(FALSE)
 */
export function isFilterFalse(c: TransformContext, op: Algebra.Operation): boolean {
  return op.type === Algebra.Types.FILTER && op.expression.subType === Algebra.ExpressionTypes.TERM &&
    op.expression.term.equals(termFalse);
}

/**
 * Creates a FILTER(FALSE) operation, used to represent an empty result set.
 * In SPARQL algebra, FILTER(FALSE) is equivalent to the empty multiset
 * and is absorbing for JOIN and identity for UNION.
 * @param c - Transform context
 * @param op - Optional input operation (defaults to empty BGP)
 * @returns A Filter operation with FALSE as the condition
 */
export function createFilterFalse(c: TransformContext, op?: Algebra.Operation): Algebra.Filter {
  return c.AF.createFilter(op ?? c.AF.createBgp([]), c.AF.createTermExpression(termFalse));
}

/**
 * A variable type extended with an optional range constraint.
 * The range specifies which term types are valid for this variable
 * based on its position in a triple pattern (subject, predicate, object).
 */
export type RangedVar = RDF.Variable & { range?: RangeSet };
export function toRangeVar<T extends RDF.Variable>(variable: T): T & { range: RangeSet } {
  const cast = <T & { range: RangeSet }> variable;
  if (cast.range === undefined) {
    cast.range = new RangeSet();
  }
  return cast;
}

/**
 * Renames variables in an operation subtree according to the given map.
 * Handles both variable terms and the string keys used in VALUES bindings.
 *
 * @param c - The transformation context
 * @param obj - The operation to rewrite
 * @param renames - Map from original variable name to its replacement variable
 * @returns The rewritten operation
 */
export function renameVariables<T extends object>(
  c: TransformContext,
  obj: T,
  renames: Record<string, RDF.Variable>,
): T {
  return <T> c.astTransformer.transformObject(obj, (object) => {
    if (isRdfVar(object) && object.value in renames) {
      return renames[object.value];
    }
    if ('type' in object && object.type === 'values' && 'bindings' in object) {
      const valuesOp = <Algebra.Values> object;
      valuesOp.bindings = valuesOp.bindings.map(binding => Object.fromEntries(
        Object.entries(binding).map(([ key, value ]) => [ key in renames ? renames[key].value : key, value ]),
      ));
    }
    return object;
  });
}

/**
 * Creates a generator of fresh (non-colliding) RDF variables.
 *
 * The generator coins variable names using an internal, monotonically increasing
 * index (e.g. `?v_0`, `?v_1`, ...). If a candidate name already exists in the set
 * of known variables, the index is advanced until an unused name is found.
 * Every coined name is remembered internally, so repeated calls never collide with
 * each other nor with any variable that was present in the original operation tree.
 *
 * @param existing - Variable names that already exist within the operation tree
 * @param prefix - Prefix used for the coined variable names (defaults to `v`)
 * @returns A function that returns a new, unused variable on each call
 * @example
 * const fresh = freshVarGenerator([ 'x', 'v_0' ]);
 * fresh(); // ?v_1  (v_0 was taken)
 * fresh(); // ?v_2
 */
export function freshVarGenerator(existing: Iterable<string>, prefix = 'v_'): () => RDF.Variable {
  const taken = new Set(existing);
  let index = 0;
  return (): RDF.Variable => {
    let name = `${prefix}${index}`;
    while (taken.has(name)) {
      index += 1;
      name = `${prefix}_${index}`;
    }
    taken.add(name);
    index += 1;
    return DF.variable(name);
  };
}

/**
 * Collects the names of every variable that occurs anywhere in an operation subtree.
 * This includes variable terms (subjects, predicates, objects, expression operands,
 * projected/extended variables, ...) as well as the string keys used in VALUES bindings.
 */
export function collectVariableNames(astTransformer: TransformContext['astTransformer'], obj: object): Set<string> {
  const names = new Set<string>();
  astTransformer.visitObject(obj, (object) => {
    if (isRdfTerm(object) && object.termType === 'Variable') {
      names.add(object.value);
    }
    // VALUES bindings reference their variables through string keys.
    if ('type' in object && object.type === 'values' && 'bindings' in object) {
      for (const binding of (<Algebra.Values> object).bindings) {
        for (const key of Object.keys(binding)) {
          names.add(key);
        }
      }
    }
  });
  return names;
}

/**
 * Type guard to check if an object is an RDF term.
 * @param obj - Object to check
 * @returns True if the object has a termType property
 */
export function isRdfTerm(obj: object): obj is RDF.Term {
  return 'termType' in obj && typeof obj.termType === 'string';
}

/**
 * Type guard to check if an object is an RDF Quad (triple term).
 * @param obj - Object to check
 * @returns True if the object is a Quad term
 */
export function isRdfQuad(obj: object): obj is RDF.Quad {
  return isRdfTerm(obj) && obj.termType === 'Quad';
}

/**
 * Type guard to check if an object is an RDF Variable (potentially with range).
 * @param obj - Object to check
 * @returns True if the object is a Variable term
 */
export function isRdfVar(obj: object): obj is RangedVar {
  return isRdfTerm(obj) && obj.termType === 'Variable';
}

/**
 * Type guard to check if an object is the default graph.
 * @param obj - Object to check
 * @returns True if the object is the DefaultGraph
 */
export function isRdfDefaultGraph(obj: object): obj is RDF.DefaultGraph {
  return isRdfTerm(obj) && obj.termType === 'DefaultGraph';
}

/**
 * Type guard to check if an object is a Typed structure.
 * @param obj - Object to check
 * @returns True if the object has type (and optionally subType) string properties
 */
export function isTyped(obj: object): obj is Typed {
  return 'type' in obj && typeof obj.type === 'string' && (
    !('subType' in obj) || typeof obj.subType === 'string'
  );
}

/**
 * Checks if a term is fully static (contains no variables).
 * For Quads, recursively checks all components.
 * @param term - The term to check
 * @returns True if the term contains no variables
 */
export function termIsStaticTerm(term: RDF.Term): boolean {
  if (term.termType === 'Quad') {
    return termIsStaticTerm(term.subject) && termIsStaticTerm(term.predicate) && termIsStaticTerm(term.object);
  }
  return term.termType !== 'Variable';
}

/**
 * Extracts direct variable assignments from EXTEND operations.
 * Only collects assignments where the expression is a simple term (Literal or NamedNode).
 * @param c - Transform context
 * @param op - The operation to search
 * @returns A record mapping variable names to their assigned terms
 */
export function directExtensions(c: TransformContext, op: Algebra.Operation): Record<string, RDF.Term> {
  const assignments: Record<string, RDF.Term> = {};

  const findAssignments = (op: Algebra.Operation): void => {
    if (op.type === 'extend') {
      if (op.expression.subType === Algebra.ExpressionTypes.TERM && (
        op.expression.term.termType === 'Literal' || op.expression.term.termType === 'NamedNode')) {
        assignments[op.variable.value] = (op.expression).term;
      }
      findAssignments(op.input);
    }
  };

  findAssignments(op);
  return assignments;
}

/**
 * Removes EXTEND operations for specified variables from an operation tree.
 * Modifies the tree in place.
 * @param c - Transform context
 * @param op - The operation to modify
 * @param vars - Variable names whose extensions should be removed
 * @returns The modified operation
 */
export function deleteVarExtensionsInPlace(
  c: TransformContext,
  op: Algebra.Operation,
  vars: string[],
): Algebra.Operation {
  if (vars.length === 0) {
    return op;
  }
  const pruneExtensions = (op: Algebra.Operation): Algebra.Operation => {
    if (op.type === 'extend') {
      if (vars.includes(op.variable.value)) {
        return pruneExtensions(op.input);
      }
      op.input = pruneExtensions(op.input);
      return op;
    }
    return op;
  };
  return pruneExtensions(op);
}

/**
 * Optimizes a template array by concatenating adjacent string values.
 * This reduces the number of CONCAT operations needed when generating SPARQL.
 * @param arr - Array of template components (strings and variables)
 * @returns Optimized array with adjacent strings merged
 * @example
 * optimizeTemplateArray(['http://', 'example.org/', varX])
 * // Returns: ['http://example.org/', varX]
 */
export function optimizeTemplateArray<T>(arr: T[]): (T | string)[] {
  const optimizedTemplate: (T | string)[] = [];
  for (const val of arr) {
    if (typeof val === 'string' && typeof optimizedTemplate.at(-1) === 'string') {
      const prev = <string> optimizedTemplate.pop();
      optimizedTemplate.push(prev + val);
    } else {
      optimizedTemplate.push(val);
    }
  }
  return optimizedTemplate;
}
