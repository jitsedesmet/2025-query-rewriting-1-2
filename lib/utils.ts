import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { Typed } from '@traqula/core';
import { DataFactory } from 'rdf-data-factory';
import type { RangedVar } from './RangeSet.js';
import type { TransformContext } from './transformContext.js';
import type { MappingHead } from './types.js';

export const DF = new DataFactory();

export const xsd = 'http://www.w3.org/2001/XMLSchema#';
export const datatypeBoolean = DF.namedNode(`${xsd}boolean`);
export const termFalse = DF.literal('false', datatypeBoolean);

export function isFilterFalse(c: TransformContext, op: Algebra.Operation): boolean {
  return op.type === Algebra.Types.FILTER && op.expression.subType === Algebra.ExpressionTypes.TERM &&
    op.expression.term.equals(termFalse);
}

export function createFilterFalse(c: TransformContext, op?: Algebra.Operation): Algebra.Filter {
  return c.AF.createFilter(op ?? c.AF.createBgp([]), c.AF.createTermExpression(termFalse));
}

export function isRdfTerm(obj: object): obj is RDF.Term {
  return 'termType' in obj && typeof obj.termType === 'string';
}

export function isRdfQuad(obj: object): obj is RDF.Quad {
  return isRdfTerm(obj) && obj.termType === 'Quad';
}

export function isRdfVar(obj: object): obj is RangedVar {
  return isRdfTerm(obj) && obj.termType === 'Variable';
}

export function isRdfDefaultGraph(obj: object): obj is RDF.DefaultGraph {
  return isRdfTerm(obj) && obj.termType === 'DefaultGraph';
}

export function isTyped(obj: object): obj is Typed {
  return 'type' in obj && typeof obj.type === 'string' && (
    !('subType' in obj) || typeof obj.subType === 'string'
  );
}

export function isMappingHead(obj: object): obj is MappingHead {
  return isTyped(obj) && obj.type === 'mappingHead';
}

export function termIsStaticTerm(term: RDF.Term): boolean {
  if (term.termType === 'Quad') {
    return termIsStaticTerm(term.subject) && termIsStaticTerm(term.predicate) && termIsStaticTerm(term.object);
  }
  return term.termType !== 'Variable';
}

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
